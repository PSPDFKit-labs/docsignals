import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { NutrientClient } from '@nutrient-sdk/dws-client-typescript';
import type { ParseMode } from './pack.js';
import { buildPages, elementList, type Page } from './pages.js';

/** Returns the raw DWS spatial elements for a document. */
export type Parser = (file: string, mode: Exclude<ParseMode, 'text'>) => Promise<unknown>;

export interface ExtractOptions {
  mode: ParseMode;
  cacheDir: string;
  /** Defaults to DWS Data Extraction, authenticated by `NUTRIENT_EXTRACTION_API_KEY`. */
  parser?: Parser;
}

/** Sits beside the credentials that the Nutrient DWS MCP server keeps in `nutrient/`. */
export function defaultCacheDir(env = process.env, homeDirectory = homedir()): string {
  const configHome = env.XDG_CONFIG_HOME || join(homeDirectory, '.config');
  return join(configHome, 'nutrient', 'docsignals', 'cache');
}

export function dwsParser(apiKey = process.env.NUTRIENT_EXTRACTION_API_KEY): Parser {
  if (!apiKey) {
    throw new Error(
      'NUTRIENT_EXTRACTION_API_KEY is not set. Extraction needs a Nutrient DWS key authorised for Data Extraction. ' +
        'To try docsignals without one, point --cache-dir at examples/cache.',
    );
  }
  const client = new NutrientClient({ apiKey });
  return (file, mode) => client.parseElements(file, mode);
}

/**
 * Extracts a document into pages. DWS is called once per (file content, mode);
 * every later run reads the cache, so changing a question never re-bills extraction.
 */
export async function extractPages(file: string, options: ExtractOptions): Promise<Page[]> {
  if (options.mode === 'text') {
    throw new Error(
      'mode "text" returns whole-document Markdown with no page boundaries, and docsignals asks questions per page. ' +
        'Use "agentic" (the default), "understand", or "structure".',
    );
  }
  const bytes = await readFile(file);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const cachePath = join(options.cacheDir, `${digest}.${options.mode}.json`);

  const cached = await readFile(cachePath, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });

  let raw: unknown;
  if (cached !== undefined) {
    raw = JSON.parse(cached);
  } else {
    const parser = options.parser ?? dwsParser();
    raw = await parser(file, options.mode);
    await mkdir(options.cacheDir, { recursive: true });
    await writeFile(cachePath, JSON.stringify(raw));
  }

  const elements = elementList.safeParse(raw);
  if (!elements.success) {
    throw new Error(`${file}: unexpected extraction payload: ${elements.error.message}`);
  }
  return buildPages(elements.data);
}
