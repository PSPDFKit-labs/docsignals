import { type JsonValue, type Questions, TypeSafeClient } from '@typesafe-ai/sdk';
import { fakeJevFetch } from './fake-jev.js';
import type { Question } from './pack.js';
import type { Element } from './pages.js';

export type PageAnswer =
  | { type: 'noul'; p: number }
  | { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: 'score'; score: number; confidence: number };

/** The elements of a page, or plain text. */
export type State = string | Element[];

export interface Jev {
  ask(state: State, questions: Record<string, Question>): Promise<Record<string, PageAnswer>>;
}

// Jev accepts 32k tokens of state plus the longest question. Plain text runs ~4 characters per
// token. Element JSON is mostly ids and numbers and runs under 2: measured against the live API,
// 52,000 characters of elements pass and 56,000 are refused with `max_tokens_exceeded`.
const MAX_TEXT_CHARS = 110_000;
const MAX_ELEMENT_CHARS = 50_000;

function toSdkQuestions(questions: Record<string, Question>): Questions {
  const out: Questions = {};
  for (const [name, q] of Object.entries(questions)) {
    if ('noul' in q) {
      const criteria = {
        ...(q.yes === undefined ? {} : { true: q.yes }),
        ...(q.no === undefined ? {} : { false: q.no }),
      };
      out[name] = {
        type: 'noul',
        instructions: q.noul,
        ...(Object.keys(criteria).length > 0 ? { criteria } : {}),
      };
    } else if ('choice' in q) {
      out[name] = { type: 'choice', instructions: q.ask ?? null, criteria: q.choice };
    } else {
      const [first, second, ...rest] = q.score as [string, string, ...string[]];
      out[name] = {
        type: 'score',
        instructions: q.ask ?? null,
        criteria: [first, second, ...rest],
      };
    }
  }
  return out;
}

/**
 * `fake: true` answers offline with uncalibrated keyword matching; otherwise `TYPESAFE_API_KEY`
 * is required. `timeout` overrides the SDK's default per-request timeout (10s), which is too
 * short for a synchronous local model such as `tools/laya-server`; it is ignored when `fake`.
 */
export function createJev(options: { fake: boolean; timeout?: number }): Jev {
  const client = options.fake
    ? new TypeSafeClient({ apiKey: 'fake', fetch: fakeJevFetch })
    : new TypeSafeClient(options.timeout === undefined ? {} : { timeout: options.timeout });

  return {
    async ask(state, questions) {
      const isText = typeof state === 'string';
      const length = isText ? state.length : JSON.stringify(state).length;
      if (length > (isText ? MAX_TEXT_CHARS : MAX_ELEMENT_CHARS)) {
        throw new Error(
          `the page state is ${length} characters, over Jev's 32k-token state limit; split the page before asking`,
        );
      }
      const { answers } = await client.systemOne({
        state: state as JsonValue[] | string,
        questions: toSdkQuestions(questions),
      });
      const out: Record<string, PageAnswer> = {};
      for (const [name, a] of Object.entries(answers)) {
        if (a.type === 'noul') out[name] = { type: 'noul', p: a.noul };
        else if (a.type === 'choice')
          out[name] = {
            type: 'choice',
            choice: a.choice,
            confidence: a.confidence,
            probabilities: { ...a.probabilities },
          };
        else out[name] = { type: 'score', score: a.score, confidence: a.confidence };
      }
      return out;
    },
  };
}
