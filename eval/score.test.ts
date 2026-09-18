import { describe, expect, it } from 'vitest';
import type { Row } from '../src/run.js';
import { scoreRow } from './score.js';

function row(answers: Row['answers'], extracted: Row['extracted'] = {}): Row {
  return { doc: 'doc.pdf', answers, extracted };
}

describe('scoreRow', () => {
  it('scores a noul answer by thresholding p at 0.5', () => {
    const verdicts = scoreRow(row({ is_true: { type: 'noul', p: 0.8, page: 1 } }), {
      answers: { is_true: { expected: true, evidence: '' } },
    });
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.correct).toBe(true);
  });

  it('flags a noul answer on the wrong side of the threshold', () => {
    const verdicts = scoreRow(row({ is_true: { type: 'noul', p: 0.4, page: 1 } }), {
      answers: { is_true: { expected: true, evidence: '' } },
    });
    expect(verdicts[0]?.correct).toBe(false);
  });

  it('scores a choice answer by exact label match', () => {
    const answer = {
      type: 'choice' as const,
      choice: 'va',
      confidence: 0.9,
      probabilities: { va: 0.9, irs: 0.1 },
      page: 1,
    };
    const right = scoreRow(row({ agency: answer }), {
      answers: { agency: { expected: 'va', evidence: '' } },
    });
    const wrong = scoreRow(row({ agency: answer }), {
      answers: { agency: { expected: 'irs', evidence: '' } },
    });
    expect(right[0]?.correct).toBe(true);
    expect(wrong[0]?.correct).toBe(false);
  });

  it('scores a score answer by rounding to the nearest level', () => {
    const verdicts = scoreRow(
      row({ quality: { type: 'score', score: 1.4, confidence: 0.5, page: 1 } }),
      { answers: { quality: { expected: 1, evidence: '' } } },
    );
    expect(verdicts[0]?.correct).toBe(true);
  });

  it('scores an extracted field by normalized string match, ignoring case and spacing', () => {
    const verdicts = scoreRow(
      row(
        {},
        {
          respondent_burden: {
            value: '  30  minutes ',
            page: 1,
            block: null,
            source: 'text_line',
            confidence: null,
          },
        },
      ),
      { answers: {}, extracted: { respondent_burden: { expected: '30 minutes', evidence: '' } } },
    );
    expect(verdicts[0]?.correct).toBe(true);
  });

  it('treats a missing extracted value as matching an expected null', () => {
    const verdicts = scoreRow(
      row(
        {},
        {
          respondent_burden: {
            value: null,
            page: null,
            block: null,
            source: null,
            confidence: null,
          },
        },
      ),
      { answers: {}, extracted: { respondent_burden: { expected: null, evidence: '' } } },
    );
    expect(verdicts[0]?.correct).toBe(true);
  });

  it('fails a question the pack produced no answer for, instead of throwing', () => {
    const verdicts = scoreRow(row({}), {
      answers: { missing: { expected: true, evidence: '' } },
    });
    expect(verdicts[0]?.correct).toBe(false);
  });
});
