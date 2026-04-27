# CLAUDE.md — project conventions for Claude Code sessions

This file is auto-injected into every Claude Code session opened in this repo.
Highest priority context. Keep under 200 lines.

## What this project is

`ollama-mcp-bridge` — Apache-2.0 Node 22+ MCP server. Lets any MCP client (Claude
Desktop, Cursor, Cline, OpenClaw, Zed, …) delegate lightweight tasks to a local
Ollama daemon to save frontier tokens, stay private, and run offline.

Monorepo: `packages/core/` is the publishable package. Shipped at v0.2.0;
v0.3.0 in flight (see `docs/scope-memos/v0.3.0-decision-2026-04-27.md`).

## Tools currently exposed (6)

| Tool | Tier | Notes |
|---|---|---|
| `summarize` | B (qwen3:4b) | Up to ~2 K words |
| `summarize-long` | C (qwen2.5:7b, num_ctx=32 K) | Up to ~25 K words single-call |
| `summarize-long-chunked` | C | Map-reduce; full chunking only reachable from clients with > 60 s timeout |
| `classify` | B | Grammar-constrained labels |
| `extract` | B | Grammar-constrained JSON Schema |
| `transform` | B | Free-form rewrite |

All four text tools accept `source_uri` (file:// or http(s)://) — preferred over
inline `text` because raw bytes never enter the frontier context.

## Hard constraints (non-negotiable)

- **Claude Code MCP request timeout is a hardcoded ~60 s wall-clock.** Cannot be
  raised via `settings.json` or any documented env var. Per-call must stay
  under this wall. v0.3.0's async-job pattern is the structural fix.
- **16 GB Mac is the dev hardware**. Ollama serializes on Metal so concurrent
  calls add queueing, not parallelism. Tier C `num_ctx=32768` uses ~6.7 GB total.
- **Apache-2.0 license**. New deps must be permissive (Apache / MIT / BSD / ISC).
  Workspace-root `overrides.uuid` ^14 keeps `npm audit` clean.
- **Node 22+, TypeScript strict, vitest, raw `tsc` build (no bundler)**. Unpacked
  `dist/` size ≈ runtime cost; tree-shaking does not apply.

## Architecture

- `LlmBackend` interface (`src/llm/backend.ts`) — neutral contract: `chat`,
  `countTokens`, `ping`. AbortSignal threads through `chat`.
- `OllamaBackend` is the only current implementation.
- `backendForTool(client, config, toolName)` resolves tier → backend instance.
- All 5 v0.1.x tools migrated to call `backendForTool(...).chat()` not
  `client.chat()` directly. `migration-snapshot.test.ts` is the byte-identical
  guard against migration regressions.
- Chunking: `src/chunking/{prompts,split,map-reduce}.ts` + `p-limit` for
  bounded fan-out. Each per-call timeout is `AbortSignal.any([jobSignal,
  AbortSignal.timeout(50_000)])`.

## Testing layout

- `npm test` (in `packages/core/`) → 59 unit tests via vitest. Pure in-process,
  no Ollama required. Runs in CI.
- `node tests/smoke-bridge.mjs` → 58 Tier-2 smoke checks against a real Ollama
  daemon. Excluded from CI (needs models). Run locally before any release.
- `node tests/probe-numctx.mjs` and `tests/diag-long-input.mjs` are diagnostic
  scripts for failure-mode investigation.

## Process expectations (feature-intake-rule)

Any new feature MUST go through:
1. **Prior Art Review** (≥3 candidates) — see `docs/prior-art/`
2. **Scope memo** with Auditor pass — see `docs/scope-memos/`
3. THEN code

The Auditor is the user. No code lands ahead of an approved scope memo.

## Bridge-usage discipline (for Claude Code itself)

The whole point of this project is for Claude Code to USE the bridge to save
its own tokens. Real practice during v0.2.0 cycle: < 5 % usage. Doing better
now:

- **Any > 1 KB external research output (Gemini / Copilot return, paper PDF,
  podcast transcript)**: feed via `source_uri` if URL exists, else save to
  `/tmp/...` and use `file://`. Inline `text` only for content already in
  context.
- **Multi-AI critique cycles**: pipe outputs between Gemini and Copilot via
  bash, NOT through frontier. Frontier reads only the final consolidated view.
- **Long file reads before precise edit**: still required (no shortcut).
- **Long file reads NOT before precise edit** (just understanding): use
  `summarize-long-chunked` with `source_uri` to compress.

## Token-saving tactics that worked in v0.2.0

- `tsc | head -n 50` instead of full compiler error dumps
- `grep` + targeted `Read` with `offset/limit` instead of full-file `Read`
- Bash `cat A | gemini -p ...` to keep large file content out of frontier
- Background tasks (`run_in_background`) so frontier doesn't wait synchronously

## Things to push back on (challenge user / self)

- More than 2-3 audit rounds on the same scope memo → diminishing returns
- "Boilerplate" commit messages > 30 lines → over-stating the work
- Reading external research output in full before knowing what we're looking
  for → use `extract` with a specific query first
- Doing yet another scope memo when real usage data would resolve the question
  → ship and observe instead

## Outside-help cheat sheet

- **Gemini CLI** (`gemini -m gemini-3.1-pro-preview --yolo -p ...`): best for
  divergent web research, adversarial scope-memo reviews, multi-source PA
  surveys. Pro subscription, generous quota.
- **Copilot CLI** (`copilot -p ... --effort xhigh --allow-all-tools`): GitHub-
  MCP integrated. Best for narrow `get_file_contents` lookups; broad
  `search code` returns spill to disk and Copilot won't read them back. Free
  tier 50 premium/month.
- **The bridge itself** for everything that fits — see "Bridge-usage
  discipline" above.

## Files to know

- `docs/scope-memos/` — feature scope memos (Auditor-passed before
  implementation)
- `docs/prior-art/` — Prior Art Review outputs
- `docs/notes/` — research notes (no Auditor required, lighter-weight)
- `CHANGELOG.md` — Keep a Changelog format, SemVer. Version-sync enforced via
  `prepublishOnly`.
