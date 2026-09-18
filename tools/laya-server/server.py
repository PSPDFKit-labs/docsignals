# /// script
# requires-python = ">=3.10"
# dependencies = ["laya==0.1.6"]
# ///
"""A local stand-in for the Jev API, backed by the open Laya model.

Serves `POST /v1/systemone` in the shape `@typesafe-ai/sdk` expects, so docsignals runs
against it with `TYPESAFE_BASE_URL=http://127.0.0.1:8484 TYPESAFE_API_KEY=local`.

Laya was trained at 512 tokens per question and its encoder accepts 8192, where Jev reads
32k. The server asks at `--max-len` tokens, 8192 unless told otherwise. It strips number-only
fields from the state, and a state that still does not fit is split into windows, each
question asked of every window, and the window answers combined. The numbers are NOT
calibrated the way a Jev call is.
"""
import argparse
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

import numpy as np
import torch
from laya import load
from laya.common import QTYPES, build_sequence, collate_items, confidence_from_probs, render_options, temp_bucket

BATCH = 16


def is_numeric(value):
    if isinstance(value, bool):
        return False
    if isinstance(value, (int, float)):
        return True
    if isinstance(value, dict):
        return len(value) > 0 and all(is_numeric(v) for v in value.values())
    return False


def compact(value):
    """Drops number-only fields (bounds, page size, confidences): they spend the token budget and carry no meaning for Laya."""
    if isinstance(value, dict):
        return {k: compact(v) for k, v in value.items() if not is_numeric(v) and v is not None}
    if isinstance(value, list):
        return [compact(v) for v in value]
    return value


def internal(qdef):
    kind = qdef["type"]
    if kind not in QTYPES:
        raise ValueError(f"unknown question type {kind!r}")
    instructions = qdef.get("instructions")
    if instructions is None:
        instructions = ""
    elif not isinstance(instructions, str):
        instructions = json.dumps(instructions)
    criteria = qdef.get("criteria")
    if kind == "choice" and isinstance(criteria, list):
        criteria = {c: None for c in criteria}
    return {"t": kind, "ins": instructions, "crit": criteria}


class Windows:
    def __init__(self, agent):
        self.agent = agent
        self.max_len = agent.cfg.get("max_len", 512)
        self.head_max_len = agent.cfg.get("head_max_len", 192)

    def count(self, text):
        return len(self.agent.tok(text, add_special_tokens=False)["input_ids"])

    def room(self, q):
        ids, _ = build_sequence(self.agent.tok, "", q, self.max_len, self.head_max_len)
        return self.max_len - len(ids)

    def split_text(self, text, room):
        tok = self.agent.tok
        ids = tok(text, add_special_tokens=False)["input_ids"]
        return [tok.decode(ids[i : i + room]) for i in range(0, len(ids), room)] or [""]

    def split(self, state, room):
        """Consecutive windows of the state, each within `room` tokens. A list splits between items."""
        if not isinstance(state, list):
            text = state if isinstance(state, str) else json.dumps(state, ensure_ascii=False)
            return self.split_text(text, room)
        windows, current, used = [], [], 2
        for item in state:
            text = json.dumps(item, ensure_ascii=False)
            size = self.count(text) + 1
            if size + 2 > room:
                if current:
                    windows.append(json.dumps(current, ensure_ascii=False))
                    current, used = [], 2
                windows.extend(self.split_text(text, room))
                continue
            if used + size > room and current:
                windows.append(json.dumps(current, ensure_ascii=False))
                current, used = [], 2
            current.append(item)
            used += size
        if current:
            windows.append(json.dumps(current, ensure_ascii=False))
        return windows or [""]


def combine(q, window_probs, windows, element_ids):
    """One distribution from the per-window distributions of one question."""
    probs = np.stack(window_probs)
    if q["t"] == "noul":
        return probs[int(probs[:, 1].argmax())]
    if q["t"] == "score":
        k = probs.shape[1]
        return probs[int(np.argmax([confidence_from_probs(p, k) for p in probs]))]
    labels = list(q["crit"].keys())
    if any(label in element_ids for label in labels):
        # A label that names a state element is judged by the window that holds the element;
        # any other label ("none") holds only if every window agrees.
        combined = np.empty(len(labels))
        for i, label in enumerate(labels):
            holders = [w for w, text in enumerate(windows) if json.dumps(label) in text]
            combined[i] = probs[holders, i].max() if label in element_ids and holders else probs[:, i].min()
    else:
        combined = probs.max(axis=0)
    return combined / combined.sum()


@torch.no_grad()
def system_one(agent, state, questions):
    helper = Windows(agent)
    state = compact(state)
    element_ids = (
        {el["id"] for el in state if isinstance(el, dict) and isinstance(el.get("id"), str)}
        if isinstance(state, list)
        else set()
    )

    items, owners, parsed, split = [], [], {}, {}
    for qid, qdef in questions.items():
        q = parsed[qid] = internal(qdef)
        windows = split[qid] = helper.split(state, helper.room(q))
        for window in windows:
            seq, markers = build_sequence(agent.tok, window, q, helper.max_len, helper.head_max_len)
            if len(markers) != len(render_options(q)):
                raise ValueError(f"question {qid!r} has more options than fit in head_max_len={helper.head_max_len}")
            items.append({"ids": seq, "markers": markers, "qtype": QTYPES[q["t"]]})
            owners.append(qid)

    rows = []
    for start in range(0, len(items), BATCH):
        b = collate_items([items[start : start + BATCH]], agent.tok.pad_token_id)
        logits, _ = agent.model(
            b["input_ids"].to(agent.device),
            b["attention_mask"].to(agent.device),
            b["marker_pos"].to(agent.device),
            b["marker_mask"].to(agent.device),
            b["qtype"].to(agent.device),
        )
        rows.extend(logits.float().cpu().numpy())

    per_question = {qid: [] for qid in questions}
    for item, qid, row in zip(items, owners, rows):
        k = len(item["markers"])
        qt = item["qtype"]
        scale = agent.temperature_by_options.get(temp_bucket(qt, k), agent.temperature[qt])
        z = row[:k] / max(1e-3, float(scale))
        p = np.exp(z - z.max())
        per_question[qid].append(p / p.sum())

    answers = {}
    for qid, q in parsed.items():
        p = combine(q, per_question[qid], split[qid], element_ids)
        k = len(p)
        confidence = confidence_from_probs(p, k)
        if q["t"] == "choice":
            labels = list(q["crit"].keys())
            answers[qid] = {
                "type": "choice",
                "choice": labels[int(p.argmax())],
                "probabilities": {label: float(v) for label, v in zip(labels, p)},
                "confidence": confidence,
            }
        elif q["t"] == "score":
            answers[qid] = {
                "type": "score",
                "score": float((np.arange(k) * p).sum()),
                "legend": {str(i): c for i, c in enumerate(q["crit"])},
                "probabilities": {str(i): float(v) for i, v in enumerate(p)},
                "confidence": confidence,
            }
        else:
            answers[qid] = {"type": "noul", "noul": float(p[1]), "confidence": float(max(p[1], 1 - p[1]))}

    tokens = sum(len(item["ids"]) for item in items)
    print(f"systemone: {len(questions)} questions, {len(items)} windows, {tokens} tokens", file=sys.stderr)
    return {"model": "laya", "answers": answers, "usage": {"input_tokens": tokens, "output_tokens": 0}}


def handler(agent):
    class Handler(BaseHTTPRequestHandler):
        def reply(self, status, body):
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            if self.path.rstrip("/") != "/v1/systemone":
                return self.reply(404, {"error": {"message": "only POST /v1/systemone is served"}})
            try:
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                result = system_one(agent, body["state"], body["questions"])
            except (KeyError, ValueError) as error:
                return self.reply(400, {"error": {"message": str(error)}})
            self.reply(200, result)

        def log_message(self, *args):
            pass

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--port", type=int, default=8484)
    parser.add_argument("--model", default="convaiinnovations/laya")
    parser.add_argument("--device", default=None, help="cuda, mps or cpu; default picks the best available")
    parser.add_argument(
        "--max-len",
        type=int,
        default=8192,
        help="tokens per question. 8192 is the most the encoder accepts and fits a whole page; Laya was trained at 512",
    )
    args = parser.parse_args()

    agent = load(args.model, device=args.device)
    agent.cfg["max_len"] = args.max_len
    print(f"laya on {agent.device}, max_len {agent.cfg.get('max_len', 512)}, listening on http://127.0.0.1:{args.port}", file=sys.stderr)
    HTTPServer(("127.0.0.1", args.port), handler(agent)).serve_forever()


if __name__ == "__main__":
    main()
