/**
 * An offline stand-in for the Jev API, used by `--fake`.
 *
 * It scores keyword overlap between the question and the page. It is deterministic and
 * free, which makes it useful for trying docsignals and for tests. Its probabilities are
 * NOT calibrated and mean nothing beyond "more of the question's words appear here".
 */

const STOPWORDS = new Set(
  'a an and any are as at be by for from has have in is it its may not of on or other that the their this to was were which will with'.split(
    ' ',
  ),
);

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2 && !STOPWORDS.has(word)),
  );
}

function entryText(entry: unknown): string {
  if (entry === null || entry === undefined) return '';
  return typeof entry === 'string' ? entry : JSON.stringify(entry);
}

/** Fraction of the description's keywords that occur in the state, squared to separate weak matches. */
function overlap(state: Set<string>, description: string): number {
  const wanted = tokens(description);
  if (wanted.size === 0) return 0;
  let hits = 0;
  for (const word of wanted) if (state.has(word)) hits++;
  return (hits / wanted.size) ** 2;
}

function normalise(weights: number[]): number[] {
  const floor = weights.map((w) => w + 0.02);
  const total = floor.reduce((a, b) => a + b, 0);
  return floor.map((w) => w / total);
}

type FakeQuestion =
  | { type: 'noul'; instructions?: unknown; criteria?: { true?: unknown; false?: unknown } | null }
  | { type: 'choice'; instructions?: unknown; criteria: Record<string, unknown> }
  | { type: 'score'; instructions?: unknown; criteria: unknown[] };

type FakeElement = { id: string } & Record<string, unknown>;

const isElements = (state: unknown): state is FakeElement[] =>
  Array.isArray(state) && state.every((el) => typeof el?.id === 'string');

/** The words of an element's content. Field names and structure values are not content. */
function content(value: unknown, key = ''): string {
  if (typeof value === 'string') return /^(id|type|role|.*Ids)$/.test(key) ? '' : value;
  if (Array.isArray(value)) return value.map((item) => content(item, key)).join(' ');
  if (value !== null && typeof value === 'object') {
    return Object.entries(value)
      .map(([k, v]) => content(v, k))
      .join(' ');
  }
  return '';
}

/** A choice between the elements of the state: a label that is an element id scores that element against the question. */
function elementWeights(elements: FakeElement[], q: FakeQuestion & { type: 'choice' }): number[] {
  const byId = new Map(elements.map((el) => [el.id, tokens(content(el))]));
  return Object.keys(q.criteria).map((label) => {
    const element = byId.get(label);
    return element ? overlap(element, entryText(q.instructions)) : 0;
  });
}

function answer(state: Set<string>, q: FakeQuestion, elements?: FakeElement[]): unknown {
  if (q.type === 'noul') {
    const text = `${entryText(q.instructions)} ${entryText(q.criteria?.true)}`;
    const against = overlap(state, entryText(q.criteria?.false));
    return { type: 'noul', noul: 0.03 + 0.94 * overlap(state, text) * (1 - against / 2) };
  }
  if (q.type === 'choice') {
    const labels = Object.keys(q.criteria);
    const probs = normalise(
      elements?.some((el) => el.id in q.criteria)
        ? elementWeights(elements, q)
        : labels.map((label) => overlap(state, `${label} ${entryText(q.criteria[label])}`)),
    );
    const best = probs.indexOf(Math.max(...probs));
    return {
      type: 'choice',
      choice: labels[best],
      confidence: probs[best],
      probabilities: Object.fromEntries(labels.map((label, i) => [label, probs[i]])),
    };
  }
  const probs = normalise(q.criteria.map((level) => overlap(state, entryText(level))));
  return {
    type: 'score',
    score: probs.reduce((sum, p, level) => sum + p * level, 0),
    confidence: Math.max(...probs),
    legend: Object.fromEntries(q.criteria.map((level, i) => [i, level])),
    probabilities: Object.fromEntries(probs.map((p, i) => [i, p])),
  };
}

/** A `fetch` for `TypeSafeClient` that answers `POST /v1/systemone` locally. */
export const fakeJevFetch = async (_url: string, init?: RequestInit): Promise<Response> => {
  const body = JSON.parse(String(init?.body)) as {
    state: unknown;
    questions: Record<string, FakeQuestion>;
  };
  const state = tokens(isElements(body.state) ? content(body.state) : entryText(body.state));
  const answers = Object.fromEntries(
    Object.entries(body.questions).map(([name, q]) => [
      name,
      answer(state, q, isElements(body.state) ? body.state : undefined),
    ]),
  );
  return Response.json({
    model: 'fake-jev',
    answers,
    usage: { input_tokens: 0, output_tokens: 0 },
  });
};
