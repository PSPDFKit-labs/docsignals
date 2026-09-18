import { describe, expect, it } from 'vitest';
import { createJev } from '../src/jev.js';
import type { Question } from '../src/pack.js';

const questions: Record<string, Question> = {
  signed: { noul: 'The parties have signed this agreement.', reduce: 'max' },
  law: {
    ask: 'Which law governs?',
    choice: {
      new_york: 'Laws of the State of New York',
      delaware: 'Laws of the State of Delaware',
    },
    reduce: 'top_page',
  },
  risk: { score: ['balanced standard terms', 'unlimited liability indemnify'], reduce: 'max' },
};

describe('createJev with the fake transport', () => {
  const jev = createJev({ fake: true });

  it('answers every question type through the real SDK client', async () => {
    const answers = await jev.ask(
      'The parties have signed this agreement. It is governed by the laws of the State of Delaware.',
      questions,
    );
    expect(answers.signed).toEqual({ type: 'noul', p: expect.closeTo(0.97, 2) });
    expect(answers.law).toMatchObject({ type: 'choice', choice: 'delaware' });
    expect(answers.risk).toMatchObject({ type: 'score' });
  });

  it('returns choice probabilities that sum to one', async () => {
    const { law } = await jev.ask('Delaware', questions);
    const total = Object.values((law as { probabilities: Record<string, number> }).probabilities);
    expect(total.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
  });

  it('is deterministic', async () => {
    const state = 'unlimited liability applies';
    expect(await jev.ask(state, questions)).toEqual(await jev.ask(state, questions));
  });

  it('sends the yes and no descriptions of a noul as its criteria', async () => {
    const plain: Question = { noul: 'The customer wants a person.', reduce: 'max' };
    const described: Question = { ...plain, yes: 'Mentions an earlier call that did not help' };
    const state = 'I made an earlier call and it did not help.';
    const answers = await jev.ask(state, { plain, described });
    expect((answers.described as { p: number }).p).toBeGreaterThan(
      (answers.plain as { p: number }).p,
    );
  });

  it('sends the no description too', async () => {
    const plain: Question = { noul: 'The customer made an earlier call.', reduce: 'max' };
    const described: Question = { ...plain, no: 'The call did not help' };
    const answers = await jev.ask('I made an earlier call and it did not help.', {
      plain,
      described,
    });
    expect((answers.described as { p: number }).p).toBeLessThan((answers.plain as { p: number }).p);
  });

  it('scores an unrelated page low', async () => {
    const { signed } = await jev.ask('Quarterly rainfall totals for the region.', questions);
    expect((signed as { p: number }).p).toBeLessThan(0.1);
  });

  it('refuses a page over the state limit before calling out', async () => {
    await expect(jev.ask('x'.repeat(120_000), questions)).rejects.toThrow(/32k-token state limit/);
  });

  it('refuses elements at a lower size than text, because element JSON costs more tokens', async () => {
    const element = {
      id: 'el',
      type: 'paragraph' as const,
      text: 'x'.repeat(60_000),
      bounds: { x: 0, y: 0, width: 1, height: 1 },
      readingOrder: 0,
      confidence: 1,
      page: { pageNumber: 1, width: 1, height: 1 },
    };
    await expect(jev.ask([element], questions)).rejects.toThrow(/32k-token state limit/);
    await expect(jev.ask('x'.repeat(60_000), questions)).resolves.toBeDefined();
  });
});

it('fails loudly without a key when not faked', () => {
  const saved = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    expect(() => createJev({ fake: false })).toThrow(/api.?key/i);
  } finally {
    if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
  }
});

it('accepts a timeout override for a slower, synchronous local model', () => {
  const saved = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'local';
  try {
    expect(() => createJev({ fake: false, timeout: 120_000 })).not.toThrow();
  } finally {
    if (saved === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = saved;
  }
});
