# Library API

Everything the CLI does is available from TypeScript. The package is ESM and needs Node.js 20 or
later.

```ts
import { loadPack, runPack } from '@nutrient-sdk/docsignals';

const pack = await loadPack('contracts.yaml');
const result = await runPack(pack, ['msa.pdf', 'nda.pdf']);
```

A runnable version is in [`examples/library.ts`](../examples/library.ts).

## `loadPack(path)`

Reads and validates a pack, and resolves every `use` reference. Returns a `Pack`. Throws a
`PackError` whose message names the file and the problem.

## `runPack(pack, files, options?)`

Extracts each file, asks every question of every page, and reduces. Returns a `RunResult`.

| Option | Default | Meaning |
|---|---|---|
| `by` | `'document'` | `'document'` for one row per file, `'page'` for one row per page |
| `cacheDir` | `~/.config/nutrient/docsignals/cache` | Where extraction results are cached |
| `fake` | `false` | Answer offline with uncalibrated keyword matching. Needs no Jev key |
| `concurrency` | `8` | How many extractions, and then how many Jev requests, run at once |
| `parser` | DWS | A function that returns DWS spatial elements for a file. For tests and custom pipelines |
| `jev` | Jev | An object with an `ask(state, questions)` method. For tests and custom models |

Without `parser`, extraction uses `NUTRIENT_EXTRACTION_API_KEY`. Without `jev` or `fake`, questions use
`TYPESAFE_API_KEY`. A missing key throws when it's first needed: extraction on a cache hit needs
no DWS key.

### The result

```ts
interface RunResult {
  pack: string;                 // 'contracts@1.0.0'
  by: 'document' | 'page';
  rows: Row[];
}

interface Row {
  doc: string;                  // file name
  page?: number;                // present when by is 'page'
  answers: Record<string, PageAnswer | Located>;
  extracted: Record<string, Extracted>;
  route?: RouteStep[];          // present when the pack has a route; one step per level
}

interface RouteStep {
  on: string;                   // column name of the routing question
  choice: string;
  confidence: number;
  to: string | null;            // 'invoices@1.0.0', or null when nothing applied
  via: 'case' | 'default' | 'none';
  lowConfidence: boolean;       // under the route's min_confidence
}
```

Columns from a routed pack are keyed with their prefix: `row.answers['invoices.is_overdue']`.
See [Routing](packs.md#routing).

An answer is a discriminated union on `type`:

```ts
type PageAnswer =
  | { type: 'noul'; p: number }
  | { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: 'score'; score: number; confidence: number };
```

In a document row, each answer is a `Sourced`: the same shape plus `page`, the page that
decided it, and `block`, the block on that page that Jev chose as the source of the answer.

```ts
interface SourceBlock {
  id: string;                   // DWS element id, stable for one cached extraction
  bounds: { x: number; y: number; width: number; height: number };
  link: string | null;          // file:// URL that opens the PDF at the block; null when not a PDF
}

interface AnswerBlock extends SourceBlock {
  confidence: number;           // Jev's probability for this block, against the other blocks and "none"
}
```

`block` is `null` when there is no source to name: a noul whose deciding page has `p` under 0.5, a
choice that ended on its `fallback` label, or an answer for which Jev chose "none". Rows per page (`by: 'page'`) carry no `page` and no `block`.

```ts
interface Extracted {
  value: string | null;         // null when the field was not found
  page: number | null;
  block: SourceBlock | null;    // the element the value was read from
  source: 'key_value_region' | 'text_line' | null;
  confidence: number | null;    // DWS pairing confidence, for key_value_region
  supported?: number;           // Jev's probability the page supports the value, with verify
}
```

`bounds` is in the units of the page size, which `extractPages` returns as `width` and `height` on
each page, with the origin at the top left. Divide by the page size to draw the block in a viewer.

### Narrowing an answer

```ts
for (const row of result.rows) {
  const law = row.answers.governing_law;
  if (law?.type === 'choice' && law.confidence > 0.9) {
    console.log(`${row.doc}: ${law.choice}`);
  }
}
```

## `formatResult(result, format)`

Renders a `RunResult` as `'table'`, `'json'`, or `'csv'`, exactly as the CLI prints it.

## Lower-level pieces

| Export | Use |
|---|---|
| `extractPages(file, { mode, cacheDir })` | Extract one document into pages, through the cache |
| `buildPages(elements)` | Turn DWS spatial elements into pages |
| `createJev({ fake })` | The Jev client that `runPack` uses |
| `reduceAnswers(question, pageAnswers)` | Apply a question's reducer |
| `fakeJevFetch` | The offline transport behind `--fake`, for your own tests |

## Testing code that uses docsignals

Pass `fake: true` and point `cacheDir` at recorded extractions, and a test makes no network
calls. docsignals's own suite runs this way against `examples/cache`.

To control the answers exactly, pass your own `jev`:

```ts
const result = await runPack(pack, files, {
  cacheDir: 'test/fixtures/cache',
  jev: {
    ask: async () => ({ is_signed: { type: 'noul', p: 0.98 } }),
  },
});
```
