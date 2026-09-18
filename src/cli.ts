#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { defaultCacheDir, extractPages } from './extract.js';
import { type Format, formatResult } from './format.js';
import { createJev } from './jev.js';
import { loadPack, type Pack, type ParseMode, type RouteTarget } from './pack.js';
import { runPack } from './run.js';

const USAGE = `docsignals — ask typed questions of your documents

Usage:
  docsignals run <pack.yaml> <documents...>   Answer a pack's questions for each document
  docsignals validate <pack.yaml>             Check a pack and print what it asks
  docsignals pages <document>                 Print the elements of each page, as Jev is asked of them

Options:
  --by <document|page>   One row per document (default) or per page
  --format <table|json|csv>   Output format (default: table)
  --fake                 Answer offline with uncalibrated keyword matching; needs no Jev key
  --cache-dir <dir>      Extraction cache (default: ~/.config/nutrient/docsignals/cache)
  --concurrency <n>      Documents and pages asked at the same time (default: 8)
  --timeout <ms>         Time allowed for one Jev request (default: 10000)
  --mode <mode>          For "pages": agentic (default), understand, or structure
  -h, --help             Show this help

Environment:
  NUTRIENT_EXTRACTION_API_KEY   Nutrient DWS key authorised for Data Extraction (not needed on a cache hit)
  TYPESAFE_API_KEY              Jev key (not needed with --fake)`;

function positive(flag: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`--${flag} must be a positive whole number, got "${value}"`);
  }
  return n;
}

function oneOf<T extends string>(flag: string, value: string, allowed: readonly T[]): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`--${flag} must be one of: ${allowed.join(', ')} (got "${value}")`);
}

function describePack(pack: Pack, indent: string, print: (text: string) => void): void {
  const questions = Object.keys(pack.questions);
  const fields = Object.keys(pack.extract);
  print(`${indent}questions: ${questions.length > 0 ? questions.join(', ') : 'none'}`);
  print(`${indent}extract:   ${fields.length > 0 ? fields.join(', ') : 'none'}`);
  if (pack.route === undefined) return;

  const { on, minConfidence, cases } = pack.route;
  const threshold = minConfidence === undefined ? '' : ` (min_confidence ${minConfidence})`;
  print(`${indent}route on ${on}${threshold}:`);
  const describeTarget = (label: string, target: RouteTarget): void => {
    const { name, version } = target.pack;
    print(`${indent}  ${label} -> ${name}@${version}, columns "${target.prefix}.*"`);
    describePack(target.pack, `${indent}    `, print);
  };
  for (const [label, target] of Object.entries(cases)) describeTarget(label, target);
  if (pack.route.default) describeTarget('default', pack.route.default);
  else print(`${indent}  default -> no further questions`);
}

export async function main(argv: string[], print: (text: string) => void): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      by: { type: 'string', default: 'document' },
      format: { type: 'string', default: 'table' },
      fake: { type: 'boolean', default: false },
      'cache-dir': { type: 'string', default: defaultCacheDir() },
      concurrency: { type: 'string' },
      timeout: { type: 'string' },
      mode: { type: 'string', default: 'agentic' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [command, ...rest] = positionals;

  if (values.help || command === undefined) {
    print(USAGE);
    return;
  }

  if (command === 'run') {
    const [packPath, ...files] = rest;
    if (!packPath || files.length === 0)
      throw new Error('usage: docsignals run <pack.yaml> <documents...>');
    const concurrency = positive('concurrency', values.concurrency);
    const timeout = positive('timeout', values.timeout);
    const result = await runPack(await loadPack(packPath), files, {
      by: oneOf('by', values.by, ['document', 'page'] as const),
      fake: values.fake,
      cacheDir: values['cache-dir'],
      ...(concurrency === undefined ? {} : { concurrency }),
      ...(timeout === undefined ? {} : { jev: createJev({ fake: values.fake, timeout }) }),
    });
    print(formatResult(result, oneOf<Format>('format', values.format, ['table', 'json', 'csv'])));
    return;
  }

  if (command === 'validate') {
    const [packPath] = rest;
    if (!packPath) throw new Error('usage: docsignals validate <pack.yaml>');
    const pack = await loadPack(packPath);
    print(`${pack.name}@${pack.version} is valid (mode: ${pack.mode})`);
    describePack(pack, '  ', print);
    return;
  }

  if (command === 'pages') {
    const [file] = rest;
    if (!file) throw new Error('usage: docsignals pages <document>');
    const mode = oneOf<ParseMode>('mode', values.mode, ['structure', 'understand', 'agentic']);
    const pages = await extractPages(file, { mode, cacheDir: values['cache-dir'] });
    for (const page of pages) {
      print(`--- page ${page.page} ---\n${JSON.stringify(page.elements, null, 2)}\n`);
    }
    return;
  }

  throw new Error(`unknown command "${command}"\n\n${USAGE}`);
}

const entry = process.argv[1];
if (entry !== undefined && realpathSync(entry) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), console.log).catch((error: Error) => {
    console.error(`docsignals: ${error.message}`);
    process.exitCode = 1;
  });
}
