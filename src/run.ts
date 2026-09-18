import { basename, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaultCacheDir, extractPages, type Parser } from './extract.js';
import { createJev, type Jev, type PageAnswer } from './jev.js';
import { MAX_CHOICE_LABELS, type Pack, type Question, type RouteTarget } from './pack.js';
import type { Block, Page } from './pages.js';
import { type Located, reduceAnswers } from './reduce.js';

export interface Extracted {
  value: string | null;
  page: number | null;
  /** The DWS element the value was read from. Null when the field was not found. */
  block: SourceBlock | null;
  /** How the value was read. Null when the field was not found. */
  source: 'key_value_region' | 'text_line' | null;
  /** DWS confidence that the key and value belong together, when reported. */
  confidence: number | null;
  /** Jev's probability that the page supports the value. Present when the field sets `verify`. */
  supported?: number;
}

/** A DWS element an answer or a value came from. `bounds` is in the units of the page size. */
export interface SourceBlock extends Block {
  /** Opens the PDF at the block. Null when the document is not a PDF. */
  link: string | null;
}

/** The block of the deciding page that Jev chose as the source of an answer. */
export interface AnswerBlock extends SourceBlock {
  /** Jev's probability for this block, against every other block of the page and "none". */
  confidence: number;
}

// DWS reports bounds in pixels of a 200 DPI page image; a PDF open parameter is in points.
const POINTS_PER_PIXEL = 72 / 200;

/** `zoom=scale,left,top` is the one open parameter Chromium's viewer scrolls to; it ignores `viewrect`. */
function blockLink(file: string, page: number, bounds: Block['bounds']): string | null {
  if (extname(file).toLowerCase() !== '.pdf') return null;
  const top = Math.round(bounds.y * POINTS_PER_PIXEL);
  return `${pathToFileURL(file).href}#page=${page}&zoom=100,0,${top}`;
}

/** A document answer, the page that decided it, and the block on that page. Null when the page affirms nothing, or Jev chose no block. */
export type Sourced = Located & { block: AnswerBlock | null };

/** One routing decision. A document that goes through nested routes has one step per level. */
export interface RouteStep {
  /** Column name of the question that selected the route. */
  on: string;
  choice: string;
  confidence: number;
  /** `name@version` of the pack the document went to. Null when no case or default applied. */
  to: string | null;
  via: 'case' | 'default' | 'none';
  /** True when `confidence` was under the route's `min_confidence`, so the case was not used. */
  lowConfidence: boolean;
}

export interface Row {
  doc: string;
  /** Present when rows are per page. */
  page?: number;
  /** Columns from a routed pack are named `<prefix>.<name>`. */
  answers: Record<string, PageAnswer | Sourced>;
  extracted: Record<string, Extracted>;
  /** Present when the pack has a route. The decision is per document, also when rows are per page. */
  route?: RouteStep[];
}

export interface RunOptions {
  by?: 'document' | 'page';
  cacheDir?: string;
  fake?: boolean;
  concurrency?: number;
  parser?: Parser;
  jev?: Jev;
}

export interface RunResult {
  pack: string;
  by: 'document' | 'page';
  rows: Row[];
}

const VERIFY_PREFIX = '__verify_';
const normalise = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, '');

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function findFields(pack: Pack, file: string, page: Page): Record<string, Extracted> {
  const found: Record<string, Extracted> = {};
  for (const [name, field] of Object.entries(pack.extract)) {
    const wanted = field.keys.map(normalise);
    const hit = page.keyValues.find((kv) => wanted.includes(normalise(kv.key)));
    if (hit) {
      found[name] = {
        value: hit.value,
        page: page.page,
        block: { ...hit.block, link: blockLink(file, page.page, hit.block.bounds) },
        source: hit.source,
        confidence: hit.confidence,
      };
    }
  }
  return found;
}

function verifyQuestions(pack: Pack, found: Record<string, Extracted>): Record<string, Question> {
  const questions: Record<string, Question> = {};
  for (const [name, hit] of Object.entries(found)) {
    const field = pack.extract[name];
    if (!field?.verify) continue;
    questions[`${VERIFY_PREFIX}${name}`] = {
      noul: `The ${field.keys[0]} is "${hit.value}".`,
      reduce: 'max',
    };
  }
  return questions;
}

interface PageResult {
  page: number;
  answers: Record<string, PageAnswer>;
  extracted: Record<string, Extracted>;
}

async function askPage(pack: Pack, file: string, page: Page, jev: Jev): Promise<PageResult> {
  const extracted = findFields(pack, file, page);
  const questions = { ...pack.questions, ...verifyQuestions(pack, extracted) };
  const all = Object.keys(questions).length > 0 ? await jev.ask(page.elements, questions) : {};

  const answers: Record<string, PageAnswer> = {};
  for (const [name, answer] of Object.entries(all)) {
    if (!name.startsWith(VERIFY_PREFIX)) {
      answers[name] = answer;
      continue;
    }
    const field = extracted[name.slice(VERIFY_PREFIX.length)];
    if (field && answer.type === 'noul') field.supported = answer.p;
  }
  return { page: page.page, answers, extracted };
}

interface Document {
  doc: string;
  file: string;
  pages: Page[];
}

/** Everything asked of one document so far, with column names already prefixed. */
interface Asked {
  pages: PageResult[];
  questions: Record<string, Question>;
  fields: string[];
  route: RouteStep[];
}

const prefixKeys = <T>(prefix: string, record: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.entries(record).map(([key, value]) => [`${prefix}${key}`, value]));

function locate(pages: PageResult[], name: string): Located[] {
  return pages.map((p) => ({ ...(p.answers[name] as PageAnswer), page: p.page }));
}

function selectTarget(
  pack: Pack,
  prefix: string,
  asked: Asked,
): { step: RouteStep; target: RouteTarget | undefined } {
  const route = pack.route as NonNullable<Pack['route']>;
  const on = `${prefix}${route.on}`;
  const answer = reduceAnswers(asked.questions[on] as Question, locate(asked.pages, on));
  if (answer.type !== 'choice') throw new Error(`route question "${on}" did not return a choice`);

  const lowConfidence =
    route.minConfidence !== undefined && answer.confidence < route.minConfidence;
  const matched = lowConfidence ? undefined : route.cases[answer.choice];
  const target = matched ?? route.default;
  return {
    target,
    step: {
      on,
      choice: answer.choice,
      confidence: answer.confidence,
      to: target ? `${target.pack.name}@${target.pack.version}` : null,
      via: matched ? 'case' : target ? 'default' : 'none',
      lowConfidence,
    },
  };
}

/** Asks a pack of every document, then sends each document down the pack's route, if it has one. */
async function askDocuments(
  pack: Pack,
  documents: Document[],
  prefix: string,
  jev: Jev,
  concurrency: number,
): Promise<Asked[]> {
  const jobs = documents.flatMap(({ file, pages }, index) =>
    pages.map((page) => ({ index, file, page })),
  );
  const results = await mapLimit(jobs, concurrency, async ({ index, file, page }) => ({
    index,
    result: await askPage(pack, file, page, jev),
  }));

  const asked = documents.map(
    (_, index): Asked => ({
      pages: results
        .filter((r) => r.index === index)
        .map(({ result }) => ({
          page: result.page,
          answers: prefixKeys(prefix, result.answers),
          extracted: prefixKeys(prefix, result.extracted),
        })),
      questions: prefixKeys(prefix, pack.questions),
      fields: Object.keys(pack.extract).map((name) => `${prefix}${name}`),
      route: [],
    }),
  );
  if (pack.route === undefined) return asked;

  const groups = new Map<RouteTarget, number[]>();
  asked.forEach((entry, index) => {
    const { step, target } = selectTarget(pack, prefix, entry);
    entry.route.push(step);
    if (target) groups.set(target, [...(groups.get(target) ?? []), index]);
  });

  for (const [target, indexes] of groups) {
    const routed = await askDocuments(
      target.pack,
      indexes.map((index) => documents[index] as Document),
      `${prefix}${target.prefix}.`,
      jev,
      concurrency,
    );
    routed.forEach((child, i) => {
      const parent = asked[indexes[i] as number] as Asked;
      parent.pages.forEach((page, p) => {
        Object.assign(page.answers, child.pages[p]?.answers);
        Object.assign(page.extracted, child.pages[p]?.extracted);
      });
      Object.assign(parent.questions, child.questions);
      parent.fields.push(...child.fields);
      parent.route.push(...child.route);
    });
  }
  return asked;
}

const NO_BLOCK = 'none';

/**
 * What the deciding page affirms, in words a block can be matched against. Null when the page
 * affirms nothing: it denies the statement, or the answer is the label for "not stated here".
 * No block is the source of an absence, so none is looked for.
 */
function claim(question: Question, document: Located, page: PageAnswer): string | null {
  const ask = 'ask' in question && question.ask ? `${question.ask} ` : '';
  if ('noul' in question && page.type === 'noul') return page.p >= 0.5 ? question.noul : null;
  if ('choice' in question && document.type === 'choice') {
    if (document.choice === question.fallback) return null;
    const description = question.choice[document.choice];
    return description ? `${ask}${document.choice}: ${description}` : `${ask}${document.choice}`;
  }
  if ('score' in question && page.type === 'score') {
    return `${ask}${question.score[Math.round(page.score)]}`;
  }
  throw new Error(`a "${page.type}" answer does not fit its question`);
}

type Job = () => Promise<void>;

/**
 * Plans the requests that ask Jev which block of the deciding page supports each answer the page
 * affirms: at most one per deciding page, with the elements as the state and their ids as the
 * labels of a choice. Each job fills in `block` on the answers it returns here.
 */
function sourceAnswers(
  { file, pages }: Document,
  asked: Asked,
  answers: Record<string, Located>,
  jev: Jev,
): { sourced: Record<string, Sourced>; jobs: Job[] } {
  const byPage = new Map<number, Map<string, string>>();
  for (const [name, answer] of Object.entries(answers)) {
    const decided = asked.pages.find((p) => p.page === answer.page)?.answers[name];
    if (!decided) throw new Error(`page ${answer.page} has no answer to "${name}"`);
    const claimed = claim(asked.questions[name] as Question, answer, decided);
    if (claimed === null) continue;
    byPage.set(answer.page, (byPage.get(answer.page) ?? new Map()).set(name, claimed));
  }

  const sourced: Record<string, Sourced> = Object.fromEntries(
    Object.entries(answers).map(([name, answer]) => [name, { ...answer, block: null }]),
  );
  const jobs = [...byPage.entries()].map(
    ([number, claims]): Job =>
      async () => {
        const page = pages.find((p) => p.page === number);
        if (!page) throw new Error(`an answer names page ${number}, which was not extracted`);
        const blocks = new Map(page.elements.map((el) => [el.id, el]));
        if (blocks.size + 1 > MAX_CHOICE_LABELS) {
          throw new Error(
            `${file}: page ${number} has ${blocks.size} elements, and the block question allows ` +
              `${MAX_CHOICE_LABELS - 1}, one label per element plus "${NO_BLOCK}"`,
          );
        }

        const labels = {
          ...Object.fromEntries([...blocks.keys()].map((id) => [id, `The element with id ${id}`])),
          [NO_BLOCK]: 'No element supports the statement',
        };
        const questions: Record<string, Question> = Object.fromEntries(
          [...claims].map(([name, claimed]) => [
            name,
            {
              ask: `Which element supports this statement? ${claimed}`,
              choice: labels,
              reduce: 'top_page',
            },
          ]),
        );
        const found = await jev.ask(page.elements, questions);

        for (const name of claims.keys()) {
          const answer = found[name];
          if (answer?.type !== 'choice')
            throw new Error(`Jev did not choose a block for "${name}"`);
          if (answer.choice === NO_BLOCK) continue;
          const block = blocks.get(answer.choice);
          if (!block) {
            throw new Error(
              `Jev chose "${answer.choice}" for "${name}", which is not an element of page ${number}`,
            );
          }
          (sourced[name] as Sourced).block = {
            id: block.id,
            bounds: block.bounds,
            link: blockLink(file, number, block.bounds),
            confidence: answer.confidence,
          };
        }
      },
  );
  return { sourced, jobs };
}

function toDocumentRow(
  document: Document,
  asked: Asked,
  jev: Jev,
): { row: Omit<Row, 'route'>; jobs: Job[] } {
  const reduced: Record<string, Located> = {};
  for (const [name, question] of Object.entries(asked.questions)) {
    reduced[name] = reduceAnswers(question, locate(asked.pages, name));
  }
  const { sourced: answers, jobs } = sourceAnswers(document, asked, reduced, jev);
  const extracted: Record<string, Extracted> = {};
  for (const name of asked.fields) {
    const first = asked.pages.find((p) => p.extracted[name])?.extracted[name];
    extracted[name] = first ?? {
      value: null,
      page: null,
      block: null,
      source: null,
      confidence: null,
    };
  }
  return { row: { doc: document.doc, answers, extracted }, jobs };
}

/**
 * Runs a pack over documents: extract (cached) → ask Jev per page → reduce per document →
 * ask each deciding page which block supports the answer.
 * A pack with a route then asks the routed pack of the same, already extracted, pages.
 */
export async function runPack(
  pack: Pack,
  files: string[],
  options: RunOptions = {},
): Promise<RunResult> {
  if (files.length === 0) throw new Error('no documents given');
  const by = options.by ?? 'document';
  const jev = options.jev ?? createJev({ fake: options.fake ?? false });
  const cacheDir = options.cacheDir ?? defaultCacheDir();
  const concurrency = options.concurrency ?? 8;

  const documents = await mapLimit(files, concurrency, async (file): Promise<Document> => {
    const pages = await extractPages(file, {
      mode: pack.mode,
      cacheDir,
      ...(options.parser ? { parser: options.parser } : {}),
    });
    if (pages.length === 0) throw new Error(`${file}: extraction returned no pages`);
    return { doc: basename(file), file, pages };
  });

  const asked = await askDocuments(pack, documents, '', jev, concurrency);

  const rows: Row[] = [];
  const blockJobs: Job[] = [];
  for (const [index, document] of documents.entries()) {
    const entry = asked[index] as Asked;
    const route = pack.route ? { route: entry.route } : {};
    if (by === 'page') {
      for (const p of entry.pages) {
        rows.push({
          doc: document.doc,
          page: p.page,
          answers: p.answers,
          extracted: p.extracted,
          ...route,
        });
      }
    } else {
      const { row, jobs } = toDocumentRow(document, entry, jev);
      rows.push({ ...row, ...route });
      blockJobs.push(...jobs);
    }
  }
  await mapLimit(blockJobs, concurrency, (job) => job());
  return { pack: `${pack.name}@${pack.version}`, by, rows };
}
