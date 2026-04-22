#!/usr/bin/env node
import { Command } from 'commander';
import { detectHardware } from '../src/hardware/detect.js';
import { fetchCatalog, CatalogFetchError } from '../src/models/catalog.js';
import {
  OllamaClient,
  OllamaDaemonError,
  DEFAULT_OLLAMA_HOST,
} from '../src/ollama/client.js';
import { runBridgeServerStdio } from '../src/mcp/server.js';

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

program
  .command('models')
  .description('Show Ollama daemon status and installed models.')
  .option('--host <url>', 'Ollama host', DEFAULT_OLLAMA_HOST)
  .action(async (opts: { host: string }) => {
    const client = new OllamaClient(opts.host);
    try {
      const { version } = await client.ping();
      const installed = await client.listInstalled();
      process.stdout.write(`ollama daemon: v${version} at ${opts.host}\n`);
      if (installed.length === 0) {
        process.stdout.write('no models installed. try: ollama pull qwen3.5:4b\n');
        return;
      }
      for (const m of installed) {
        const gb = (m.sizeBytes / 1024 ** 3).toFixed(1);
        process.stdout.write(`${m.name}  ${gb} GB  (modified ${m.modifiedAt})\n`);
      }
    } catch (err) {
      const msg =
        err instanceof OllamaDaemonError ? err.message : (err as Error).message;
      process.stderr.write(`models: ${msg}\n`);
      process.exitCode = 1;
    }
  });

program
  .command('serve')
  .description('Run the MCP bridge server over stdio (for MCP clients).')
  .option('--model <name>', 'Ollama model to delegate tasks to', 'qwen3.5:4b')
  .option('--host <url>', 'Ollama host', DEFAULT_OLLAMA_HOST)
  .action(async (opts: { model: string; host: string }) => {
    try {
      await runBridgeServerStdio({ model: opts.model, ollamaHost: opts.host });
    } catch (err) {
      const msg =
        err instanceof OllamaDaemonError ? err.message : (err as Error).message;
      process.stderr.write(`serve: ${msg}\n`);
      process.exit(1);
    }
  });

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(1);
});
