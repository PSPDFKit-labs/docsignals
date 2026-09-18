import { z } from 'zod';

const bounds = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });

const base = {
  id: z.string().min(1),
  bounds,
  readingOrder: z.number(),
  confidence: z.number(),
  page: z.looseObject({
    pageNumber: z.number().int().positive(),
    width: z.number().positive(),
    height: z.number().positive(),
  }),
};

const entity = z.looseObject({ value: z.unknown(), confidence: z.number() });

// Loose on purpose: Jev is asked of each element as DWS returned it, so unknown fields must survive the parse.
const element = z.discriminatedUnion('type', [
  z.looseObject({ ...base, type: z.literal('paragraph'), text: z.string() }),
  z.looseObject({ ...base, type: z.literal('handwriting'), text: z.string() }),
  z.looseObject({
    ...base,
    type: z.literal('table'),
    cells: z.array(z.looseObject({ row: z.number(), column: z.number(), text: z.string() })),
  }),
  z.looseObject({
    ...base,
    type: z.literal('keyValueRegion'),
    pairs: z.array(
      z.looseObject({
        key: entity.nullish(),
        value: entity.nullish(),
        relationshipConfidence: z.number().nullish(),
      }),
    ),
  }),
  z.looseObject({ ...base, type: z.literal('picture') }),
  z.looseObject({ ...base, type: z.literal('chart') }),
  z.looseObject({ ...base, type: z.literal('formula') }),
]);

export const elementList = z.array(element);
export type Element = z.infer<typeof element>;

export type Bounds = z.infer<typeof bounds>;

/** Where one DWS element is. `bounds` is in the units of the page `width` and `height`. */
export interface Block {
  /** DWS element id. Stable for one cached extraction. */
  id: string;
  bounds: Bounds;
}

export interface KeyValue {
  key: string;
  value: string;
  /** The element the pair was read from. */
  block: Block;
  /** `key_value_region`: DWS detected the pair. `text_line`: read from a "Key: value" line of text. */
  source: 'key_value_region' | 'text_line';
  /** DWS confidence that key and value belong together. Null for `text_line`. */
  confidence: number | null;
}

const KEY_VALUE_LINE = /^([^:\n]{1,60}):[ \t]+(\S.*)$/;

function textLineKeyValues(text: string, block: KeyValue['block']): KeyValue[] {
  const found: KeyValue[] = [];
  for (const line of text.split('\n')) {
    const match = KEY_VALUE_LINE.exec(line.trim());
    if (match?.[1] && match[2]) {
      found.push({
        key: match[1].trim(),
        value: match[2].trim(),
        block,
        source: 'text_line',
        confidence: null,
      });
    }
  }
  return found;
}

export interface Page {
  /** 1-based page number. */
  page: number;
  width: number;
  height: number;
  /** The DWS elements of the page as DWS returned them, in reading order. This is what Jev is asked of. */
  elements: Element[];
  keyValues: KeyValue[];
}

function entityText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : JSON.stringify(value);
}

/** Groups DWS spatial elements into pages, in reading order. */
export function buildPages(elements: Element[]): Page[] {
  const byPage = new Map<number, Element[]>();
  for (const el of elements) {
    const list = byPage.get(el.page.pageNumber) ?? [];
    list.push(el);
    byPage.set(el.page.pageNumber, list);
  }

  return [...byPage.entries()]
    .sort(([a], [b]) => a - b)
    .map(([page, els]) => {
      const detected: KeyValue[] = [];
      const fromText: KeyValue[] = [];
      for (const el of els.sort((a, b) => a.readingOrder - b.readingOrder)) {
        const block = { id: el.id, bounds: el.bounds };
        if (el.type === 'paragraph' || el.type === 'handwriting') {
          fromText.push(...textLineKeyValues(el.text, block));
        } else if (el.type === 'keyValueRegion') {
          for (const pair of el.pairs) {
            if (!pair.key || !pair.value) continue;
            detected.push({
              key: entityText(pair.key.value),
              value: entityText(pair.value.value),
              block,
              source: 'key_value_region',
              confidence: pair.relationshipConfidence ?? null,
            });
          }
        }
      }
      // Detected pairs come first so a field prefers DWS's own pairing over a text line.
      const keyValues = [...detected, ...fromText];
      const { width, height } = (els[0] as Element).page;
      return { page, width, height, elements: els, keyValues };
    });
}
