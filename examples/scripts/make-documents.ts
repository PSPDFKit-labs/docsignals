/**
 * Regenerates examples/documents/**.pdf from examples/sources/**.html with the DWS Processor API.
 * Needs NUTRIENT_EXTRACTION_API_KEY set to a Processor key. The PDFs are committed, so you only run
 * this after editing a source. Editing a PDF changes its hash, so re-record examples/cache
 * afterwards.
 */
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { NutrientClient } from '@nutrient-sdk/dws-client-typescript';

const apiKey = process.env.NUTRIENT_EXTRACTION_API_KEY;
if (!apiKey) throw new Error('NUTRIENT_EXTRACTION_API_KEY is not set');

const client = new NutrientClient({ apiKey });
const sources = join(import.meta.dirname, '..', 'sources');
const documents = join(import.meta.dirname, '..', 'documents');

for (const group of await readdir(sources)) {
  await mkdir(join(documents, group), { recursive: true });
  for (const name of (await readdir(join(sources, group))).filter((f) => f.endsWith('.html'))) {
    const result = await client
      .workflow()
      .addHtmlPart(join(sources, group, name))
      .outputPdf()
      .execute();
    if (!result.success || !result.output || !('buffer' in result.output)) {
      throw new Error(`${name}: conversion failed: ${JSON.stringify(result.errors)}`);
    }
    const target = join(documents, group, `${basename(name, '.html')}.pdf`);
    await writeFile(target, result.output.buffer);
    console.log(`wrote ${target}`);
  }
}
