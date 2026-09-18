# Reducers

Jev answers a question about one page. You usually want an answer about one document. A reducer
is the rule that folds a question's page answers into a document answer.

This matters more than it looks. A governing-law clause lives on one page out of forty. The other
thirty-nine pages correctly answer "this page doesn't say". Average those forty answers and the
document's governing law is "doesn't say". The reducer you pick decides whether the one page that
matters is heard.

Every reduced answer keeps the **page that decided it**, shown as `(p.3)` in a table and as `page`
in JSON and CSV. That's your citation: open the page and check.

To skip reduction and see the page answers themselves, run with `--by page`.

## Noul

| Reducer | Document answer | Use it when |
|---|---|---|
| `max` (default) | The highest page probability | The statement is true of the document if it's true of any page: "contains a signature", "has a termination clause" |
| `min` | The lowest page probability | The statement must hold on every page: "is legible", "is in English" |
| `mean` | The average | You want a document-wide tendency, not a yes or no |
| `noisy_or` | `1 − Π(1 − p)` | Rarely. Read the warning below |

### Why `noisy_or` isn't the default

`noisy_or` is the textbook way to combine independent probabilities: the chance that at least
one page is a "yes". It assumes the pages are independent pieces of evidence, and the pages of one
document aren't.

The effect is easy to see. Take a 50-page document where every page scores a weak 0.10:

| Reducer | Result |
|---|---|
| `max` | 0.10 |
| `noisy_or` | 0.99 |

Fifty weak maybes become a near-certain yes, only because the document is long. `max` doesn't
inflate with page count, so it's the default. If you use `noisy_or`, expect its output to rise
with document length, and don't compare it across documents of different sizes.

## Choice

| Reducer | Document answer | Use it when |
|---|---|---|
| `top_page` (default) | The answer from the single most confident page, ignoring pages that chose the `fallback` label | The answer is stated in one place: governing law, document type, currency |
| `mean` | Averages each label's probability across pages, then picks the highest | The answer is a property of the whole document: language, tone |

### The `fallback` label

Most choice questions need a label that means "not on this page", and most pages will choose it
with high confidence. Name that label as the question's `fallback`:

```yaml
governing_law:
  choice:
    new_york: Governed by the laws of the State of New York
    delaware: Governed by the laws of the State of Delaware
    other: Another jurisdiction, or this page does not state a governing law
  fallback: other
```

`top_page` then sets aside every page that chose `other` and picks the most confident of the
rest. If every page chose the fallback, the fallback is the answer.

Without a `fallback`, a confident "not on this page" from page 1 can beat a less confident
"New York" from page 3.

## Score

| Reducer | Document answer | Use it when |
|---|---|---|
| `max` (default) | The highest page score | One bad page is enough: risk, severity |
| `min` | The lowest page score | The weakest page sets the level: text quality |
| `mean` | The average score | You want the overall level |

## What reducers don't do

A reduced probability is a summary of page probabilities. It isn't a calibrated probability about
the document. Jev's calibration claim applies to the question it was asked, which was about a
page. How well a reduced number tracks document-level truth hasn't been measured, and it will
depend on the question and the reducer. Before you automate a decision on a threshold, check that
threshold against documents whose answers you know.

## Block provenance

After the reducer names the page that decided an answer, docsignals asks Jev one more question of
that page: which block supports the answer? The state is the same as in the page request: the
elements of the page as DWS returned them. The labels of the choice are the DWS element ids, plus
`none`.

| Question | The statement Jev matches to a block |
|---|---|
| noul | The statement of the question |
| choice | The question, with the label the document answer chose and its description |
| score | The question, with the description of the nearest level |

A block is looked for only when the deciding page affirms the answer. No block is the source of
an absence:

- A noul whose deciding page has `p` under 0.5 gets `block: null`. The page denies the statement.
- A choice that ended on its `fallback` label gets `block: null`. That label means "not stated here".
- A score always gets a block question.

All the answers that one page decided go in one request, so the cost is at most one request per
deciding page. A page that affirms nothing gets no request. The answer keeps the block's DWS `id`, its `bounds`, a `link` into the PDF, and Jev's
`confidence` in that block. When Jev chooses `none`, `block` is `null`.
