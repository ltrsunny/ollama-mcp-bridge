#!/usr/bin/env node
/**
 * probe-numctx.mjs — verify that num_ctx per tier is being sent to Ollama.
 *
 * Sends a synthetic input that exceeds Ollama's default 4096-token window
 * to each tier model, then checks that prompt_eval_count in the response
 * equals the full input length (not silently capped at 4096).
 *
 * Usage:
 *   node tests/probe-numctx.mjs              # runs both tiers
 *   node tests/probe-numctx.mjs --tier B     # Tier B only
 *   node tests/probe-numctx.mjs --tier C     # Tier C only
 *
 * Exit code: 0 = all assertions passed, 1 = failure.
 *
 * Requires a running Ollama daemon with the tier models pulled.
 */

import { OllamaClient } from '../dist/src/ollama/client.js';
import { DEFAULT_CONFIG } from '../dist/src/config/tiers.js';

// ── Config ────────────────────────────────────────────────────────────────────

const OLLAMA_HOST = process.env['OLLAMA_HOST'] ?? 'http://127.0.0.1:11434';

// We want an input longer than the OLD default of 4096 tokens.
// ~5500 words × 1.3 tok/word ≈ 7150 tokens; safely over 4096, safely under
// the new Tier B window of 8192.
const TARGET_WORD_COUNT = 5500;

// Each tier is probed separately because Tier C (7B) may not be pulled.
const TIER_SPECS = {
  B: {
    tierKey: 'B',
    numCtx: DEFAULT_CONFIG.tiers.B.numCtx,
    model: DEFAULT_CONFIG.tiers.B.model,
  },
  C: {
    tierKey: 'C',
    numCtx: DEFAULT_CONFIG.tiers.C.numCtx,
    model: DEFAULT_CONFIG.tiers.C.model,
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a deterministic synthetic document of approximately `words` words. */
function buildSyntheticDoc(words) {
  const sentence = 'The quick brown fox jumps over the lazy dog near the riverbank. ';
  const wordsPerSentence = sentence.split(' ').filter(Boolean).length;
  const repetitions = Math.ceil(words / wordsPerSentence);
  return sentence.repeat(repetitions);
}

function pass(msg) {
  console.log(`  ✅  ${msg}`);
}

function fail(msg) {
  console.error(`  ❌  ${msg}`);
}

// ── Probe ─────────────────────────────────────────────────────────────────────

async function probeOneTier(spec, client) {
  const { tierKey, model, numCtx } = spec;
  console.log(`\n── Tier ${tierKey}: ${model} (num_ctx=${numCtx}) ──`);

  if (!numCtx) {
    fail(`numCtx not set in DEFAULT_CONFIG.tiers.${tierKey} — this should never happen`);
    return false;
  }

  const inputText = buildSyntheticDoc(TARGET_WORD_COUNT);
  const approxInputTokens = Math.round(inputText.split(/\s+/).length * 1.3);
  console.log(`  Input: ~${approxInputTokens} tokens (${inputText.split(/\s+/).length} words)`);
  console.log(`  Sending to Ollama (may take 10–30 s on first call)…`);

  const result = await client.chat({
    model,
    user: `What is the last word in this passage?\n\n${inputText}`,
    temperature: 0,
    numCtx,
    numPredict: 20,       // we only care about prompt_eval_count, not output
    keepAlive: 120,       // keep warm for potential second probe
  });

  const { promptTokens, completionTokens } = result;
  console.log(`  prompt_eval_count = ${promptTokens}  |  eval_count = ${completionTokens}`);

  let ok = true;

  // Core assertion: must not have been capped at old default 4096
  const CAP_THRESHOLD = 4200; // a little slack for tokenizer variance
  if (promptTokens < CAP_THRESHOLD) {
    fail(
      `prompt_eval_count ${promptTokens} < ${CAP_THRESHOLD} — ` +
      `likely still using Ollama default 4096 context window. ` +
      `Check that numCtx is being passed as options.num_ctx.`,
    );
    ok = false;
  } else {
    pass(`prompt_eval_count ${promptTokens} ≥ ${CAP_THRESHOLD} — not capped at 4096`);
  }

  // Secondary: must not exceed the configured window (sanity check)
  if (promptTokens > numCtx + 200) {
    fail(
      `prompt_eval_count ${promptTokens} > numCtx ${numCtx} by a large margin — unexpected`,
    );
    ok = false;
  } else {
    pass(`prompt_eval_count ${promptTokens} within configured num_ctx ${numCtx}`);
  }

  return ok;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const tierArg = args[args.indexOf('--tier') + 1]?.toUpperCase();
  const tiersToRun = tierArg ? [tierArg] : ['B', 'C'];

  console.log('probe-numctx — verifying num_ctx is not capped at Ollama default 4096');
  console.log(`Ollama host: ${OLLAMA_HOST}`);
  console.log(`Tiers: ${tiersToRun.join(', ')}`);

  const client = new OllamaClient(OLLAMA_HOST);

  try {
    await client.ping();
    console.log('Ollama daemon: reachable ✅');
  } catch (err) {
    console.error(`Ollama daemon not reachable at ${OLLAMA_HOST}: ${err.message}`);
    process.exit(1);
  }

  let allOk = true;

  for (const tier of tiersToRun) {
    const spec = TIER_SPECS[tier];
    if (!spec) {
      console.error(`Unknown tier "${tier}". Valid: B, C`);
      process.exit(1);
    }
    try {
      const ok = await probeOneTier(spec, client);
      if (!ok) allOk = false;
    } catch (err) {
      // Model likely not pulled
      if (err.message?.includes('model') || err.message?.includes('pull')) {
        console.warn(`  ⚠️  Tier ${tier} model not available: ${err.message}`);
        console.warn(`  Run: ollama pull ${spec.model}`);
      } else {
        fail(`Tier ${tier} probe threw: ${err.message}`);
        allOk = false;
      }
    }
  }

  console.log(`\n${'─'.repeat(60)}`);
  if (allOk) {
    console.log('All probes passed ✅  num_ctx is being forwarded correctly.');
    process.exit(0);
  } else {
    console.error('One or more probes FAILED ❌  See output above.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
