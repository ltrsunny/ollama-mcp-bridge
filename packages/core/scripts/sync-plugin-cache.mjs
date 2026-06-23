#!/usr/bin/env node
// Dev DX tool — NOT shipped in the npm package (package.json "files" excludes scripts/).
//
// The live plugin (MCP server + enforce-bridge hook) runs from a version-FROZEN Claude Code cache
// copy, decoupled from this repo: `npm run build` updates packages/core/dist but NOT the cache, and
// editing a hook doesn't reach the cache either. Making a repo change "live" used to be a manual,
// remember-the-steps ritual (cp dist → cache, cp hooks → cache, kill the serve PID, restart CC) — a
// pure memory-crutch (see memory plug-and-play-not-memory). This collapses it into one command:
// `npm run sync:plugin`.
//
//   dist  → rm+cp into cache, then SIGTERM `cli.js serve` so the client respawns the fresh build on
//           the next bridge call (LIVE immediately, no Claude Code restart).
//   hooks → cp into cache; hook changes still need a Claude Code RESTART (or /hooks reload) to load,
//           so the script reminds you — but only when a hook actually changed.
//
// Idempotent: each surface is diffed first and skipped when unchanged (so a no-op re-run won't
// needlessly bounce the serve process). `--dry-run` reports what it WOULD do, touching nothing.

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync, rmSync, cpSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..'); // packages/core/scripts → repo root
const DRY = process.argv.includes('--dry-run');
const log = (...a) => console.log('[sync-plugin-cache]', ...a);

const repoDist = join(repoRoot, 'packages', 'core', 'dist');
if (!existsSync(repoDist)) {
  console.error(`[sync-plugin-cache] repo dist missing at ${repoDist} — run \`npm run build\` first.`);
  process.exit(1);
}

// Cache version root(s): ~/.claude/plugins/cache/local-mcp-toolbelt-marketplace/local-mcp-toolbelt/<ver>
const cacheBase = join(
  homedir(), '.claude', 'plugins', 'cache',
  'local-mcp-toolbelt-marketplace', 'local-mcp-toolbelt',
);
const verRoots = existsSync(cacheBase)
  ? readdirSync(cacheBase, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(cacheBase, e.name))
  : [];

if (verRoots.length === 0) {
  log(`no plugin cache under ${cacheBase} — nothing to sync (plugin not cache-installed?). OK.`);
  process.exit(0);
}

// Runtime surfaces I iterate on (NOT plugin metadata / docs — those are the distribution contract).
// All are rm+cp'd so the cache exactly mirrors the repo (a file deleted/renamed in the repo also
// vanishes from the cache). `kind` only selects how a change goes live:
//   'dist'  → SIGTERM the serve process; the client respawns the fresh build on the next call.
//   'hooks' → needs a Claude Code restart (hooks load at startup, not per-call).
const surfaces = [
  { kind: 'dist',  label: 'MCP server dist',      src: repoDist,                              rel: join('packages', 'core', 'dist') },
  { kind: 'hooks', label: 'enforce-bridge hooks', src: join(repoRoot, '.claude', 'hooks'),    rel: join('.claude', 'hooks') },
  { kind: 'hooks', label: 'hooks.json',           src: join(repoRoot, 'hooks'),               rel: 'hooks' },
];

function dirsDiffer(a, b) {
  if (!existsSync(b)) return true;
  try { execFileSync('diff', ['-rq', a, b], { stdio: 'pipe' }); return false; }
  catch { return true; } // diff exits non-zero when they differ (or errors) → treat as "sync needed"
}

let distSynced = false;
let hooksChanged = false;

for (const vroot of verRoots) {
  log(`cache: ${vroot}`);
  for (const s of surfaces) {
    if (!existsSync(s.src)) { log(`  - ${s.label}: repo src missing (${s.src}) — skip`); continue; }
    const dest = join(vroot, s.rel);
    if (!dirsDiffer(s.src, dest)) { log(`  · ${s.label}: unchanged`); continue; }
    if (s.kind === 'dist') distSynced = true; else hooksChanged = true;
    if (DRY) { log(`  [dry-run] would sync ${s.label} → ${dest}`); continue; }
    rmSync(dest, { recursive: true, force: true });
    cpSync(s.src, dest, { recursive: true });
    log(`  ✓ ${s.label} → ${dest}`);
  }
}

// dist changes go live by respawn: SIGTERM the serve process(es). (Cache cmdline has
// "local-mcp-toolbelt" + "cli.js serve"; this script's own path .../ollama-claude/... matches neither.)
if (distSynced) {
  let pids = [];
  try {
    pids = execFileSync('pgrep', ['-f', 'local-mcp-toolbelt.*cli\\.js serve'], { encoding: 'utf8' })
      .split('\n').map((s) => s.trim()).filter(Boolean);
  } catch { /* pgrep exits 1 with no match */ }
  if (pids.length === 0) {
    log('serve: none running — client spawns the fresh build on next call.');
  } else {
    for (const pid of pids) {
      if (DRY) { log(`[dry-run] would SIGTERM serve pid ${pid}`); continue; }
      try {
        process.kill(Number(pid), 'SIGTERM');
        log(`✓ killed serve pid ${pid} — respawns fresh on the next bridge call`);
      } catch (e) {
        log(`could not kill pid ${pid}: ${e.message}`);
      }
    }
  }
} else {
  log('dist: unchanged — serve left running.');
}

if (hooksChanged) {
  log('⚠ hooks changed → RESTART Claude Code (or open /hooks) to load them. dist is already live via respawn; hooks are NOT.');
}

log(DRY ? 'dry-run complete.' : 'done.');
