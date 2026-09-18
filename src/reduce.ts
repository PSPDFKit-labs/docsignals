import type { PageAnswer } from './jev.js';
import type { Question } from './pack.js';

/** A page-level answer tagged with the page it came from. */
export type Located<A extends PageAnswer = PageAnswer> = A & { page: number };

type Noul = Extract<PageAnswer, { type: 'noul' }>;
type Choice = Extract<PageAnswer, { type: 'choice' }>;
type Score = Extract<PageAnswer, { type: 'score' }>;

function best<T>(items: readonly T[], value: (item: T) => number): T {
  if (items.length === 0) throw new Error('cannot reduce zero pages');
  return items.reduce((a, b) => (value(b) > value(a) ? b : a));
}

const mean = (values: number[]): number => values.reduce((a, b) => a + b, 0) / values.length;

function reduceNoul(pages: Located<Noul>[], reducer: string): Located<Noul> {
  const top = best(pages, (a) => a.p);
  switch (reducer) {
    case 'max':
      return top;
    case 'min':
      return best(pages, (a) => -a.p);
    case 'mean':
      return { type: 'noul', p: mean(pages.map((a) => a.p)), page: top.page };
    case 'noisy_or':
      return { type: 'noul', p: 1 - pages.reduce((acc, a) => acc * (1 - a.p), 1), page: top.page };
    default:
      throw new Error(`unknown noul reducer "${reducer}"`);
  }
}

function reduceChoice(
  pages: Located<Choice>[],
  reducer: string,
  fallback: string | undefined,
): Located<Choice> {
  if (reducer === 'top_page') {
    // A clause usually lives on one page; every other page honestly answers the fallback label.
    const decisive = pages.filter((a) => a.choice !== fallback);
    return best(decisive.length > 0 ? decisive : pages, (a) => a.confidence);
  }
  if (reducer === 'mean') {
    const labels = Object.keys((pages[0] as Located<Choice>).probabilities);
    const probabilities = Object.fromEntries(
      labels.map((label) => [label, mean(pages.map((a) => a.probabilities[label] ?? 0))]),
    );
    const choice = best(labels, (label) => probabilities[label] ?? 0);
    return {
      type: 'choice',
      choice,
      confidence: probabilities[choice] ?? 0,
      probabilities,
      page: best(pages, (a) => a.probabilities[choice] ?? 0).page,
    };
  }
  throw new Error(`unknown choice reducer "${reducer}"`);
}

function reduceScore(pages: Located<Score>[], reducer: string): Located<Score> {
  const top = best(pages, (a) => a.score);
  switch (reducer) {
    case 'max':
      return top;
    case 'min':
      return best(pages, (a) => -a.score);
    case 'mean':
      return {
        type: 'score',
        score: mean(pages.map((a) => a.score)),
        confidence: mean(pages.map((a) => a.confidence)),
        page: top.page,
      };
    default:
      throw new Error(`unknown score reducer "${reducer}"`);
  }
}

/** Folds one question's per-page answers into a document answer, keeping the page that drove it. */
export function reduceAnswers(question: Question, pages: Located[]): Located {
  if ('noul' in question) return reduceNoul(pages as Located<Noul>[], question.reduce);
  if ('choice' in question) {
    return reduceChoice(pages as Located<Choice>[], question.reduce, question.fallback);
  }
  return reduceScore(pages as Located<Score>[], question.reduce);
}
