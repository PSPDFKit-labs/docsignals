import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { extractPages, type Parser } from '../src/extract.js';
import { createJev, type Jev, type State } from '../src/jev.js';
import { loadPack, type Question } from '../src/pack.js';
import { runPack, type Sourced } from '../src/run.js';

const EXAMPLES = join(import.meta.dirname, '..', 'examples');
const contract = (name: string) => join(EXAMPLES, 'documents', 'contracts', name);
const invoice = (name: string) => join(EXAMPLES, 'documents', 'invoices', name);
const recorded = { fake: true, cacheDir: join(EXAMPLES, 'cache') };

const isBlockRequest = (questions: Record<string, Question>): boolean =>
  Object.values(questions).every((q) => 'ask' in q && q.ask?.startsWith('Which element'));

describe('runPack on the recorded examples', () => {
  it('finds each contract’s governing law and the page that states it', async () => {
    const pack = await loadPack(join(EXAMPLES, 'packs', 'contracts.yaml'));
    const { rows, pack: label } = await runPack(
      pack,
      ['msa-northwind-halden.pdf', 'nda-brightwater-corvane.pdf', 'consulting-pellucid.pdf'].map(
        contract,
      ),
      recorded,
    );
    expect(label).toBe('contracts@1.0.0');
    expect(rows.map((r) => [r.doc, r.answers.governing_law])).toEqual([
      ['msa-northwind-halden.pdf', expect.objectContaining({ choice: 'new_york', page: 3 })],
      ['nda-brightwater-corvane.pdf', expect.objectContaining({ choice: 'delaware', page: 2 })],
      ['consulting-pellucid.pdf', expect.objectContaining({ choice: 'california', page: 3 })],
    ]);
  });

  it('extracts and verifies invoice fields', async () => {
    const pack = await loadPack(join(EXAMPLES, 'packs', 'invoices.yaml'));
    const { rows } = await runPack(pack, [invoice('invoice-1043.pdf')], recorded);
    expect(rows[0]?.extracted).toEqual({
      invoice_number: expect.objectContaining({ value: 'INV-1043', page: 1, source: 'text_line' }),
      due_date: expect.objectContaining({ value: 'February 27, 2026' }),
      total_due: expect.objectContaining({ value: 'USD 19,529.11' }),
    });
    expect(rows[0]?.extracted.invoice_number?.supported).toBeGreaterThan(0.9);
  });

  it('returns one row per page with --by page, without page provenance', async () => {
    const pack = await loadPack(join(EXAMPLES, 'packs', 'contracts.yaml'));
    const { rows } = await runPack(pack, [contract('nda-brightwater-corvane.pdf')], {
      ...recorded,
      by: 'page',
    });
    expect(rows.map((r) => r.page)).toEqual([1, 2]);
    expect(rows[0]?.answers.is_signed).not.toHaveProperty('page');
  });
});

describe('runPack routing', () => {
  const PACKS = join(EXAMPLES, 'packs');
  const mixed = [invoice('invoice-1042.pdf'), contract('consulting-pellucid.pdf')];

  async function routerPack(route: string): Promise<string> {
    const path = join(await mkdtemp(join(tmpdir(), 'docsignals-route-')), 'router.yaml');
    await writeFile(
      path,
      `name: router\nversion: 1.0.0\nquestions:\n  kind:\n    use: std#doc_type\nroute:\n  on: kind\n${route}`,
    );
    return path;
  }

  it('asks each document the questions of the pack its type routes to', async () => {
    const pack = await loadPack(join(PACKS, 'intake.yaml'));
    const { rows } = await runPack(pack, mixed, recorded);

    expect(Object.keys(rows[0]?.answers ?? {})).toEqual([
      'doc_type',
      'invoices.doc_type',
      'invoices.is_overdue',
    ]);
    expect(rows[0]?.extracted['invoices.invoice_number']).toMatchObject({ value: 'INV-1042' });
    expect(rows[0]?.extracted['invoices.invoice_number']?.supported).toBeGreaterThan(0.9);
    expect(rows[0]?.route).toEqual([
      {
        on: 'doc_type',
        choice: 'invoice',
        confidence: expect.any(Number),
        to: 'invoices@1.0.0',
        via: 'case',
        lowConfidence: false,
      },
    ]);

    expect(rows[1]?.answers['contracts.governing_law']).toMatchObject({
      choice: 'california',
      page: 3,
    });
    expect(rows[1]?.extracted).toEqual({});
    expect(rows[1]?.route?.[0]).toMatchObject({ to: 'contracts@1.0.0' });
  });

  it('asks a routed question only of the documents routed to it', async () => {
    const fake = createJev({ fake: true });
    const asked: string[][] = [];
    const jev: Jev = {
      ask: (state, questions) => {
        if (!isBlockRequest(questions)) asked.push(Object.keys(questions));
        return fake.ask(state, questions);
      },
    };
    const pack = await loadPack(join(PACKS, 'intake.yaml'));
    await runPack(pack, mixed, { ...recorded, jev });

    const pageCount = { invoice: 1, contract: 3 };
    expect(asked.filter((names) => names.includes('is_overdue'))).toHaveLength(pageCount.invoice);
    expect(asked.filter((names) => names.includes('governing_law'))).toHaveLength(
      pageCount.contract,
    );
    expect(asked).toHaveLength(2 * (pageCount.invoice + pageCount.contract));
  });

  it('asks one block question per deciding page, with the blocks as the state', async () => {
    const fake = createJev({ fake: true });
    const requests: { state: State; block: boolean }[] = [];
    const jev: Jev = {
      ask: (state, questions) => {
        requests.push({ state, block: isBlockRequest(questions) });
        return fake.ask(state, questions);
      },
    };
    const pack = await loadPack(join(EXAMPLES, 'packs', 'contracts.yaml'));
    const file = contract('nda-brightwater-corvane.pdf');
    const { rows } = await runPack(pack, [file], { ...recorded, jev });

    const pages = await extractPages(file, { mode: 'agentic', ...recorded });
    const deciding = new Set(
      Object.values(rows[0]?.answers ?? {})
        .filter((a) => (a as Sourced).block !== null)
        .map((a) => (a as Sourced).page),
    );
    expect(requests).toHaveLength(pages.length + deciding.size);
    expect(requests.filter((r) => r.block).map((r) => r.state)).toEqual(
      pages.filter((p) => deciding.has(p.page)).map((p) => p.elements),
    );
  });

  it('names the block that states the governing law', async () => {
    const pack = await loadPack(join(EXAMPLES, 'packs', 'contracts.yaml'));
    const file = contract('nda-brightwater-corvane.pdf');
    const { rows } = await runPack(pack, [file], recorded);
    const law = rows[0]?.answers.governing_law as Sourced;
    const pages = await extractPages(file, { mode: 'agentic', ...recorded });
    const block = pages[law.page - 1]?.elements.find((el) => el.id === law.block?.id);

    expect(block).toMatchObject({ text: expect.stringMatching(/Delaware/) });
    expect(law.block).toMatchObject({ bounds: block?.bounds, confidence: expect.any(Number) });
    expect(law.block?.link).toBe(`${pathToFileURL(file).href}#page=2&zoom=100,0,153`);
  });

  it('looks for no block when the deciding page affirms nothing', async () => {
    const blockQuestions: string[][] = [];
    const jev: Jev = {
      ask: async (_state, questions) => {
        if (isBlockRequest(questions)) {
          blockQuestions.push(Object.keys(questions));
          throw new Error('no block question is expected');
        }
        return {
          governing_law: {
            type: 'choice',
            choice: 'other',
            confidence: 0.9,
            probabilities: { other: 0.9 },
          },
          termination_for_convenience: { type: 'noul', p: 0.49 },
        };
      },
    };
    const pack = await loadPack(join(EXAMPLES, 'packs', 'quickstart.yaml'));
    const { rows } = await runPack(pack, [contract('nda-brightwater-corvane.pdf')], {
      ...recorded,
      jev,
    });
    expect(blockQuestions).toEqual([]);
    expect(rows[0]?.answers.governing_law).toMatchObject({ choice: 'other', block: null });
    expect(rows[0]?.answers.termination_for_convenience).toMatchObject({ p: 0.49, block: null });
  });

  it('asks the block question only for the answers a page affirms', async () => {
    const fake = createJev({ fake: true });
    const blockQuestions: string[][] = [];
    const jev: Jev = {
      ask: async (state, questions) => {
        if (isBlockRequest(questions)) {
          blockQuestions.push(Object.keys(questions));
          return fake.ask(state, questions);
        }
        return {
          governing_law: {
            type: 'choice',
            choice: 'other',
            confidence: 0.9,
            probabilities: { other: 0.9 },
          },
          termination_for_convenience: { type: 'noul', p: 0.5 },
        };
      },
    };
    const pack = await loadPack(join(EXAMPLES, 'packs', 'quickstart.yaml'));
    const { rows } = await runPack(pack, [contract('nda-brightwater-corvane.pdf')], {
      ...recorded,
      jev,
    });
    expect(blockQuestions).toEqual([['termination_for_convenience']]);
    expect(rows[0]?.answers.termination_for_convenience).toMatchObject({
      block: { id: expect.any(String) },
    });
  });

  it('rejects a block label that is not an element of the page', async () => {
    const fake = createJev({ fake: true });
    const jev: Jev = {
      ask: async (state, questions) => {
        if (!isBlockRequest(questions)) return fake.ask(state, questions);
        return Object.fromEntries(
          Object.keys(questions).map((name) => [
            name,
            { type: 'choice', choice: 'el-7', confidence: 0.9, probabilities: { 'el-7': 0.9 } },
          ]),
        );
      },
    };
    const pack = await loadPack(join(EXAMPLES, 'packs', 'quickstart.yaml'));
    await expect(
      runPack(pack, [contract('nda-brightwater-corvane.pdf')], { ...recorded, jev }),
    ).rejects.toThrow(/Jev chose "el-7" for "governing_law", which is not an element of page 2/);
  });

  it('runs the block questions of different documents at the same time', async () => {
    const fake = createJev({ fake: true });
    let running = 0;
    let most = 0;
    const jev: Jev = {
      ask: async (state, questions) => {
        if (!isBlockRequest(questions)) return fake.ask(state, questions);
        most = Math.max(most, ++running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running--;
        return fake.ask(state, questions);
      },
    };
    const pack = await loadPack(join(EXAMPLES, 'packs', 'quickstart.yaml'));
    const files = ['msa-northwind-halden.pdf', 'nda-brightwater-corvane.pdf'].map(contract);
    await runPack(pack, files, { ...recorded, jev, concurrency: 4 });
    expect(most).toBeGreaterThan(1);
  });

  it('leaves a choice label with no description out of the block question', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'docsignals-cache-'));
    const packPath = join(cacheDir, 'bare.yaml');
    await writeFile(
      packPath,
      'name: bare\nversion: 1.0.0\nquestions:\n  kind:\n    choice:\n      contract:\n      invoice:\n',
    );
    const asks: (string | undefined)[] = [];
    const fake = createJev({ fake: true });
    const jev: Jev = {
      ask: (state, questions) => {
        if (isBlockRequest(questions)) {
          asks.push(...Object.values(questions).map((q) => ('ask' in q ? q.ask : undefined)));
        }
        return fake.ask(state, questions);
      },
    };
    await runPack(await loadPack(packPath), [contract('nda-brightwater-corvane.pdf')], {
      ...recorded,
      jev,
    });
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatch(/^Which element supports this statement\? (contract|invoice)$/);
  });

  it('reports no block when Jev chooses "none"', async () => {
    const fake = createJev({ fake: true });
    const jev: Jev = {
      ask: async (state, questions) => {
        if (!isBlockRequest(questions)) return fake.ask(state, questions);
        return Object.fromEntries(
          Object.keys(questions).map((name) => [
            name,
            { type: 'choice', choice: 'none', confidence: 0.9, probabilities: { none: 0.9 } },
          ]),
        );
      },
    };
    const pack = await loadPack(join(EXAMPLES, 'packs', 'contracts.yaml'));
    const { rows } = await runPack(pack, [contract('nda-brightwater-corvane.pdf')], {
      ...recorded,
      jev,
    });
    expect(rows[0]?.answers.governing_law).toMatchObject({ page: 2, block: null });
  });

  it('sends a document under min_confidence to the default', async () => {
    const path = await routerPack(
      `  min_confidence: 0.5\n  cases:\n    invoice: ${PACKS}/invoices.yaml\n    contract: ${PACKS}/contracts.yaml\n  default:\n    questions:\n      signed:\n        noul: It is signed.\n`,
    );
    const { rows } = await runPack(await loadPack(path), mixed, recorded);
    expect(rows[0]?.route?.[0]).toMatchObject({ via: 'case', lowConfidence: false });
    expect(rows[1]?.route?.[0]).toMatchObject({
      choice: 'contract',
      to: 'router/default@1.0.0',
      via: 'default',
      lowConfidence: true,
    });
    expect(Object.keys(rows[1]?.answers ?? {})).toEqual(['kind', 'default.signed']);
  });

  it('asks nothing more when no case or default applies', async () => {
    const path = await routerPack(`  cases:\n    invoice: ${PACKS}/invoices.yaml\n`);
    const { rows } = await runPack(await loadPack(path), mixed, recorded);
    expect(rows[1]?.route).toEqual([expect.objectContaining({ to: null, via: 'none' })]);
    expect(Object.keys(rows[1]?.answers ?? {})).toEqual(['kind']);
  });

  it('follows a route inside a routed pack and chains the prefixes', async () => {
    const path = await routerPack(
      `  cases:\n    invoice:\n      questions:\n        again:\n          use: std#doc_type\n      route:\n        on: again\n        cases:\n          invoice:\n            questions:\n              overdue:\n                noul: It is overdue.\n`,
    );
    const { rows } = await runPack(await loadPack(path), [mixed[0] as string], recorded);
    expect(Object.keys(rows[0]?.answers ?? {})).toEqual([
      'kind',
      'invoice.again',
      'invoice.invoice.overdue',
    ]);
    expect(rows[0]?.route?.map((step) => [step.on, step.to])).toEqual([
      ['kind', 'router/invoice@1.0.0'],
      ['invoice.again', 'router/invoice/invoice@1.0.0'],
    ]);
  });

  it('routes per document when rows are per page', async () => {
    const pack = await loadPack(join(PACKS, 'intake.yaml'));
    const { rows } = await runPack(pack, [contract('nda-brightwater-corvane.pdf')], {
      ...recorded,
      by: 'page',
    });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.answers['contracts.governing_law']).not.toHaveProperty('page');
      expect(row.route?.[0]).toMatchObject({ to: 'contracts@1.0.0' });
    }
  });
});

describe('runPack extraction', () => {
  const element = (pageNumber: number, text: string) => ({
    type: 'paragraph',
    id: `el-${pageNumber}`,
    bounds: { x: 1, y: 2, width: 3, height: 4 },
    text,
    readingOrder: 0,
    confidence: 1,
    page: { pageNumber, width: 612, height: 792 },
  });

  it('calls the parser once per document, then reads the cache', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'docsignals-cache-'));
    const file = join(cacheDir, 'a.pdf');
    await writeFile(file, 'pdf bytes');
    const parser = vi.fn<Parser>(async () => [
      element(1, 'The parties have signed this agreement.'),
    ]);
    const pack = await loadPack(join(EXAMPLES, 'packs', 'contracts.yaml'));

    await runPack(pack, [file], { fake: true, cacheDir, parser });
    await runPack(pack, [file], { fake: true, cacheDir, parser });

    expect(parser).toHaveBeenCalledTimes(1);
    expect(parser).toHaveBeenCalledWith(file, 'agentic');
    expect((await readdir(cacheDir)).filter((f) => f.endsWith('.agentic.json'))).toHaveLength(1);
  });

  it('refuses a deciding page with more elements than a choice has labels', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'docsignals-cache-'));
    const file = join(cacheDir, 'dense.pdf');
    await writeFile(file, 'dense');
    const pack = await loadPack(join(EXAMPLES, 'packs', 'quickstart.yaml'));
    // Short filler keeps the page under the element size limit, so the label limit is what fails.
    const clause = 'This agreement is governed by the laws of the State of Delaware.';
    const elements = Array.from({ length: 255 }, (_, i) => ({
      ...element(1, i === 0 ? clause : 'Text.'),
      id: `el-${i}`,
      readingOrder: i,
    }));
    await expect(
      runPack(pack, [file], { fake: true, cacheDir, parser: async () => elements }),
    ).rejects.toThrow(/page 1 has 255 elements, and the block question allows 254/);
  });

  it('builds no link for a document that is not a PDF', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'docsignals-cache-'));
    const file = join(cacheDir, 'scan.png');
    await writeFile(file, 'png bytes');
    const pack = await loadPack(join(EXAMPLES, 'packs', 'invoices.yaml'));
    const { rows } = await runPack(pack, [file], {
      fake: true,
      cacheDir,
      parser: async () => [element(1, 'Invoice Number: INV-7')],
    });
    expect(rows[0]?.extracted.invoice_number?.block).toMatchObject({ id: 'el-1', link: null });
  });

  it('reports a field it cannot find as null rather than guessing', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'docsignals-cache-'));
    const file = join(cacheDir, 'b.pdf');
    await writeFile(file, 'other bytes');
    const pack = await loadPack(join(EXAMPLES, 'packs', 'invoices.yaml'));
    const { rows } = await runPack(pack, [file], {
      fake: true,
      cacheDir,
      parser: async () => [element(1, 'Invoice Number: INV-7')],
    });
    expect(rows[0]?.extracted.invoice_number).toMatchObject({
      value: 'INV-7',
      block: {
        id: 'el-1',
        bounds: { x: 1, y: 2, width: 3, height: 4 },
        link: expect.stringMatching(/^file:\/\/.*\/b\.pdf#page=1&zoom=100,0,1$/),
      },
    });
    expect(rows[0]?.extracted.due_date).toEqual({
      value: null,
      page: null,
      block: null,
      source: null,
      confidence: null,
    });
  });

  it('fails loudly on a cache miss with no DWS key', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'docsignals-cache-'));
    const file = join(cacheDir, 'c.pdf');
    await writeFile(file, 'uncached');
    vi.stubEnv('NUTRIENT_EXTRACTION_API_KEY', '');
    const pack = await loadPack(join(EXAMPLES, 'packs', 'contracts.yaml'));
    await expect(runPack(pack, [file], { fake: true, cacheDir })).rejects.toThrow(
      /NUTRIENT_EXTRACTION_API_KEY is not set/,
    );
    vi.unstubAllEnvs();
  });

  it('rejects an empty document list and a document with no pages', async () => {
    const pack = await loadPack(join(EXAMPLES, 'packs', 'contracts.yaml'));
    await expect(runPack(pack, [], recorded)).rejects.toThrow(/no documents/);

    const cacheDir = await mkdtemp(join(tmpdir(), 'docsignals-cache-'));
    const file = join(cacheDir, 'd.pdf');
    await writeFile(file, 'blank');
    await expect(
      runPack(pack, [file], { fake: true, cacheDir, parser: async () => [] }),
    ).rejects.toThrow(/returned no pages/);
  });
});
