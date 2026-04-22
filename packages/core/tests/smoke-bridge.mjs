#!/usr/bin/env node
// Spawns `ollama-mcp serve` over stdio, walks the MCP handshake, calls the
// summarize tool, and prints what comes back. For manual verification; this
// is not wired into a test runner.
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORE_ROOT = path.resolve(__dirname, '..');

const MODEL = process.env.BRIDGE_MODEL ?? 'qwen3.5:4b';
const SAMPLE_TEXT = `The ollama-mcp-bridge is a universal server that connects any Model Context \
Protocol client — Claude Desktop, Cursor, Cline, Zed — to a locally running Ollama \
instance. When the frontier assistant receives a lightweight task like summarizing, \
classifying, or transforming text, it can delegate the work to a small local model. \
That preserves the frontier model's token budget for harder reasoning, keeps the data \
on the user's machine, and works offline.`;

function send(proc, msg) {
  proc.stdin.write(JSON.stringify(msg) + '\n');
}

function waitForResponse(rl, id, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      rl.off('line', onLine);
      reject(new Error(`timeout waiting for response id=${id}`));
    }, timeoutMs);
    function onLine(line) {
      try {
        const msg = JSON.parse(line);
        if (msg.id === id) {
          clearTimeout(timer);
          rl.off('line', onLine);
          resolve(msg);
        }
      } catch {
        /* ignore non-JSON stderr leaks */
      }
    }
    rl.on('line', onLine);
  });
}

const proc = spawn('npx', ['tsx', 'bin/cli.ts', 'serve', '--model', MODEL], {
  cwd: CORE_ROOT,
  stdio: ['pipe', 'pipe', 'inherit'],
});

const rl = readline.createInterface({ input: proc.stdout });

try {
  // 1. initialize
  send(proc, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'smoke-bridge', version: '0' },
    },
  });
  const initRes = await waitForResponse(rl, 1, 10_000);
  console.log('[init]', JSON.stringify(initRes.result?.serverInfo));

  // 2. initialized notification
  send(proc, { jsonrpc: '2.0', method: 'notifications/initialized' });

  // 3. list tools
  send(proc, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const listRes = await waitForResponse(rl, 2, 10_000);
  const toolNames = (listRes.result?.tools ?? []).map((t) => t.name);
  console.log('[tools]', toolNames.join(', '));

  // 4. call summarize
  console.log('[call] summarize… (this uses the local model, may take 10-30s)');
  const t0 = Date.now();
  send(proc, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'summarize',
      arguments: { text: SAMPLE_TEXT, style: 'one sentence' },
    },
  });
  const callRes = await waitForResponse(rl, 3, 180_000);
  const ms = Date.now() - t0;
  if (callRes.result?.isError) {
    console.error('[call] ERROR:', callRes.result.content);
    process.exitCode = 1;
  } else {
    const text = callRes.result?.content?.[0]?.text ?? '(empty)';
    console.log(`[call] ok in ${ms}ms`);
    console.log('---');
    console.log(text);
    console.log('---');
  }
} finally {
  proc.kill('SIGTERM');
}
