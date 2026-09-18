# Eval: public document sets

Small calibration sets of real, public documents with known-correct answers, for measuring
Jev's calibration on typed questions (see the README's [Status](../README.md#status) and the
"Calibration measurements on public document sets" idea under
[Contributing](../CONTRIBUTING.md)).

Unlike `examples/`, which ships fictional documents for the offline `--fake` demo, these sets use
real documents. See [ATTRIBUTION.md](ATTRIBUTION.md) for each document's source and license.

## What's here

| Category | Pack | Documents | Ground truth |
|---|---|---|---|
| Government forms | [`packs/government-forms.yaml`](packs/government-forms.yaml) | [`documents/government-forms/`](documents/government-forms) — 3 public-domain VA/IRS forms | [`ground-truth/government-forms.json`](ground-truth/government-forms.json) |
| arXiv papers | [`packs/arxiv-papers.yaml`](packs/arxiv-papers.yaml) | [`documents/arxiv-papers/`](documents/arxiv-papers) — 4 research papers from arXiv, CC BY 3.0 or public domain | [`ground-truth/arxiv-papers.json`](ground-truth/arxiv-papers.json) |

[`packs/all.yaml`](packs/all.yaml) routes every document in `documents/` to whichever of the two
packs above matches its `doc_type`; it demonstrates `route` over the eval set, but isn't itself
scored (see [Scoring it](#scoring-it)).

Each ground-truth file gives the expected answer for every (document, question) pair, with the
evidence for it, under `answers`; a pack's `extract` fields are covered separately, under
`extracted`.

Between the two packs, every pack feature docsignals supports is exercised at least once:

| Feature | Where |
|---|---|
| `noul` | Both packs |
| `noul` with `yes`/`no` criteria | `government-forms.yaml#asks_about_medicaid`, and the three `arxiv-papers.yaml` noul questions |
| `choice`, with `fallback` | `government-forms.yaml#issuing_agency` |
| `score` | `arxiv-papers.yaml#text_quality`. It runs, but it is not scored: no level is defensible as ground truth for these pages |
| `extract`, with `verify` | `government-forms.yaml#respondent_burden` — including the documented "value not found" case, on the one document that doesn't carry the label |
| `use` (the standard library) | `doc_type` in both packs, `text_quality` in `arxiv-papers.yaml` |
| `route` | `all.yaml` |

## Run it

Extraction always calls the live DWS API — `--fake` only replaces Jev, not extraction — so this
needs a `NUTRIENT_EXTRACTION_API_KEY` regardless, and a `TYPESAFE_API_KEY` unless you pass
`--fake`. There is no recorded cache here, unlike `examples/`.

```bash
npm run docsignals -- run eval/packs/government-forms.yaml eval/documents/government-forms/*.pdf --format json
npm run docsignals -- run eval/packs/arxiv-papers.yaml eval/documents/arxiv-papers/*.pdf --format json
npm run docsignals -- run eval/packs/all.yaml eval/documents/government-forms/*.pdf eval/documents/arxiv-papers/*.pdf --format json
```

## Scoring it

```bash
npx tsx eval/score.ts               # both categories
npx tsx eval/score.ts government-forms
npx tsx eval/score.ts --fake        # fake Jev; DWS extraction still runs for real
```

Runs each category's pack over its documents, compares every answer and extracted field to its
`ground-truth/*.json` entry, and prints a PASS/FAIL line per (document, question) with the
probability or value docsignals returned, plus a running score. A `noul` question is marked
correct when its probability and the expected true/false land on the same side of 0.5; a `choice`
or `extract` question, on an exact match; a `score` question, when it rounds to the expected
level. Exits non-zero if anything failed, so it can gate CI once real API keys are available there.

`eval/score.test.ts` covers the comparison logic itself (`scoreRow`) against hand-built answers,
offline — useful for checking the scorer's own correctness without needing API keys.

## No checkbox questions

DWS returns the "YES" and "NO" labels of a checkbox as plain paragraphs, and does not report
which box is ticked. A question about a ticked box can't be answered from the page state, so every
government-forms question is about the printed text of the form.

## Page size

Jev refuses a page whose elements are over its 32k-token state limit, and docsignals stops the
run. Check a new document with `docsignals pages` before you add it: every page must be under
50,000 characters of element JSON. A dense form page can be over that.

## Extending this set

A new category needs: a pack under `packs/`, its documents under `documents/<category>/`, an
entry in `ATTRIBUTION.md` naming each document's source and confirming it may be redistributed,
a `ground-truth/<category>.json` with the expected answer for every question (and `extract`
field) in the pack, on every document, and an entry added to the `categories` array in
`score.ts`.
