import { describe, expect, it } from 'vitest';
import { formatResult } from '../src/format.js';
import type { RouteStep, Row, RunResult } from '../src/run.js';

const step = (over: Partial<RouteStep>): RouteStep => ({
  on: 'kind',
  choice: 'invoice',
  confidence: 0.8,
  to: 'invoices@1.0.0',
  via: 'case',
  lowConfidence: false,
  ...over,
});
const row = (doc: string, route: RouteStep[]): Row => ({ doc, answers: {}, extracted: {}, route });

const result: RunResult = {
  pack: 'router@1.0.0',
  by: 'document',
  rows: [
    row('case.pdf', [step({})]),
    row('low.pdf', [
      step({ confidence: 0.31, to: 'router/default@1.0.0', via: 'default', lowConfidence: true }),
    ]),
    row('none.pdf', [step({ choice: 'other', to: null, via: 'none' })]),
    row('nested.pdf', [step({}), step({ on: 'invoices.region', confidence: 0.6, to: 'eu@2.0.0' })]),
  ],
};

describe('formatResult with routes', () => {
  it('shows where each document went, and marks a weak decision', () => {
    const cells = formatResult(result, 'table')
      .split('\n')
      .slice(2)
      .map((line) => line.replace(/^\S+\s+/, ''));
    expect(cells).toEqual(['invoices', 'default (low 0.31)', '-', 'invoices > eu']);
  });

  it('writes the route and its weakest confidence to CSV', () => {
    expect(formatResult(result, 'csv').split('\n')).toEqual([
      'doc,route,route_confidence',
      'case.pdf,invoices@1.0.0,0.8',
      'low.pdf,router/default@1.0.0,0.31',
      'none.pdf,,0.8',
      'nested.pdf,invoices@1.0.0 > eu@2.0.0,0.6',
    ]);
  });

  it('adds no route column for a pack without a route', () => {
    const plain: RunResult = { ...result, rows: [{ doc: 'a.pdf', answers: {}, extracted: {} }] };
    expect(formatResult(plain, 'csv')).toBe('doc\na.pdf');
  });
});
