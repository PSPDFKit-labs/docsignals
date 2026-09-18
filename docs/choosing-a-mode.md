# Choosing an extraction mode

Every answer docsignals gives is an answer about the text that extraction produced. If extraction
misreads a page, a well-worded question can't recover it. That's why the default `mode` is
`agentic`, the most capable Nutrient DWS Data Extraction pipeline: the quality of the raw content
sets the ceiling for everything after it.

| Mode | DWS credits per page | What it does |
|---|---|---|
| `agentic` (default) | 18 | The full pipeline plus a vision-language model. Best for complex visual layouts |
| `understand` | 9 | OCR plus AI augmentation. Accurate for tables, multi-column layouts, and forms |
| `structure` | 1.5 | OCR-based segmentation. Handles born-digital and scanned documents |

DWS also has a `text` mode. docsignals doesn't support it, because it returns whole-document
Markdown with no page boundaries, and docsignals asks its questions page by page.

Extraction is cached by file content and mode. You pay for a document once per mode, however many
times you change and re-run your questions. The expensive step is the one you never repeat.

## What stepping down can cost, from the examples

`examples/documents/invoices/invoice-1043.pdf` has a red bordered "past due" notice above its
invoice fields. We extracted it in each mode.

In `structure` mode, the border led the pipeline to read the notice and the fields below it as
one table. The field labels and values were merged into a single cell:

```text
PAST DUE — SECOND REMINDER. 27, 2026 and has not been received. | invoice is | Payment was | due on February
Invoice Number: INV-1043 Invoice Date: February 12, 2026 Due Date: February 27, 2026 Bill To: Pellucid Robotics, Inc., | Accounts |  |
```

With that text, the invoices pack found `total_due` and lost `invoice_number` and `due_date`.

In `understand` and `agentic` modes, the same region came back as clean lines:

```text
Invoice Number: INV-1043
Invoice Date: February 12, 2026
Due Date: February 27, 2026
```

All three fields were found.

On the three plain-prose contracts, `structure` and `agentic` produced the same answers to every
question in the contracts pack. On the two invoices, `understand` and `agentic` did too.

This is five born-digital documents, not a benchmark. It shows the kind of difference to look
for, not how often it happens. Scans, handwriting, and dense layouts are where the modes are
designed to differ most, and these examples contain none.

## When to step down

Stay on `agentic` unless cost matters more than the last increment of extraction quality. When it
does:

1. **Compare before you commit.** Extract a sample of your documents in the cheaper mode and read
   what your questions would see:

   ```bash
   npm run docsignals -- pages path/to/document.pdf --mode structure
   ```

   If labels and values are scrambled, tables are merged, or columns are interleaved, the cheaper
   mode is costing you answers.
2. **Step down per pack.** A pack for plain-prose contracts can set `mode: structure` while a pack
   for invoices and forms stays on the default. You pay the higher rate only where it changes
   the result.
3. **Re-check when your documents change.** A new supplier's invoice layout can break a mode that
   worked for the old ones.
