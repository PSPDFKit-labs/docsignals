import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';

const EXAMPLES = join(import.meta.dirname, '..', 'examples');
const invoices = [
  'run',
  join(EXAMPLES, 'packs', 'invoices.yaml'),
  join(EXAMPLES, 'documents', 'invoices', 'invoice-1042.pdf'),
  join(EXAMPLES, 'documents', 'invoices', 'invoice-1043.pdf'),
  '--fake',
  '--cache-dir',
  join(EXAMPLES, 'cache'),
];

async function run(argv: string[]): Promise<string> {
  const lines: string[] = [];
  await main(argv, (text) => lines.push(text));
  return lines.join('\n');
}

describe('docsignals CLI', () => {
  it('prints a table by default', async () => {
    const out = await run(invoices);
    const [header, rule, ...rows] = out.split('\n');
    expect(header).toMatch(/^doc\s+doc_type\s+is_overdue\s+invoice_number\s+due_date\s+total_due$/);
    expect(rule).toMatch(/^-+( {2}-+)+$/);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatch(/^invoice-1043\.pdf\s+invoice 0\.\d\d \(p\.1\).*INV-1043 \[0\.\d\d\]/);
  });

  it('prints CSV with one column group per question and field', async () => {
    const [header, first] = (await run([...invoices, '--format', 'csv'])).split('\n');
    expect(header).toBe(
      'doc,doc_type,doc_type_confidence,doc_type_page,doc_type_block,doc_type_bounds,doc_type_link,' +
        'is_overdue_p,is_overdue_page,is_overdue_block,is_overdue_bounds,is_overdue_link,' +
        'invoice_number,invoice_number_page,invoice_number_block,invoice_number_bounds,invoice_number_link,' +
        'invoice_number_supported,due_date,due_date_page,due_date_block,due_date_bounds,due_date_link,' +
        'due_date_supported,total_due,total_due_page,total_due_block,total_due_bounds,total_due_link,' +
        'total_due_supported',
    );
    expect(first).toMatch(/INV-1042,1,[0-9a-f-]{36},[\d.]+ [\d.]+ [\d.]+ [\d.]+,/);
    expect(first).toContain('INV-1042,1,');
    expect(first).toContain('"USD 13,760.00"');
  });

  it('prints JSON that round-trips', async () => {
    const parsed = JSON.parse(await run([...invoices, '--format', 'json']));
    expect(parsed).toMatchObject({ pack: 'invoices@1.0.0', by: 'document' });
    expect(parsed.rows).toHaveLength(2);
  });

  it('routes a mixed folder and prefixes the routed columns', async () => {
    const out = await run([
      'run',
      join(EXAMPLES, 'packs', 'intake.yaml'),
      join(EXAMPLES, 'documents', 'invoices', 'invoice-1042.pdf'),
      join(EXAMPLES, 'documents', 'contracts', 'nda-brightwater-corvane.pdf'),
      '--fake',
      '--cache-dir',
      join(EXAMPLES, 'cache'),
    ]);
    const [header, , first, second] = out.split('\n');
    expect(header).toMatch(/^doc\s+route\s+doc_type\s+invoices\.doc_type\s+invoices\.is_overdue/);
    expect(header).toContain('contracts.governing_law');
    expect(first).toMatch(/^invoice-1042\.pdf\s+invoices\s+invoice 0\.\d\d/);
    expect(second).toMatch(
      /^nda-brightwater-corvane\.pdf\s+contracts\s.*delaware 0\.\d\d \(p\.2\)/,
    );
  });

  it('validates a routing pack and prints the route tree', async () => {
    const out = await run(['validate', join(EXAMPLES, 'packs', 'intake.yaml')]);
    expect(out).toContain('  route on doc_type:');
    expect(out).toContain('    invoice -> invoices@1.0.0, columns "invoices.*"');
    expect(out).toContain('      extract:   invoice_number, due_date, total_due');
    expect(out).toContain('    default -> no further questions');
  });

  it('validates a pack and lists what it asks', async () => {
    const out = await run(['validate', join(EXAMPLES, 'packs', 'contracts.yaml')]);
    expect(out).toContain('contracts@1.0.0 is valid (mode: agentic)');
    expect(out).toContain('governing_law');
  });

  it('prints the elements of each page, as Jev is asked of them', async () => {
    const out = await run([
      'pages',
      join(EXAMPLES, 'documents', 'contracts', 'nda-brightwater-corvane.pdf'),
      '--cache-dir',
      join(EXAMPLES, 'cache'),
    ]);
    expect(out).toContain('--- page 2 ---');
    expect(out).toContain('"role": "Title"');
    expect(out).toContain('"bounds"');
    expect(out).toContain('State of Delaware');
  });

  it('accepts a concurrency and a timeout, and gives the same answers', async () => {
    expect(await run([...invoices, '--concurrency', '1', '--timeout', '120000'])).toBe(
      await run(invoices),
    );
  });

  it('refuses a concurrency or a timeout that is not a positive whole number', async () => {
    await expect(run([...invoices, '--concurrency', '0'])).rejects.toThrow(/--concurrency/);
    await expect(run([...invoices, '--timeout', 'soon'])).rejects.toThrow(/--timeout/);
  });

  it('shows usage with no command', async () => {
    expect(await run([])).toContain('Usage:');
  });

  it.each([
    [['run'], /usage: docsignals run/],
    [['frobnicate'], /unknown command "frobnicate"/],
    [[...invoices, '--format', 'xml'], /--format must be one of: table, json, csv/],
    [[...invoices, '--by', 'chapter'], /--by must be one of: document, page/],
  ])('rejects %j', async (argv, message) => {
    await expect(run(argv)).rejects.toThrow(message);
  });
});
