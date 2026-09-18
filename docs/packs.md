# Writing packs

A pack is a YAML file that lists the questions to ask of a document and the fields to pull out
of it. This page describes every field a pack accepts.

To check a pack without running it:

```bash
npm run docsignals -- validate my-pack.yaml
```

## A complete pack

```yaml
name: contracts            # required
version: 1.0.0             # required, semver
description: First-pass review of commercial agreements.
mode: agentic              # DWS extraction mode. Default: agentic

questions:
  is_signed:
    noul: The parties have signed this agreement.

  governing_law:
    ask: Which jurisdiction's law governs this agreement?
    choice:
      new_york: Governed by the laws of the State of New York
      delaware: Governed by the laws of the State of Delaware
      other: Another jurisdiction, or this page does not state a governing law
    fallback: other

  customer_risk:
    ask: How much commercial risk do the terms on this page place on the paying customer?
    score:
      - Low. Balanced, standard terms with capped liability and an easy exit
      - Medium. Some one-sided terms, such as automatic renewal
      - High. Unlimited liability or payment owed after the customer exits

  doc_type:
    use: std#doc_type

extract:
  effective_date:
    keys: [Effective Date, Dated]
    verify: true
```

A pack needs at least one entry under `questions`, `extract`, or `route`. Unknown keys are an error, so a
typo such as `reducer:` fails validation instead of being ignored.

## Pack fields

| Field | Required | Meaning |
|---|---|---|
| `name` | Yes | The pack's name. Appears in results as `name@version` |
| `version` | Yes | Semver. Bump it when you change a question's wording. See [Versions](#versions) |
| `description` | No | One line about what the pack is for |
| `mode` | No | `agentic` (default), `understand`, or `structure`. See [Choosing an extraction mode](choosing-a-mode.md) |
| `questions` | No | Questions for Jev, by name |
| `extract` | No | Labelled fields to pull out, by name |
| `route` | No | Sends each document to another pack, chosen by one of this pack's answers. See [Routing](#routing) |

Question and field names use `lower_snake_case`. They become column names.

## Question types

Every question is exactly one of three types. The types are Jev's own: it answers only in these
shapes, which is why the output is always a table you can filter and sort.

### `noul`: yes or no

```yaml
termination_for_convenience:
  noul: Either party may terminate this agreement for convenience, without cause, by giving notice.
```

Write a statement that is true or false of a page. The answer is the probability that it's true.

| Field | Meaning |
|---|---|
| `noul` | The statement |
| `yes` | Optional. What counts as true. Use it when the boundary is subtle |
| `no` | Optional. What counts as false |
| `reduce` | `max` (default), `mean`, `min`, or `noisy_or` |

```yaml
is_signed:
  noul: This page shows a completed signature.
  yes: A signed name, "/s/", or an e-signature stamp
  no: An empty signature line, or a printed name with no signature
```

Jev reads `yes` and `no` as the descriptions of the two outcomes, which sharpens the probability
near the boundary.

### `choice`: one of your labels

```yaml
governing_law:
  ask: Which jurisdiction's law governs this agreement?
  choice:
    new_york: Governed by the laws of the State of New York
    delaware: Governed by the laws of the State of Delaware
    other: Another jurisdiction, or this page does not state a governing law
  fallback: other
```

The answer is one label, a confidence, and a probability for every label. A choice needs between
2 and 255 labels. A label's description can be `null` if the label explains itself.

| Field | Meaning |
|---|---|
| `choice` | Labels mapped to descriptions |
| `ask` | The question. Optional, but it helps |
| `fallback` | The label that means "not on this page". See [Reducers](reducers.md#choice) |
| `reduce` | `top_page` (default) or `mean` |

### `score`: a level on your scale

```yaml
customer_risk:
  ask: How much commercial risk do the terms on this page place on the paying customer?
  score:
    - Low. Balanced, standard terms
    - Medium. Some one-sided terms
    - High. Unlimited liability
```

List at least two levels, lowest first. Levels are numbered from zero, so this scale runs from
0 to 2. The answer is the expected level, which can fall between levels: 1.4 means "between medium
and high, nearer medium".

| Field | Meaning |
|---|---|
| `score` | Level descriptions, lowest first |
| `ask` | The question. Optional |
| `reduce` | `max` (default), `mean`, or `min` |

## Reusing questions with `use`

A question can point at a question in another pack instead of defining its own:

```yaml
questions:
  doc_type:
    use: std#doc_type                  # from the built-in standard library
  governing_law:
    use: ./legal-base.yaml#governing_law   # from a pack next to this one
```

The form is `<pack>#<question>`. A bare name such as `std` is a built-in pack. A path that starts
with `.` or `/` is a file, resolved relative to the pack that contains the `use`.

The name on the left is yours to choose: `kind: { use: std#doc_type }` produces a column called
`kind`.

### The standard library

`std` ships with docsignals in [`packs/std.yaml`](../packs/std.yaml):

| Question | Type | Asks |
|---|---|---|
| `std#doc_type` | choice | Contract, invoice, form, correspondence, report, or other |
| `std#is_signed` | noul | The page shows a completed signature, not an empty line |
| `std#has_signature_block` | noul | The page has a place for a party to sign |
| `std#has_personal_data` | noul | The page contains personal data about an individual |
| `std#has_table` | noul | The page contains a table |
| `std#text_quality` | score | How readable the extracted text is. Reduces with `min` |

## Routing

A mixed folder needs different questions for different documents. A `route` asks one choice
question first, then sends each document to the pack for its answer:

```yaml
# examples/packs/intake.yaml
name: intake
version: 1.0.0

questions:
  doc_type:
    use: std#doc_type

route:
  on: doc_type
  cases:
    invoice: ./invoices.yaml
    contract: ./contracts.yaml
```

| Field | Required | Meaning |
|---|---|---|
| `on` | Yes | A `choice` question in this pack. Its document answer selects the case |
| `cases` | Yes | A pack for each label you want to route. Labels you leave out go to `default` |
| `default` | No | The pack for every other document. Without it, those documents get no further questions |
| `min_confidence` | No | From 0 to 1. A routing answer below it goes to `default` instead of its case |

A case is either a link or an inline pack. A link follows the same rules as `use`: a path that
starts with `.` or `/` is a file next to this pack, and a bare name is a built-in pack. An inline
pack holds `questions`, `extract`, and its own `route`:

```yaml
route:
  on: doc_type
  min_confidence: 0.5
  cases:
    invoice: ./invoices.yaml
    correspondence:
      questions:
        is_complaint:
          noul: The writer is complaining about a product, a service, or a person.
  default: ./generic.yaml
```

Prefer a link. A linked pack still runs on its own, and it keeps its own `version`.

### How a routed run works

1. docsignals asks the pack's own questions of every page, as usual.
2. It reduces the `on` question to one document answer with that question's reducer. The decision
   is per document, also with `--by page`.
3. It asks the chosen pack of the same pages. The document is not extracted again, so routing adds
   one Jev request per page and no DWS cost.

A routed pack can have a `route` of its own.

### Routed columns carry a prefix

Columns from a routed pack are named `<prefix>.<name>`, so they never collide with the columns of
the pack that routed to them. The prefix of a linked pack is its `name`. The prefix of an inline
pack is its case label, or `default`. Nested routes chain: `invoices.eu.vat_number`.

```text
doc                          route      doc_type             contracts.governing_law  invoices.total_due
---------------------------  ---------  -------------------  -----------------------  --------------------
nda-brightwater-corvane.pdf  contracts  contract 0.52 (p.1)  delaware 0.47 (p.2)      -
invoice-1042.pdf             invoices   invoice 0.74 (p.1)   -                        USD 13,760.00 [0.97]
```

A cell that doesn't apply to a document shows `-`, and is empty in CSV.

The `route` column shows where the document went: a pack name, `default`, or `-` for nowhere.
A routing answer under `min_confidence` is marked, for example `default (low 0.38)`. CSV has
`route` and `route_confidence`. JSON rows carry every decision in full:

```json
"route": [
  { "on": "doc_type", "choice": "invoice", "confidence": 0.74,
    "to": "invoices@1.0.0", "via": "case", "lowConfidence": false }
]
```

### Rules

All of these fail when the pack loads, before any document is read:

- `on` must name a `choice` question in the same pack, and every case must be one of its labels.
- A routed pack can't set a `mode` that differs from the root pack's. Extraction happens once,
  before routing.
- Every prefix must be `lower_snake_case`, and two different packs under one route can't share a
  prefix. Two labels may link to the same pack.
- A route can't lead back to a pack that is already on its path.

A wrong route asks the wrong questions, so check the routing question first. Run it alone over a
sample of your documents, look at its confidence, and then choose `min_confidence`.

## Extracting fields

```yaml
extract:
  invoice_number:
    keys: [Invoice Number, Invoice No, Invoice '#']
    verify: true
```

| Field | Meaning |
|---|---|
| `keys` | Labels to look for. The first is also used in the verification statement |
| `verify` | When `true`, asks Jev whether the page supports the value. Default: `false` |

docsignals looks for each label in two places, in this order:

1. **Key-value pairs that DWS detected** on the page. Reported as `source: key_value_region`, with
   DWS's confidence that the key and value belong together.
2. **Lines of text shaped like `Label: value`.** Reported as `source: text_line`.

Labels match without regard to case, spacing, or punctuation, so `Invoice No` matches
`INVOICE NO.:`. Matching is otherwise exact: `Date` doesn't match `Due Date`. List each variant
your documents use.

Each found value also reports `block`: the id and the bounds of the DWS element it was read from,
and a link that opens a PDF at that element.

The first page with a match wins. A field that isn't found comes back with `value: null`. docsignals
never guesses a value.

With `verify: true`, the result carries `supported`: Jev's probability that the statement
`The <first key> is "<value>".` is true of the page. It catches a value attached to the wrong
label, or text that was misread. It costs nothing extra in requests, because it rides along with
the page's other questions.

## Versions

A question's wording is its behaviour. Rewording a question can move its probabilities, which
moves every threshold you've set against it. Treat a wording change the way you'd treat an API
change:

- Bump `version` when you change the wording of a question, its labels, or its levels.
- Results carry `pack: name@version`, so stored results stay traceable to the wording that
  produced them.
- The standard library follows the same rule. A result recorded against `std@1.0.0` stays
  comparable for as long as you stay on that version.
