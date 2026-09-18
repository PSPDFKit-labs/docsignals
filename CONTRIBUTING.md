# Contributing

## Set up

You need Node.js 20 or later.

```bash
npm install
```

```bash
npm run check
```

`check` runs the typecheck, the linter, and the tests. All three must pass before a change merges.
The tests run offline: they use the recorded extractions in `examples/cache` and the fake Jev
transport, so you need no API keys.

| Command | What it does |
|---|---|
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | Biome lint and format check |
| `npm run format` | Applies Biome's fixes |
| `npm test` | Vitest |
| `npm run build` | Emits `dist/` |
| `npm run docsignals -- <args>` | Runs the CLI from source |

## Run against a local model, without a Jev key

`tools/laya-server` serves the Jev endpoint from [Laya](https://huggingface.co/convaiinnovations/laya),
an open 421M-parameter model that takes the same typed questions. It needs [uv](https://docs.astral.sh/uv/)
and downloads about 800 MB of weights on first start.

```bash
uv run tools/laya-server/server.py
```

```bash
TYPESAFE_BASE_URL=http://127.0.0.1:8484 TYPESAFE_API_KEY=local npm run docsignals -- run examples/packs/contracts.yaml examples/documents/contracts/*.pdf --cache-dir examples/cache
```

docsignals itself is unchanged: `@typesafe-ai/sdk` reads `TYPESAFE_BASE_URL`. The server drops
number-only fields from the elements and asks each question of the whole page, up to 8192 tokens,
the most Laya's encoder accepts. Laya was trained at 512 tokens; `--max-len 512` keeps to that, and
the server then asks each question of each window of the page and combines the windows. Either way
this exercises the whole pipeline with a real model, but the numbers are not Jev's and are not
calibrated.

The server answers one request at a time, and a dense page can take longer than the SDK's default
timeout of 10 seconds. For a document larger than the examples, add `--concurrency 1 --timeout 300000`.
A request that times out is not cancelled on the server: it runs to the end before the next one starts.

## How the code is laid out

| File | Responsibility |
|---|---|
| `src/pack.ts` | Pack schema, loading, and `use` resolution |
| `src/extract.ts` | DWS extraction and the on-disk cache |
| `src/pages.ts` | DWS spatial elements to pages and key-value pairs |
| `src/jev.ts` | Pack questions to Jev requests, through `@typesafe-ai/sdk` |
| `src/fake-jev.ts` | The offline transport behind `--fake` |
| `src/reduce.ts` | Page answers to a document answer |
| `src/run.ts` | The pipeline: extract, ask, reduce |
| `src/format.ts` | Table, JSON, and CSV output |
| `src/cli.ts` | The command line |

## Conventions

- **Fail loudly.** A missing key, an unknown pack field, or an unexpected payload is an error with
  a message that says what to do. Don't add a silent default.
- **Validate at the boundary.** Pack files and DWS payloads are parsed with zod. Code past the
  boundary trusts its types.
- **Keep it small.** A new dependency or abstraction needs a reason that a reader can see.
- **Test behaviour.** A new reducer, question field, or output format comes with a test that would
  fail without it.

## Changing a standard-library question

The wording of a question in `packs/std.yaml` is its behaviour. Any change to a question's
wording, labels, or levels needs a version bump in that file, and a line in the pull request
saying why the old wording fell short.

## Measuring against real documents

[`eval/`](eval/README.md) holds public documents with recorded ground truth, and a scorer that
compares a run with it. It calls the live APIs, so it is not part of `npm run check`. A new
document needs a licence that permits redistribution and an entry in `eval/ATTRIBUTION.md`.

## Adding an example

Add the HTML source under `examples/sources/<group>/`, then follow
[Regenerate the documents](examples/README.md#regenerate-the-documents). Commit the source, the
PDF, and the recorded extraction together. Use invented names for every company and person.
