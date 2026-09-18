/**
 * Scores docsignals packs in eval/ against their recorded ground truth.
 *
 *   npx tsx eval/score.ts                                  # every category
 *   npx tsx eval/score.ts government-forms
 *   npx tsx eval/score.ts --fake                            # fake Jev; DWS extraction still runs for real
 *   npx tsx eval/score.ts --concurrency=1 --timeout=120000  # against tools/laya-server, a synchronous
 *                                                            # local server that answers one request at a
 *                                                            # time and can take well over the SDK's 10s
 *                                                            # default timeout on a busy page
 *
 * Needs NUTRIENT_EXTRACTION_API_KEY (extraction always runs for real; `--fake` only replaces
 * Jev) and, unless `--fake`, TYPESAFE_API_KEY. There is no recorded cache for these documents.
 */
import { readdir, readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { createJev, loadPack, runPack } from '../src/index.js';
import type { Extracted, Row } from '../src/run.js';

interface QuestionTruth {
  expected: boolean | string | number | null;
  evidence: string;
}

interface DocTruth {
  answers: Record<string, QuestionTruth>;
  extracted?: Record<string, QuestionTruth>;
}

interface GroundTruth {
  pack: string;
  documents: Record<string, DocTruth>;
}

interface Category {
  name: string;
  pack: string;
  documents: string;
  groundTruth: string;
}

const evalDir = import.meta.dirname;

const categories: Category[] = [
  {
    name: 'government-forms',
    pack: join(evalDir, 'packs/government-forms.yaml'),
    documents: join(evalDir, 'documents/government-forms'),
    groundTruth: join(evalDir, 'ground-truth/government-forms.json'),
  },
  {
    name: 'arxiv-papers',
    pack: join(evalDir, 'packs/arxiv-papers.yaml'),
    documents: join(evalDir, 'documents/arxiv-papers'),
    groundTruth: join(evalDir, 'ground-truth/arxiv-papers.json'),
  },
];

interface Verdict {
  question: string;
  doc: string;
  correct: boolean;
  expected: unknown;
  got: unknown;
  detail: string;
}

/** Squared error between a predicted probability and the true 0/1 outcome. Lower is better. */
function brier(p: number, truth: boolean): number {
  const y = truth ? 1 : 0;
  return (p - y) ** 2;
}

function normalize(value: string | null): string | null {
  return value === null ? null : value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Compares one document's answers and extracted fields against its ground truth. Pure: no I/O. */
export function scoreRow(row: Row, truth: DocTruth): Verdict[] {
  const verdicts: Verdict[] = [];

  for (const [question, expectedEntry] of Object.entries(truth.answers)) {
    const answer = row.answers[question];
    if (!answer) {
      verdicts.push({
        question,
        doc: row.doc,
        correct: false,
        expected: expectedEntry.expected,
        got: undefined,
        detail: 'pack produced no answer for this question',
      });
      continue;
    }

    if (answer.type === 'noul') {
      const expected = expectedEntry.expected as boolean;
      const predicted = answer.p >= 0.5;
      verdicts.push({
        question,
        doc: row.doc,
        correct: predicted === expected,
        expected,
        got: answer.p,
        detail: `p=${answer.p.toFixed(3)} brier=${brier(answer.p, expected).toFixed(3)}`,
      });
    } else if (answer.type === 'choice') {
      const expected = expectedEntry.expected as string;
      verdicts.push({
        question,
        doc: row.doc,
        correct: answer.choice === expected,
        expected,
        got: answer.choice,
        detail: `confidence=${answer.confidence.toFixed(3)}`,
      });
    } else if (answer.type === 'score') {
      const expected = expectedEntry.expected as number;
      const predicted = Math.round(answer.score);
      verdicts.push({
        question,
        doc: row.doc,
        correct: predicted === expected,
        expected,
        got: answer.score,
        detail: `score=${answer.score.toFixed(3)} |error|=${Math.abs(answer.score - expected).toFixed(3)}`,
      });
    }
  }

  for (const [field, expectedEntry] of Object.entries(truth.extracted ?? {})) {
    const extracted: Extracted | undefined = row.extracted[field];
    const expected = expectedEntry.expected as string | null;
    const got = extracted?.value ?? null;
    verdicts.push({
      question: `extract.${field}`,
      doc: row.doc,
      correct: normalize(got) === normalize(expected),
      expected,
      got,
      detail:
        extracted?.supported === undefined
          ? 'no verify probability'
          : `supported=${extracted.supported.toFixed(3)}`,
    });
  }

  return verdicts;
}

async function pdfFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  return entries.filter((f) => extname(f).toLowerCase() === '.pdf').map((f) => join(dir, f));
}

async function scoreCategory(
  category: Category,
  fake: boolean,
  concurrency: number | undefined,
  timeout: number | undefined,
): Promise<Verdict[]> {
  const pack = await loadPack(category.pack);
  const files = await pdfFiles(category.documents);
  const groundTruth = JSON.parse(await readFile(category.groundTruth, 'utf8')) as GroundTruth;

  const expectedPackId = groundTruth.pack;
  const actualPackId = `${pack.name}@${pack.version}`;
  if (expectedPackId !== actualPackId) {
    console.warn(
      `warning: ${category.name} ground truth was recorded for ${expectedPackId}, pack is now ${actualPackId}`,
    );
  }

  const { rows } = await runPack(pack, files, {
    fake,
    ...(concurrency ? { concurrency } : {}),
    jev: createJev({ fake, ...(timeout ? { timeout } : {}) }),
  });

  const verdicts: Verdict[] = [];
  for (const row of rows) {
    const truth = groundTruth.documents[row.doc];
    if (!truth) {
      console.warn(`warning: ${category.name}: no ground truth for ${row.doc}, skipping`);
      continue;
    }
    verdicts.push(...scoreRow(row, truth));
  }
  return verdicts;
}

function report(name: string, verdicts: Verdict[]): void {
  console.log(`\n${name}`);
  console.log('-'.repeat(name.length));
  for (const v of verdicts) {
    const mark = v.correct ? 'PASS' : 'FAIL';
    console.log(
      `  ${mark}  ${v.doc}  ${v.question}  expected=${JSON.stringify(v.expected)} got=${JSON.stringify(v.got)}  ${v.detail}`,
    );
  }
  const correct = verdicts.filter((v) => v.correct).length;
  const total = verdicts.length;
  const pct = total === 0 ? 0 : (100 * correct) / total;
  console.log(`  ${correct}/${total} correct (${pct.toFixed(0)}%)`);
}

/** Reads `--<name>=<positive number>` from argv, or throws if the value isn't one. */
function numberFlag(args: string[], name: string): number | undefined {
  const flag = args.find((a) => a.startsWith(`--${name}=`));
  if (!flag) return undefined;
  const value = Number(flag.slice(`--${name}=`.length));
  if (!value || value < 1) throw new Error(`--${name} must be a positive number, got "${flag}"`);
  return value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const fake = args.includes('--fake');
  const concurrency = numberFlag(args, 'concurrency');
  const timeout = numberFlag(args, 'timeout');
  const requested = args.filter((a) => !a.startsWith('--'));
  const selected =
    requested.length === 0 ? categories : categories.filter((c) => requested.includes(c.name));

  if (selected.length === 0) {
    throw new Error(
      `no matching category. Known categories: ${categories.map((c) => c.name).join(', ')}`,
    );
  }

  let allVerdicts: Verdict[] = [];
  for (const category of selected) {
    const verdicts = await scoreCategory(category, fake, concurrency, timeout);
    report(category.name, verdicts);
    allVerdicts = allVerdicts.concat(verdicts);
  }

  if (selected.length > 1) {
    report('overall', allVerdicts);
  }

  if (allVerdicts.some((v) => !v.correct)) {
    process.exitCode = 1;
  }
}

if (basename(process.argv[1] ?? '') === 'score.ts') {
  await main();
}
