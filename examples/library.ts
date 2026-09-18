/**
 * Flags contracts that need a lawyer's attention, using docsignals as a library.
 *
 *   npx tsx examples/library.ts
 *
 * Runs offline: it uses the recorded extractions in examples/cache and the fake Jev.
 * To run it for real, remove `fake` and `cacheDir`, and set NUTRIENT_EXTRACTION_API_KEY and TYPESAFE_API_KEY.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadPack, runPack } from '../src/index.js';

const examples = import.meta.dirname;
const folder = join(examples, 'documents', 'contracts');
const files = (await readdir(folder)).filter((f) => f.endsWith('.pdf')).map((f) => join(folder, f));

const pack = await loadPack(join(examples, 'packs', 'contracts.yaml'));
const { rows } = await runPack(pack, files, { fake: true, cacheDir: join(examples, 'cache') });

for (const row of rows) {
  const signed = row.answers.is_signed;
  const risk = row.answers.customer_risk;
  const reasons: string[] = [];

  if (signed?.type === 'noul' && signed.p < 0.5) {
    reasons.push(`probably unsigned (p=${signed.p.toFixed(2)})`);
  }
  if (risk?.type === 'score' && risk.score > 1.2 && 'page' in risk) {
    reasons.push(`elevated customer risk ${risk.score.toFixed(2)} on page ${risk.page}`);
  }

  console.log(
    reasons.length > 0 ? `REVIEW  ${row.doc}: ${reasons.join('; ')}` : `ok      ${row.doc}`,
  );
}
