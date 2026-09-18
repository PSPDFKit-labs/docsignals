# Examples

Everything here runs offline. The documents' extractions are recorded in [`cache/`](cache), and
`--fake` stands in for Jev, so no command on this page needs an API key.

The fake matches keywords. Its numbers show you the shape of the output, and they are **not
calibrated probabilities**.

## What's here

| Path | What it is |
|---|---|
| [`packs/contracts.yaml`](packs/contracts.yaml) | Reviews agreements: signed, governing law, termination, liability, risk |
| [`packs/invoices.yaml`](packs/invoices.yaml) | Accounts-payable intake: extracts and verifies invoice fields |
| [`packs/intake.yaml`](packs/intake.yaml) | Sorts a mixed folder by document type and routes each type to its own pack |
| [`documents/contracts/`](documents/contracts) | Three fictional agreements, two or three pages each |
| [`documents/invoices/`](documents/invoices) | Two fictional invoices, one of them past due |
| [`cache/`](cache) | The recorded DWS extraction of each document |
| [`library.ts`](library.ts) | docsignals used as a library |
| [`sources/`](sources) | The HTML the PDFs were generated from |

Every company and person in the documents is invented.

## Review a folder of contracts

```bash
npm run docsignals -- run examples/packs/contracts.yaml examples/documents/contracts/*.pdf --fake --cache-dir examples/cache
```

```text
doc                          doc_type             is_signed   governing_law          termination_for_convenience  liability_capped  customer_risk
---------------------------  -------------------  ----------  ---------------------  ---------------------------  ----------------  -------------
consulting-pellucid.pdf      contract 0.38 (p.1)  0.97 (p.3)  california 0.44 (p.3)  0.32 (p.2)                   0.13 (p.2)        1.00 (p.1)
msa-northwind-halden.pdf     contract 0.52 (p.3)  0.97 (p.3)  new_york 0.40 (p.3)    0.77 (p.2)                   0.32 (p.2)        1.43 (p.2)
nda-brightwater-corvane.pdf  contract 0.52 (p.1)  0.45 (p.1)  delaware 0.47 (p.2)    0.13 (p.2)                   0.04 (p.1)        1.14 (p.2)
```

Things to notice:

- Each governing law is right, and `(p.3)` or `(p.2)` is the page with the clause. The other pages
  answered `other`, and the `top_page` reducer set them aside. See [Reducers](../docs/reducers.md).
- The NDA is the unsigned one, and it has the lowest `is_signed`.
- The master services agreement is the only one with termination for convenience, and it scores
  highest for it, on page 2 where the clause is.
- `liability_capped` and `customer_risk` are where keyword matching runs out. The consulting
  agreement has unlimited liability and should score the highest risk. The fake can't tell
  "is limited" from "is not limited". That judgement is what Jev is for.

## See the page answers

```bash
npm run docsignals -- run examples/packs/contracts.yaml examples/documents/contracts/nda-brightwater-corvane.pdf --fake --cache-dir examples/cache --by page
```

One row per page shows you what the reducer had to work with.

## Extract and verify invoice fields

```bash
npm run docsignals -- run examples/packs/invoices.yaml examples/documents/invoices/*.pdf --fake --cache-dir examples/cache
```

```text
doc               doc_type            is_overdue  invoice_number   due_date                  total_due
----------------  ------------------  ----------  ---------------  ------------------------  --------------------
invoice-1042.pdf  invoice 0.74 (p.1)  0.11 (p.1)  INV-1042 [0.97]  May 1, 2026 [0.97]        USD 13,760.00 [0.97]
invoice-1043.pdf  invoice 0.78 (p.1)  0.63 (p.1)  INV-1043 [0.97]  February 27, 2026 [0.97]  USD 19,529.11 [0.97]
```

The bracketed number is the probability that the page supports the value. Invoice 1043 is the
past-due one.

Both example packs use the default `agentic` mode. [Choosing an extraction mode](../docs/choosing-a-mode.md)
shows what the cheaper `structure` mode does to invoice 1043, and why.

## Route a mixed folder

```bash
npm run docsignals -- run examples/packs/intake.yaml examples/documents/*/*.pdf --fake --cache-dir examples/cache
```

`intake.yaml` asks `std#doc_type`, then sends invoices to `invoices.yaml` and contracts to
`contracts.yaml`. The output has one row per document and 14 columns. Four of them:

```text
doc                          route      doc_type             contracts.governing_law  invoices.total_due
---------------------------  ---------  -------------------  -----------------------  --------------------
consulting-pellucid.pdf      contracts  contract 0.38 (p.1)  california 0.44 (p.3)    -
msa-northwind-halden.pdf     contracts  contract 0.52 (p.3)  new_york 0.40 (p.3)      -
nda-brightwater-corvane.pdf  contracts  contract 0.52 (p.1)  delaware 0.47 (p.2)      -
invoice-1042.pdf             invoices   invoice 0.74 (p.1)   -                        USD 13,760.00 [0.97]
invoice-1043.pdf             invoices   invoice 0.78 (p.1)   -                        USD 19,529.11 [0.97]
```

A routed column carries its pack's name, and a column that doesn't apply shows `-`. To see the
route before you run it:

```bash
npm run docsignals -- validate examples/packs/intake.yaml
```

See [Routing](../docs/packs.md#routing).

## Get JSON or CSV

```bash
npm run docsignals -- run examples/packs/invoices.yaml examples/documents/invoices/*.pdf --fake --cache-dir examples/cache --format json
```

JSON carries everything: every label's probability for a choice, and the source and page of every
extracted field.

## See what a question sees

```bash
npm run docsignals -- pages examples/documents/invoices/invoice-1043.pdf --cache-dir examples/cache
```

## Use docsignals as a library

```bash
npx tsx examples/library.ts
```

## Regenerate the documents

You only need this after you edit a file in `sources/`. It calls the DWS Processor API, so it
needs `NUTRIENT_EXTRACTION_API_KEY` set to a Processor key:

```bash
npx tsx examples/scripts/make-documents.ts
```

A regenerated PDF has a new content hash, so its recorded extraction no longer matches. Delete the
stale files in `cache/`, then run the packs once with `NUTRIENT_EXTRACTION_API_KEY` set to a Data Extraction
key and `--cache-dir examples/cache` to record new ones.
