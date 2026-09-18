import { describe, expect, it } from 'vitest';
import { buildPages, elementList } from '../src/pages.js';

const bounds = { x: 10, y: 20, width: 30, height: 5 };

const at = (pageNumber: number, readingOrder: number) => ({
  id: `el-${pageNumber}-${readingOrder}`,
  bounds,
  confidence: 0.9,
  readingOrder,
  page: { pageIndex: pageNumber - 1, pageNumber, width: 100, height: 100 },
});

describe('buildPages', () => {
  it('orders pages and elements by reading order', () => {
    const pages = buildPages(
      elementList.parse([
        { ...at(2, 0), type: 'paragraph', text: 'second page' },
        { ...at(1, 1), type: 'paragraph', text: 'world' },
        { ...at(1, 0), type: 'paragraph', text: 'hello' },
      ]),
    );
    expect(pages.map((p) => p.page)).toEqual([1, 2]);
    expect(pages[0]?.elements.map((el) => 'text' in el && el.text)).toEqual(['hello', 'world']);
  });

  it('reads key-values from DWS regions and from "Key: value" lines, regions first', () => {
    const [page] = buildPages(
      elementList.parse([
        { ...at(1, 0), type: 'paragraph', text: 'Due Date: May 1, 2026\nnot a pair' },
        {
          ...at(1, 1),
          type: 'keyValueRegion',
          pairs: [
            {
              key: { value: 'Total', confidence: 0.9 },
              value: { value: 'USD 10', confidence: 0.9 },
              relationshipConfidence: 0.8,
            },
            { key: { value: 'Orphan', confidence: 0.9 }, value: null },
          ],
        },
      ]),
    );
    expect(page?.keyValues).toEqual([
      {
        key: 'Total',
        value: 'USD 10',
        block: { id: 'el-1-1', bounds },
        source: 'key_value_region',
        confidence: 0.8,
      },
      {
        key: 'Due Date',
        value: 'May 1, 2026',
        block: { id: 'el-1-0', bounds },
        source: 'text_line',
        confidence: null,
      },
    ]);
  });

  it('keeps each element as DWS returned it, unknown fields included, in reading order', () => {
    const second = { ...at(1, 1), type: 'paragraph', role: 'Text', text: 'body', futureField: 7 };
    const first = { ...at(1, 0), type: 'picture', altDescription: 'A signature' };
    const [page] = buildPages(elementList.parse([second, first]));
    expect(page?.elements).toEqual([first, second]);
    expect(page).toMatchObject({ width: 100, height: 100 });
  });

  it('accepts a chart, which DWS returns for a plot, with its description of the data', () => {
    const chart = { ...at(1, 0), type: 'chart', htmlTable: '<table></table>', captionIds: [] };
    const [page] = buildPages(elementList.parse([chart]));
    expect(page?.elements).toEqual([chart]);
  });

  it('rejects an element with no bounds', () => {
    const { bounds: _, ...noBounds } = at(1, 0);
    expect(elementList.safeParse([{ ...noBounds, type: 'paragraph', text: 'x' }]).success).toBe(
      false,
    );
  });

  it('rejects an element type it does not know', () => {
    expect(elementList.safeParse([{ ...at(1, 0), type: 'hologram' }]).success).toBe(false);
  });
});
