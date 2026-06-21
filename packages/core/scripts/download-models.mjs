#!/usr/bin/env node
/**
 * download-models — fetch the MLX-format weights that DEFAULT_CONFIG references
 * into `~/.omlx/models/`, the directory oMLX serves from.
 *
 * Usage:
 *   npm run download-models               # default: B + C (4B + 8B, ~7.5 GB)
 *   npm run download-models -- --tiers B,C,D   # power-user: also fetch
 *                                                14B (~5 GB more). Tier D is
 *                                                demoted in v0.6.0 — only
 *                                                stable on 24+ GB Mac with
 *                                                raised hot_cache_max_size.
 *   npm run download-models -- --tiers B  # 4B only (~2.5 GB)
 *
 * v0.6.0 fix: Tier B previously pointed at `mlx-community/Qwen3-8B-4bit`
 * (same as C), which meant the actual Tier B model (4B-Instruct-2507)
 * never got downloaded on a fresh install. Anyone running this script
 * before this commit only ended up with 8B + 14B, and Tier B routing
 * (the default for classify / extract / transform / summarize) would
 * fail at runtime with "model not found". Now B → 4B-Instruct-2507.
 *
 * Requires: oMLX installed (`brew install jundot/omlx/omlx`) — uses oMLX's
 * bundled Python + huggingface_hub. We do NOT add huggingface_hub as an npm
 * dep because the typical install already has it via the oMLX Homebrew formula.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const OMLX_PYTHON = '/opt/homebrew/opt/omlx/libexec/bin/python';
const MODELS_DIR = path.join(homedir(), '.omlx', 'models');

/** (tier label) → (HF repo, local dir name). Must stay in lockstep with
 *  the `mlxModelName` fields in `src/config/tiers.ts`. */
const MODELS = {
  B: {
    repo: 'mlx-community/Qwen3-4B-Instruct-2507-4bit',
    dir: 'Qwen3-4B-Instruct-2507-4bit',
  },
  C: { repo: 'mlx-community/Qwen3-8B-4bit', dir: 'Qwen3-8B-4bit' },
  D: { repo: 'mlx-community/Qwen3-14B-4bit', dir: 'Qwen3-14B-4bit' },
  // v0.8.0: Tier V — the dedicated Qwen3-VL vision model (~2.9 GB). Powers the
  // multimodal image tools (extract/classify/summarize over an image source_uri).
  V: { repo: 'mlx-community/Qwen3-VL-4B-Instruct-4bit', dir: 'Qwen3-VL-4B-Instruct-4bit' },
};

function parseArgs(argv) {
  // v0.6.0: Tier D removed from default — demoted to power-user opt-in (--tiers B,C,D).
  // v0.8.0: Tier V (vision, ~2.9 GB) IS in the default so the multimodal image
  // tools work out of the box; drop it with `--tiers B,C` for a text-only install.
  const out = { tiers: ['B', 'C', 'V'] };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--tiers') {
      out.tiers = argv[++i].split(',').map((s) => s.trim().toUpperCase());
    }
  }
  return out;
}

function downloadOne(repo, dirName) {
  const target = path.join(MODELS_DIR, dirName);
  if (existsSync(target)) {
    console.log(`✓ ${dirName} already present at ${target}`);
    return Promise.resolve();
  }
  console.log(`↓ ${repo} → ${target}`);
  return new Promise((resolve, reject) => {
    const py = spawn(
      OMLX_PYTHON,
      [
        '-c',
        `from huggingface_hub import snapshot_download
snapshot_download(repo_id=${JSON.stringify(repo)},
  local_dir=${JSON.stringify(target)},
  ignore_patterns=['*.pt', '*.bin'])`,
      ],
      { stdio: 'inherit' },
    );
    py.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`download exited ${code}`)),
    );
  });
}

async function main() {
  const { tiers } = parseArgs(process.argv);
  if (!existsSync(OMLX_PYTHON)) {
    console.error(
      `oMLX Python not found at ${OMLX_PYTHON}. Install oMLX first:\n` +
        `  brew install jundot/omlx/omlx`,
    );
    process.exit(2);
  }
  // De-dup by HF repo: in case a future tier remap introduces sharing
  // (each tier currently maps to a distinct repo since the v0.6.0 fix
  // that pointed B at 4B-Instruct-2507 instead of 8B).
  const seen = new Set();
  for (const t of tiers) {
    const m = MODELS[t];
    if (!m) {
      console.error(`Unknown tier: ${t}`);
      process.exit(2);
    }
    if (seen.has(m.repo)) continue;
    seen.add(m.repo);
    await downloadOne(m.repo, m.dir);
  }
  console.log('\nDone. Start oMLX:  brew services start jundot/omlx/omlx');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
