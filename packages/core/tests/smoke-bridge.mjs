#!/usr/bin/env node
// Spawns `ollama-mcp serve` over stdio, walks the MCP handshake, and calls
// each registered tool to prove the tier dispatch works. Manual verification;
// not wired into a test runner.
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORE_ROOT = path.resolve(__dirname, '..');

const SHORT_TEXT = `The ollama-mcp-bridge is a universal server that connects any Model Context \
Protocol client — Claude Desktop, Cursor, Cline, Zed — to a locally running Ollama \
instance. When the frontier assistant receives a lightweight task like summarizing, \
classifying, or transforming text, it can delegate the work to a small local model. \
That preserves the frontier model's token budget for harder reasoning, keeps the data \
on the user's machine, and works offline.`;

const LONG_TEXT = `In distributed agent systems, token cost becomes the dominant runtime
expense as context windows grow. A typical Claude Desktop session may consume tens of
thousands of tokens across a single task if the frontier model is asked to summarize
long documents, rewrite chunks of text, or classify items — work that a much smaller
local model could handle at a fraction of the cost. The Model Context Protocol (MCP)
provides a standard way for the frontier assistant to invoke external tools, but until
now most MCP servers target cloud APIs or system utilities rather than local inference.
ollama-mcp-bridge fills that gap: it exposes a small, well-scoped set of delegation
tools (summarize, summarize-long, classify, extract, rewrite) whose implementation
forwards the work to a locally-running Ollama daemon. The bridge routes each tool
invocation to a tier-appropriate model — a 3-4B instruct model for most tasks, a 7B
model for long-form summarization — and keeps the default tier warm in memory so that
delegation is consistently faster and cheaper than letting the frontier do the work.
By deferring only the lightweight work, the frontier model's token budget is preserved
for reasoning that actually benefits from frontier-class capability, and sensitive
source material never leaves the user's machine. The bridge is client-neutral: any
MCP-compatible assistant — Claude Desktop, Cursor, Cline, Zed, Continue — can use it
without client-specific plumbing, because MCP is the only contract between them.`;

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

const proc = spawn('npx', ['tsx', 'bin/cli.ts', 'serve'], {
  cwd: CORE_ROOT,
  stdio: ['pipe', 'pipe', 'inherit'],
});

const rl = readline.createInterface({ input: proc.stdout });

let nextId = 1;
const id = () => nextId++;

async function callTool(name, args, timeoutMs = 240_000) {
  const rid = id();
  const t0 = Date.now();
  send(proc, {
    jsonrpc: '2.0',
    id: rid,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  const res = await waitForResponse(rl, rid, timeoutMs);
  const ms = Date.now() - t0;
  return { res, ms };
}

function firstText(res) {
  return res?.result?.content?.[0]?.text ?? '(empty)';
}

function assertNoThinkTag(name, text) {
  if (/<think\b|<\/think>/i.test(text)) {
    throw new Error(
      `[regression] ${name} output contains a <think> tag — the tier model ` +
        `is emitting thinking chains, which defeats the bridge's purpose.\n` +
        `First 200 chars: ${text.slice(0, 200)}`,
    );
  }
}

try {
  // handshake
  const initId = id();
  send(proc, {
    jsonrpc: '2.0',
    id: initId,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'smoke-bridge', version: '0' },
    },
  });
  const initRes = await waitForResponse(rl, initId, 10_000);
  console.log('[init]', JSON.stringify(initRes.result?.serverInfo));

  send(proc, { jsonrpc: '2.0', method: 'notifications/initialized' });

  const listId = id();
  send(proc, { jsonrpc: '2.0', id: listId, method: 'tools/list' });
  const listRes = await waitForResponse(rl, listId, 10_000);
  const toolNames = (listRes.result?.tools ?? []).map((t) => t.name);
  console.log('[tools]', toolNames.join(', '));

  // Tier B: summarize
  console.log('[call] summarize (Tier B, short text)…');
  {
    const { res, ms } = await callTool('summarize', {
      text: SHORT_TEXT,
      style: 'one sentence',
    });
    if (res.result?.isError) {
      console.error('[call] summarize ERROR:', res.result.content);
      process.exitCode = 1;
    } else {
      const text = firstText(res);
      assertNoThinkTag('summarize', text);
      console.log(`[call] summarize ok in ${ms}ms`);
      console.log('---');
      console.log(text);
      console.log('---');
    }
  }

  // Tier C: summarize-long
  console.log('[call] summarize-long (Tier C, long text, cold start likely)…');
  {
    const { res, ms } = await callTool('summarize-long', {
      text: LONG_TEXT,
    });
    if (res.result?.isError) {
      console.error('[call] summarize-long ERROR:', res.result.content);
      process.exitCode = 1;
    } else {
      const text = firstText(res);
      assertNoThinkTag('summarize-long', text);
      console.log(`[call] summarize-long ok in ${ms}ms`);
      console.log('---');
      console.log(text);
      console.log('---');
    }
  }

  // Chinese sanity check on Tier B (bridge's main user locale)
  console.log('[call] summarize (Tier B, Chinese input)…');
  {
    const { res, ms } = await callTool('summarize', {
      text:
        '这是一个跨 MCP 客户端的本地算力桥：当前沿助手拿到总结、改写、分类这类轻量任务时，' +
        '把活儿转给本地 Ollama 跑一个 3-4B 的指令模型来做，数据不出机器，省 token 也更快。',
      style: '一句话',
    });
    if (res.result?.isError) {
      console.error('[call] summarize-zh ERROR:', res.result.content);
      process.exitCode = 1;
    } else {
      const text = firstText(res);
      assertNoThinkTag('summarize-zh', text);
      console.log(`[call] summarize-zh ok in ${ms}ms`);
      console.log('---');
      console.log(text);
      console.log('---');
    }
  }
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  proc.kill('SIGTERM');
}
