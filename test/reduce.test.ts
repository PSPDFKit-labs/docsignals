import { describe, expect, it } from 'vitest';
import type { Question } from '../src/pack.js';
import { type Located, reduceAnswers } from '../src/reduce.js';

const noul = (page: number, p: number): Located => ({ type: 'noul', p, page });
const choice = (page: number, probabilities: Record<string, number>): Located => {
  const [label, confidence] = Object.entries(probabilities).sort(([, a], [, b]) => b - a)[0] as [
    string,
    number,
  ];
  return { type: 'choice', choice: label, confidence, probabilities, page };
};
const score = (page: number, value: number, confidence = 0.5): Located => ({
  type: 'score',
  score: value,
  confidence,
  page,
});

describe('noul reducers', () => {
  const pages = [noul(1, 0.2), noul(2, 0.9), noul(3, 0.5)];
  const q = (reduce: string) => ({ noul: 'x', reduce }) as Question;

  it('max keeps the highest page and says which', () => {
    expect(reduceAnswers(q('max'), pages)).toEqual(noul(2, 0.9));
  });
  it('min keeps the lowest page', () => {
    expect(reduceAnswers(q('min'), pages)).toEqual(noul(1, 0.2));
  });
  it('mean averages and points at the strongest page', () => {
    const out = reduceAnswers(q('mean'), pages) as Extract<Located, { type: 'noul' }>;
    expect(out.p).toBeCloseTo(0.5333, 3);
    expect(out.page).toBe(2);
  });
  it('noisy_or climbs with page count, which is why it is not the default', () => {
    const many = Array.from({ length: 50 }, (_, i) => noul(i + 1, 0.1));
    const out = reduceAnswers(q('noisy_or'), many) as Extract<Located, { type: 'noul' }>;
    expect(out.p).toBeGreaterThan(0.99);
    expect((reduceAnswers(q('max'), many) as typeof out).p).toBe(0.1);
  });
});

describe('choice reducers', () => {
  const q = (reduce: string, fallback?: string) =>
    ({
      choice: { ny: null, de: null, other: null },
      reduce,
      ...(fallback ? { fallback } : {}),
    }) as Question;

  it('top_page ignores pages that answered the fallback, however confident', () => {
    const pages = [
      choice(1, { ny: 0.01, de: 0.01, other: 0.98 }),
      choice(2, { ny: 0.7, de: 0.2, other: 0.1 }),
      choice(3, { ny: 0.02, de: 0.01, other: 0.97 }),
    ];
    expect(reduceAnswers(q('top_page', 'other'), pages)).toMatchObject({ choice: 'ny', page: 2 });
  });

  it('top_page returns the fallback when every page chose it', () => {
    const pages = [
      choice(1, { ny: 0.1, de: 0.1, other: 0.8 }),
      choice(2, { ny: 0, de: 0.1, other: 0.9 }),
    ];
    expect(reduceAnswers(q('top_page', 'other'), pages)).toMatchObject({
      choice: 'other',
      page: 2,
    });
  });

  it('mean averages the distributions, so one decisive page can be outvoted', () => {
    const pages = [
      choice(1, { ny: 0.01, de: 0.01, other: 0.98 }),
      choice(2, { ny: 0.7, de: 0.2, other: 0.1 }),
      choice(3, { ny: 0.02, de: 0.01, other: 0.97 }),
    ];
    const out = reduceAnswers(q('mean'), pages);
    expect(out).toMatchObject({ choice: 'other', page: 1 });
    expect((out as Extract<Located, { type: 'choice' }>).confidence).toBeCloseTo(0.6833, 3);
  });
});

describe('score reducers', () => {
  const pages = [score(1, 0.4), score(2, 1.8), score(3, 1.0)];
  const q = (reduce: string) => ({ score: ['a', 'b'], reduce }) as Question;

  it('max, min and mean', () => {
    expect(reduceAnswers(q('max'), pages)).toMatchObject({ score: 1.8, page: 2 });
    expect(reduceAnswers(q('min'), pages)).toMatchObject({ score: 0.4, page: 1 });
    expect((reduceAnswers(q('mean'), pages) as { score: number }).score).toBeCloseTo(1.0667, 3);
  });
});

it('refuses to reduce zero pages', () => {
  expect(() => reduceAnswers({ noul: 'x', reduce: 'max' }, [])).toThrow(/zero pages/);
});
