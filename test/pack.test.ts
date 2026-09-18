import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadPack, PackError } from '../src/pack.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'docsignals-pack-'));
});

async function pack(name: string, yaml: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, yaml);
  return path;
}

const HEADER = 'name: t\nversion: 1.0.0\n';

describe('loadPack', () => {
  it('loads the three question types and applies default reducers', async () => {
    const loaded = await loadPack(
      await pack(
        'ok.yaml',
        `${HEADER}questions:
  signed:
    noul: It is signed.
  law:
    ask: Which law?
    choice: { ny: New York, other: null }
    fallback: other
  risk:
    score: [low, high]
`,
      ),
    );
    expect(loaded.mode).toBe('agentic');
    expect(loaded.questions.signed).toEqual({ noul: 'It is signed.', reduce: 'max' });
    expect(loaded.questions.law).toMatchObject({ reduce: 'top_page', fallback: 'other' });
    expect(loaded.questions.risk).toMatchObject({ reduce: 'max' });
  });

  it('resolves a built-in std question', async () => {
    const loaded = await loadPack(
      await pack('std.yaml', `${HEADER}questions:\n  kind:\n    use: std#doc_type\n`),
    );
    expect(loaded.questions.kind).toMatchObject({ fallback: 'other' });
    expect(Object.keys((loaded.questions.kind as { choice: object }).choice)).toContain('invoice');
  });

  it('resolves a question from a sibling pack', async () => {
    await pack(
      'base.yaml',
      `${HEADER}questions:\n  signed:\n    noul: It is signed.\n    reduce: min\n`,
    );
    const loaded = await loadPack(
      await pack('child.yaml', `${HEADER}questions:\n  s:\n    use: ./base.yaml#signed\n`),
    );
    expect(loaded.questions.s).toEqual({ noul: 'It is signed.', reduce: 'min' });
  });

  it('names the known questions when a use target is missing', async () => {
    const path = await pack('missing.yaml', `${HEADER}questions:\n  x:\n    use: std#nope\n`);
    await expect(loadPack(path)).rejects.toThrow(/"std#nope" not found.*doc_type/s);
  });

  it('rejects a circular use chain', async () => {
    await pack('a.yaml', `${HEADER}questions:\n  q:\n    use: ./b.yaml#q\n`);
    const b = await pack('b.yaml', `${HEADER}questions:\n  q:\n    use: ./a.yaml#q\n`);
    await expect(loadPack(b)).rejects.toThrow(/circular/);
  });

  it.each([
    ['an empty yes description', 'questions:\n  q:\n    noul: a\n    yes: ""\n'],
    ['a yes description on a choice', 'questions:\n  q:\n    choice: {a: x, b: y}\n    yes: z\n'],
    ['two types in one question', 'questions:\n  q:\n    noul: a\n    score: [a, b]\n'],
    ['a reducer from another type', 'questions:\n  q:\n    noul: a\n    reduce: top_page\n'],
    [
      'a fallback that is not a label',
      'questions:\n  q:\n    choice: { a: x, b: y }\n    fallback: c\n',
    ],
    ['a one-label choice', 'questions:\n  q:\n    choice: { a: x }\n'],
    ['a one-level score', 'questions:\n  q:\n    score: [only]\n'],
    ['a question name that is not snake_case', 'questions:\n  Bad-Name:\n    noul: a\n'],
    ['an unknown top-level key', 'questions:\n  q:\n    noul: a\nextras: 1\n'],
    ['an extract field with no keys', 'extract:\n  f:\n    keys: []\n'],
    ['an empty pack', ''],
  ])('rejects %s', async (_label, body) => {
    await expect(loadPack(await pack('bad.yaml', HEADER + body))).rejects.toBeInstanceOf(PackError);
  });

  it('rejects a version that is not semver', async () => {
    const path = await pack('v.yaml', 'name: t\nversion: one\nquestions:\n  q:\n    noul: a\n');
    await expect(loadPack(path)).rejects.toThrow(/semver/);
  });

  it('reports the path when the file does not exist', async () => {
    await expect(loadPack(join(dir, 'absent.yaml'))).rejects.toThrow(
      /absent\.yaml: cannot read pack/,
    );
  });
});

const ROUTER = `${HEADER}questions:
  kind:
    choice: { invoice: A bill, contract: An agreement, other: null }
    fallback: other
`;
const INVOICES =
  'name: invoices\nversion: 2.1.0\nquestions:\n  overdue:\n    noul: It is overdue.\n';

describe('loadPack routing', () => {
  it('loads a linked case, an inline case, and a default', async () => {
    await pack('invoices.yaml', INVOICES);
    const loaded = await loadPack(
      await pack(
        'router.yaml',
        `${ROUTER}route:
  on: kind
  min_confidence: 0.5
  cases:
    invoice: ./invoices.yaml
    contract:
      questions:
        signed:
          noul: It is signed.
  default:
    extract:
      reference:
        keys: [Reference]
`,
      ),
    );
    expect(loaded.route).toMatchObject({ on: 'kind', minConfidence: 0.5 });
    expect(loaded.route?.cases.invoice).toMatchObject({
      prefix: 'invoices',
      pack: { name: 'invoices', version: '2.1.0', mode: 'agentic' },
    });
    expect(loaded.route?.cases.contract).toMatchObject({
      prefix: 'contract',
      pack: { name: 't/contract', version: '1.0.0', questions: { signed: { reduce: 'max' } } },
    });
    expect(loaded.route?.default).toMatchObject({ prefix: 'default', pack: { name: 't/default' } });
  });

  it('loads a route inside a routed pack', async () => {
    await pack(
      'invoices.yaml',
      `${INVOICES}  region:
    choice: { eu: European Union, us: United States }
route:
  on: region
  cases:
    eu:
      questions:
        vat:
          noul: It shows a VAT number.
`,
    );
    const loaded = await loadPack(
      await pack(
        'router.yaml',
        `${ROUTER}route:\n  on: kind\n  cases:\n    invoice: ./invoices.yaml\n`,
      ),
    );
    expect(loaded.route?.cases.invoice?.pack.route?.cases.eu?.pack.name).toBe('invoices/eu');
  });

  it('lets two labels share one linked pack', async () => {
    await pack('invoices.yaml', INVOICES);
    const loaded = await loadPack(
      await pack(
        'router.yaml',
        `${ROUTER}route:\n  on: kind\n  cases:\n    invoice: ./invoices.yaml\n    other: ./invoices.yaml\n`,
      ),
    );
    expect(loaded.route?.cases.other?.prefix).toBe('invoices');
  });

  it('lets a routed pack use a question from the pack that routes to it', async () => {
    const router = await pack(
      'router.yaml',
      `${ROUTER}route:\n  on: kind\n  cases:\n    invoice: ./child.yaml\n`,
    );
    await pack(
      'child.yaml',
      'name: child\nversion: 1.0.0\nquestions:\n  k:\n    use: ./router.yaml#kind\n',
    );
    const loaded = await loadPack(router);
    expect(loaded.route?.cases.invoice?.pack.questions.k).toMatchObject({ fallback: 'other' });
  });

  it.each([
    [
      'an "on" that is not a question',
      'route:\n  on: nope\n  cases:\n    invoice: ./invoices.yaml\n',
      /"nope" is not a question.*kind/s,
    ],
    [
      'a case that is not a label',
      'route:\n  on: kind\n  cases:\n    receipt: ./invoices.yaml\n',
      /"receipt" is not a label of "kind": invoice, contract, other/,
    ],
    ['no cases', 'route:\n  on: kind\n  cases: {}\n', /at least one case/],
    [
      'a link to a missing pack',
      'route:\n  on: kind\n  cases:\n    invoice: ./absent.yaml\n',
      /absent\.yaml: cannot read pack/,
    ],
    [
      'an empty inline case',
      'route:\n  on: kind\n  cases:\n    invoice: {}\n',
      /t\/invoice needs at least one entry/,
    ],
    [
      'a min_confidence above 1',
      'route:\n  on: kind\n  min_confidence: 1.5\n  cases:\n    invoice: ./invoices.yaml\n',
      /min_confidence/,
    ],
    [
      'an unknown route key',
      'route:\n  on: kind\n  when: x\n  cases:\n    invoice: ./invoices.yaml\n',
      /when/,
    ],
  ])('rejects %s', async (_label, route, message) => {
    await pack('invoices.yaml', INVOICES);
    await expect(loadPack(await pack('router.yaml', ROUTER + route))).rejects.toThrow(message);
  });

  it('rejects an "on" that is not a choice question', async () => {
    const path = await pack(
      'router.yaml',
      `${HEADER}questions:\n  signed:\n    noul: It is signed.\nroute:\n  on: signed\n  cases:\n    yes: ./x.yaml\n`,
    );
    await expect(loadPack(path)).rejects.toThrow(/must be a choice question/);
  });

  it('rejects a circular route chain', async () => {
    await pack(
      'invoices.yaml',
      `${ROUTER.replace('name: t', 'name: invoices')}route:\n  on: kind\n  cases:\n    other: ./router.yaml\n`,
    );
    const router = await pack(
      'router.yaml',
      `${ROUTER}route:\n  on: kind\n  cases:\n    invoice: ./invoices.yaml\n`,
    );
    await expect(loadPack(router)).rejects.toThrow(/circular "route" chain/);
  });

  it('rejects a routed pack that sets another mode', async () => {
    await pack('invoices.yaml', `${INVOICES}mode: structure\n`);
    const router = await pack(
      'router.yaml',
      `${ROUTER}route:\n  on: kind\n  cases:\n    invoice: ./invoices.yaml\n`,
    );
    await expect(loadPack(router)).rejects.toThrow(
      /mode "structure" differs from the root pack's mode "agentic"/,
    );
  });

  it('rejects two routed packs with the same column prefix', async () => {
    await pack('invoices.yaml', INVOICES);
    await pack('other.yaml', INVOICES);
    const router = await pack(
      'router.yaml',
      `${ROUTER}route:\n  on: kind\n  cases:\n    invoice: ./invoices.yaml\n    contract: ./other.yaml\n`,
    );
    await expect(loadPack(router)).rejects.toThrow(/share the column prefix "invoices"/);
  });

  it('rejects a linked pack whose name cannot prefix a column', async () => {
    await pack('invoices.yaml', INVOICES.replace('name: invoices', 'name: AP Invoices'));
    const router = await pack(
      'router.yaml',
      `${ROUTER}route:\n  on: kind\n  cases:\n    invoice: ./invoices.yaml\n`,
    );
    await expect(loadPack(router)).rejects.toThrow(/prefix "AP Invoices".*rename the pack/s);
  });
});
