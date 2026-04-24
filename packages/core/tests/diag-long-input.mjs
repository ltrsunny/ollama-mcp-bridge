#!/usr/bin/env node
/**
 * diag-long-input.mjs — diagnose the long-input failure mode.
 *
 * Given a long file (default: the Chinese SRT in Downloads), probes how
 * Tier C handles it at multiple num_ctx settings to separate three possible
 * failure modes:
 *
 *   1. SILENT TRUNCATION — prompt_eval_count == num_ctx, output reflects only tail content
 *   2. TIMEOUT / HUNG GENERATION — chat() never returns or hits client timeout
 *   3. OOM — process killed by kernel (ECONNRESET or similar)
 *
 * Usage:
 *   node tests/diag-long-input.mjs                              # full probe
 *   node tests/diag-long-input.mjs --file PATH
 *   node tests/diag-long-input.mjs --ctx 16384                  # single ctx
 *   node tests/diag-long-input.mjs --ctx 16384,32768            # multiple
 *   node tests/diag-long-input.mjs --predict 50                 # short output for speed
 *
 * Exit code: 0 if at least one probe succeeded, 1 otherwise.
 * Requires a running Ollama daemon with the Tier C model pulled.
 */

import { readFileSync } from 'node:fs';
import { OllamaClient } from '../dist/src/ollama/client.js';
import { DEFAULT_CONFIG } from '../dist/src/config/tiers.js';

const OLLAMA_HOST = process.env['OLLAMA_HOST'] ?? 'http://127.0.0.1:11434';
const DEFAULT_FILE =
  '/Users/rd/Downloads/S57：AI正在把个人工作室改造成一家公司 - UV相对论_原文.srt';

function parseArgs() {
  const args = process.argv.slice(2);
  const getVal = (flag, fallback) => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : fallback;
  };
  const file = getVal('--file', DEFAULT_FILE);
  const ctxRaw = getVal('--ctx', '16384,32768');
  const ctxList = ctxRaw.split(',').map((s) => Number(s.trim())).filter(Boolean);
  const numPredict = Number(getVal('--predict', '400'));
  return { file, ctxList, numPredict };
}

function humanMs(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

async function probe(client, model, text, numCtx, numPredict) {
  console.log(`\n──  num_ctx = ${numCtx}  ──`);
  const t0 = Date.now();
  try {
    const result = await client.chat({
      model,
      system:
        'You summarize Chinese-language podcast transcripts. Produce 1-2 sentence lead + 3-6 bullets. Preserve source language.',
      user: `请对以下对话记录做总结:\n\n${text}`,
      temperature: 0.2,
      numCtx,
      numPredict,
      keepAlive: 120,
    });
    const latencyMs = Date.now() - t0;
    const { promptTokens, completionTokens, text: output } = result;
    console.log(`  ✓ returned in ${humanMs(latencyMs)}`);
    console.log(`  prompt_eval_count = ${promptTokens}`);
    console.log(`  eval_count        = ${completionTokens}`);
    if (promptTokens >= numCtx - 100) {
      console.log(
        `  ⚠️  LIKELY TRUNCATION — prompt tokens (${promptTokens}) maxed out num_ctx (${numCtx})`,
      );
    } else {
      console.log(
        `  ✓ full input fit — ${numCtx - promptTokens} tokens of headroom`,
      );
    }
    console.log(`\n  Output preview (first 500 chars):`);
    console.log(`  ${output.slice(0, 500).replace(/\n/g, '\n  ')}`);
    return { ok: true, promptTokens, completionTokens, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - t0;
    console.log(`  ✗ ERROR after ${humanMs(latencyMs)}: ${err.message}`);
    return { ok: false, error: err.message, latencyMs };
  }
}

async function main() {
  const { file, ctxList, numPredict } = parseArgs();

  const raw = readFileSync(file);
  const bytes = raw.length;
  const text = raw.toString('utf8');
  const chars = [...text].length;
  const approxTokens = Math.round(chars / 1.5); // Chinese: ~1.5 chars/token for qwen tokenizer

  console.log('diag-long-input — probing long-input failure modes\n');
  console.log(`File:               ${file}`);
  console.log(`Size:               ${bytes} bytes  (${chars} chars)`);
  console.log(`Approx input tokens (chars/1.5): ~${approxTokens}`);
  console.log(`Tier C model:       ${DEFAULT_CONFIG.tiers.C.model}`);
  console.log(`Current Tier C num_ctx: ${DEFAULT_CONFIG.tiers.C.numCtx}`);
  console.log(`num_ctx to probe:   ${ctxList.join(', ')}`);
  console.log(`num_predict:        ${numPredict}`);

  const client = new OllamaClient(OLLAMA_HOST);
  try {
    await client.ping();
    console.log(`Ollama daemon:      reachable ✓`);
  } catch (err) {
    console.error(`Ollama daemon not reachable at ${OLLAMA_HOST}: ${err.message}`);
    process.exit(1);
  }

  const model = DEFAULT_CONFIG.tiers.C.model;
  const results = [];
  for (const ctx of ctxList) {
    const r = await probe(client, model, text, ctx, numPredict);
    results.push({ ctx, ...r });
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log('Summary:');
  for (const r of results) {
    if (r.ok) {
      console.log(
        `  num_ctx=${r.ctx.toString().padEnd(6)}  OK   prompt=${r.promptTokens}  eval=${r.completionTokens}  ${humanMs(r.latencyMs)}`,
      );
    } else {
      console.log(
        `  num_ctx=${r.ctx.toString().padEnd(6)}  FAIL (${r.error})  ${humanMs(r.latencyMs)}`,
      );
    }
  }

  const anyOk = results.some((r) => r.ok);
  process.exit(anyOk ? 0 : 1);
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
