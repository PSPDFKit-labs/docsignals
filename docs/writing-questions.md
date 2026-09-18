# Writing good questions

Jev doesn't generate text. It reads a page and your question, and returns a typed answer with a
probability. The wording of the question is the only instruction it gets, so wording is where
answer quality comes from.

## Ask about a page, not a document

Every question is asked of one page at a time. Write it so that it makes sense for a single page:

| Instead of | Write |
|---|---|
| This contract is signed. | The parties have signed this agreement. |
| What is the contract's governing law? | Which jurisdiction's law governs this agreement? |

Both right-hand versions are true or false of whichever page holds the evidence. The
[reducer](reducers.md) then turns page answers into the document's answer.

## Write a noul as a statement

A noul is the probability that a statement is true. Write the statement, not a question:

```yaml
# Harder to answer: what does "yes" mean here?
auto_renews:
  noul: Does it renew?

# Clear: true or false of this page
auto_renews:
  noul: This agreement renews automatically unless a party gives notice of non-renewal.
```

Say what you mean in the terms the document would use. "For convenience, without cause" names the
clause the way a contract does.

## Describe every choice label

A label on its own is a guess at your meaning. A description is an instruction:

```yaml
choice:
  new_york: Governed by the laws of the State of New York
  other: Another jurisdiction, or this page does not state a governing law
```

Give every choice a label for "none of these, or not on this page", and name it as the
`fallback`. Without it, Jev has to pick one of your real labels for a page that mentions none of
them, and that pick can win the reduction.

## Anchor each score level

Describe what each level looks like, lowest first:

```yaml
score:
  - Low. Balanced, standard terms with capped liability and an easy exit
  - Medium. Some one-sided terms, such as automatic renewal or long notice periods
  - High. Unlimited liability, indemnification duties, or payment owed after the customer exits
```

"1 to 5" with no descriptions means something different to every reader, Jev included.

## Keep questions independent

All of a pack's questions for a page go to Jev in one request, and each is answered on its own.
A question can't refer to another question's answer. If you need "is this an invoice **and**
overdue", ask both and combine the answers in your own code.

## See what the question sees

If an answer looks wrong, check the input before the wording:

```bash
npm run docsignals -- pages path/to/document.pdf
```

If the clause you're asking about is garbled or missing from that text, no wording will fix it.
See [Choosing an extraction mode](choosing-a-mode.md).

Then look at the page answers one by one, before reduction:

```bash
npm run docsignals -- run my-pack.yaml path/to/document.pdf --by page
```

## Iterate on wording, cheaply

Extraction is cached, so re-running a pack after a wording change re-asks the questions and
nothing else. Keep a small folder of documents whose answers you know, and re-run the pack against
it after every change.

When a wording change is one you want to keep, bump the pack's `version`. See
[Versions](packs.md#versions).

## Set thresholds from your own documents

A threshold such as `p > 0.9` is a decision about how many wrong answers you'll accept. Pick it by
running the pack on documents whose answers you know and looking at where right and wrong answers
separate. Don't carry a threshold over from `--fake` output: the fake's numbers are keyword
overlap, not probabilities.
