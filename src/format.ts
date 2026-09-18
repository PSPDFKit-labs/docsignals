import type { PageAnswer } from './jev.js';
import type { Bounds } from './pages.js';
import type { Extracted, RouteStep, RunResult, Sourced } from './run.js';

export type Format = 'table' | 'json' | 'csv';

const num = (n: number): string => n.toFixed(2);

const isLocated = (answer: PageAnswer | Sourced): answer is Sourced => 'page' in answer;

const boundsCell = (b: Bounds | undefined): string | undefined =>
  b && [b.x, b.y, b.width, b.height].join(' ');

function answerCell(answer: PageAnswer | Sourced): string {
  const where = isLocated(answer) ? ` (p.${answer.page})` : '';
  if (answer.type === 'noul') return `${num(answer.p)}${where}`;
  if (answer.type === 'choice') return `${answer.choice} ${num(answer.confidence)}${where}`;
  return `${num(answer.score)}${where}`;
}

function extractedCell(field: Extracted | undefined): string {
  if (!field || field.value === null) return '-';
  return field.supported === undefined ? field.value : `${field.value} [${num(field.supported)}]`;
}

function routeCell(steps: RouteStep[]): string {
  return steps
    .map((step) => {
      const where =
        step.via === 'case'
          ? (step.to as string).replace(/@[^@]*$/, '')
          : step.via === 'none'
            ? '-'
            : 'default';
      return step.lowConfidence ? `${where} (low ${num(step.confidence)})` : where;
    })
    .join(' > ');
}

const isRouted = (result: RunResult): boolean => result.rows.some((row) => row.route !== undefined);

function columns(result: RunResult): { questions: string[]; fields: string[] } {
  const questions = new Set<string>();
  const fields = new Set<string>();
  for (const row of result.rows) {
    for (const name of Object.keys(row.answers)) questions.add(name);
    for (const name of Object.keys(row.extracted)) fields.add(name);
  }
  return { questions: [...questions], fields: [...fields] };
}

function toTable(result: RunResult): string {
  const { questions, fields } = columns(result);
  const byPage = result.by === 'page';
  const routed = isRouted(result);
  const header = [
    'doc',
    ...(byPage ? ['page'] : []),
    ...(routed ? ['route'] : []),
    ...questions,
    ...fields,
  ];
  const body = result.rows.map((row) => [
    row.doc,
    ...(byPage ? [String(row.page)] : []),
    ...(routed ? [routeCell(row.route ?? [])] : []),
    ...questions.map((q) => (row.answers[q] ? answerCell(row.answers[q]) : '-')),
    ...fields.map((f) => extractedCell(row.extracted[f])),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]): string =>
    cells
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  return [line(header), line(widths.map((w) => '-'.repeat(w))), ...body.map(line)].join('\n');
}

function csvEscape(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toCsv(result: RunResult): string {
  const { questions, fields } = columns(result);
  const byPage = result.by === 'page';
  const types = new Map<string, PageAnswer['type']>();
  for (const row of result.rows)
    for (const [name, a] of Object.entries(row.answers)) types.set(name, a.type);

  const routed = isRouted(result);
  const header = ['doc', ...(byPage ? ['page'] : [])];
  // route_confidence is the weakest decision on a nested route; JSON output has every step.
  if (routed) header.push('route', 'route_confidence');
  for (const q of questions) {
    header.push(...(types.get(q) === 'noul' ? [`${q}_p`] : [q, `${q}_confidence`]));
    if (!byPage) header.push(`${q}_page`, `${q}_block`, `${q}_bounds`, `${q}_link`);
  }
  for (const f of fields)
    header.push(f, `${f}_page`, `${f}_block`, `${f}_bounds`, `${f}_link`, `${f}_supported`);

  const lines = result.rows.map((row) => {
    const cells: (string | number | null | undefined)[] = [row.doc, ...(byPage ? [row.page] : [])];
    if (routed) {
      const steps = row.route ?? [];
      cells.push(
        steps.map((step) => step.to ?? '').join(' > '),
        steps.length > 0 ? Math.min(...steps.map((step) => step.confidence)) : null,
      );
    }
    for (const q of questions) {
      const a = row.answers[q];
      if (a?.type === 'noul') cells.push(a.p);
      else if (a?.type === 'choice') cells.push(a.choice, a.confidence);
      else if (a?.type === 'score') cells.push(a.score, a.confidence);
      else cells.push(...(types.get(q) === 'noul' ? [null] : [null, null]));
      if (!byPage) {
        const located = a !== undefined && isLocated(a) ? a : undefined;
        const block = located?.block;
        cells.push(located?.page, block?.id, boundsCell(block?.bounds), block?.link);
      }
    }
    for (const f of fields) {
      const e = row.extracted[f];
      cells.push(
        e?.value,
        e?.page,
        e?.block?.id,
        boundsCell(e?.block?.bounds),
        e?.block?.link,
        e?.supported,
      );
    }
    return cells.map(csvEscape).join(',');
  });
  return [header.join(','), ...lines].join('\n');
}

export function formatResult(result: RunResult, format: Format): string {
  if (format === 'json') return JSON.stringify(result, null, 2);
  return format === 'csv' ? toCsv(result) : toTable(result);
}
