#!/usr/bin/env node
import { Command } from 'commander';
import { detectHardware } from '../src/hardware/detect.js';
import { fetchCatalog, CatalogFetchError } from '../src/models/catalog.js';

const program = new Command();

program
  .name('ollama-mcp')
  .description(
    'Inspect the bridge\'s view of your machine and the Ollama model catalog.',
  )
  .version('0.1.0');

program
  .command('hardware')
  .description('Print detected hardware info as JSON.')
  .action(() => {
    const info = detectHardware();
    process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
  });

program
  .command('catalog')
  .description('Fetch the live ollama.com/library catalog.')
  .option('--limit <n>', 'limit results', (v) => Number.parseInt(v, 10))
  .option('--raw', 'print full JSON for every model', false)
  .action(async (opts: { limit?: number; raw?: boolean }) => {
    try {
      const models = await fetchCatalog({ limit: opts.limit });
      if (opts.raw) {
        process.stdout.write(`${JSON.stringify(models, null, 2)}\n`);
        return;
      }
      for (const m of models) {
        const caps = m.capabilities.length ? ` [${m.capabilities.join(', ')}]` : '';
        const sizes = m.sizes.length ? ` (${m.sizes.join(', ')})` : '';
        process.stdout.write(
          `${m.name}${caps}${sizes} — ${m.pullCount} pulls, ${m.tagCount} tags, updated ${m.updatedText}\n`,
        );
      }
      process.stdout.write(`\n${models.length} models\n`);
    } catch (err) {
      if (err instanceof CatalogFetchError) {
        process.stderr.write(`catalog: ${err.message}\n`);
      } else {
        process.stderr.write(`catalog: ${(err as Error).message}\n`);
      }
      process.exitCode = 1;
    }
  });

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(1);
});
