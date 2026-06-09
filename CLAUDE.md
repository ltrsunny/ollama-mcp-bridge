# CLAUDE.md — project conventions for Claude Code sessions

This file is auto-injected into every Claude Code session opened in this repo.
Highest priority context. Keep under 200 lines.

## What this project is

`local-mcp-toolbelt` — Apache-2.0 Node 22+ MCP server. Lets any MCP client (Claude
Desktop, Cursor, Cline, OpenClaw, Zed, …) delegate lightweight tasks to a local
oMLX inference server to save frontier tokens, stay private, and run offline.

Monorepo: `packages/core/` is the publishable package, shipped to npm as
`local-mcp-toolbelt`. Install: `npm i -g local-mcp-toolbelt` (bin: `local-mcp`).
Version + change history → `CHANGELOG.md` / `package.json`.

## Tools currently exposed (7)

| Tool | Tier | Notes |
|---|---|---|
| `summarize` | B | Up to ~2 K words |
| `summarize-long` | C (numCtx=32 K) | Up to ~25 K words single-call |
| `summarize-long-chunked` | C | Map-reduce; full chunking only reachable from clients with > 60 s timeout |
| `classify` | B | Strict-schema enum labels via oMLX json_schema |
| `extract` | B | Strict-schema JSON via oMLX json_schema |
| `transform` | B | Free-form rewrite |
| `diff-semantic-index` | B | Structured diff classifier (count tracked in `MAX_OUTPUT_TOKENS`) |

All tools accept `source_uri` (file:// or http(s)://) — preferred over
inline `text` because raw bytes never enter the frontier context.

## Tier system (all oMLX)

| Tier | Model | numCtx | Status |
|---|---|---|---|
| B | Qwen3-4B-Instruct-2507-4bit | 8192 | ✅ default — short tasks |
| C | Qwen3-8B-4bit | 32768 | ✅ long-form summarize |

Tier D (`Qwen3-14B-4bit`) is **opt-in only** — 4-bit 14B (~7-8 GB) +
6 GB hot_cache → OOM-prone on 16 GB Mac. Enable via
`toolTierMap` + `npm run download-models -- --tiers B,C,D`.

Single backend = `MlxHttpBackend` against `http://127.0.0.1:8000` (oMLX).
Start:  `brew services start jundot/omlx/omlx`. Weights: `npm run
download-models` (B+C by default). oMLX `json_schema` strict mode
replaces llama.cpp's GBNF; enum + required enforced at decode.
`summarize-long`+`extract` stay on B/C — long prefill+decode hit
Claude Code's 60 s wall on larger tiers. **MLX RSS is misleading**
(unified-mem mapped, use wall-time). See
`docs/notes/v0.6.0-60s-wall-brainstorm-2026-05-11.md`.

## Per-tool output caps

`MAX_OUTPUT_TOKENS` in `src/mcp/server.ts` (mirrored in
`tests/eval/lib/invoke.mjs`) — semantic ceilings, not tier-driven:

| Tool | Cap | Note |
|---|---|---|
| `summarize` | 600 | 1-2 paragraphs |
| `summarize-long` | 1200 | structured summary, ≤6 bullets |
| `classify` | 200 | labels + brief reason |
| `transform` | 1200 | instruction-driven |
| `extract` | 2048 | schema-driven (kept) |
| `diff-semantic-index` | 1024 | structured fields (kept) |

## Hard constraints (non-negotiable)

- **Claude Code MCP request timeout is a hardcoded ~60 s wall-clock.** Cannot be
  raised via `settings.json` or any documented env var. Per-call must stay
  under this wall. v0.3.0's async-job pattern is the structural fix.
- **16 GB Mac is the dev hardware**. oMLX serializes on Metal (calls queue).
  8B+14B ≈ 13 GB resident — tight; one tier hot per session.
  `hot_cache_max_size=6GB` in `~/.omlx/settings.json`. **Engine = brew STABLE
  `omlx 0.4.2` (verified 2026-06-09: strict json_schema + no terminate-crash on
  moderate decode). The old HEAD-pin (post-2026-05-11 + #1126/#1146/#1101 crash
  fixes) is DROPPED — 0.4.2's `--memory-guard {safe,balanced,aggressive}` +
  paged-ssd-cache supersede them.** So plug-and-play install can use
  `brew install jundot/omlx/omlx` (stable; builds from source ~2 min, no bottle).
  MlxHttpBackend has a circuit-breaker for mid-request abort. NB: `omlx serve
  --port N` PERSISTS the port into `~/.omlx/settings.json` (`server.port`) — keep
  it `8000` (the bridge default). See `docs/notes/v0.5.x-omlx-stability-2026-05-11.md`.
- **Apache-2.0 license**. New deps must be permissive (Apache / MIT / BSD / ISC).
  Workspace-root `overrides.uuid` ^14 keeps `npm audit` clean.
- **Node 22+, TypeScript strict, vitest, raw `tsc` build (no bundler)**. Unpacked
  `dist/` size ≈ runtime cost; tree-shaking does not apply.

## Architecture

- `LlmBackend` interface (`src/llm/backend.ts`) — neutral contract: `chat`,
  `countTokens`, `ping`. AbortSignal threads through `chat`.
- `MlxHttpBackend` (`src/llm/mlx-http-backend.ts`) — the only implementation
  in v0.6.0. Speaks OpenAI-compatible HTTP to oMLX; uses `response_format:
  {type: "json_schema", strict: true}` for grammar enforcement.
- `backendForTool(config, toolName)` resolves tier → memoized MlxHttpBackend
  instance keyed by `(mlxUrl, mlxModelName)`.
- All tools call `backendForTool(...).chat()`. `migration-snapshot.test.ts`
  captures the deterministic ChatOptions payload per tool as the contract.
- Chunking: `src/chunking/{prompts,split,map-reduce}.ts` + `p-limit` for
  bounded fan-out. Each per-call timeout is `AbortSignal.any([jobSignal,
  AbortSignal.timeout(50_000)])`.

## Testing layout

- `npm test` (in `packages/core/`) → unit tests via vitest. Pure in-process,
  no oMLX required (all backend calls go through a `RecorderBackend` test
  double via `_installTestBackend`). Runs in CI.
- `node tests/probe-numctx.mjs` and `tests/diag-long-input.mjs` are diagnostic
  scripts for failure-mode investigation against a real oMLX server.

## Process expectations (feature-intake-rule)

Any new feature MUST go through:
1. **Prior Art Review** (≥3 candidates) — see `docs/prior-art/`
2. **Scope memo** with Auditor pass — see `docs/scope-memos/`
3. THEN code

The Auditor is the user. No code lands ahead of an approved scope memo.

## Bridge-usage discipline (enforced by hook, not honour-system)

`.claude/hooks/enforce-bridge.sh` is a PreToolUse hook on **Read** that
*physically blocks* large raw reads (exit 2), routing them to the bridge.
Enforcement is **Read-only** (no Bash command-scanning — string-parsing shell
commands was unsound + false-block-prone). Threat model = **agent
self-discipline / token economy, NOT security** (→ low false-positive, tolerate
false-negative). Detail:
`.claude/brainstorm/bridge-hook-threat-model-2026-05-29.md`.

Plugin marketplace distribution is **deferred** (structural blocker — plugin
meta at repo root vs `dist/` gitignored; npm-only for now). See `two-repo-workflow`
memory + `.claude/brainstorm/plugin-file-layout-structural-brief-2026-05-26.md`.

Three Read enforcement bands (threshold 4 KB):
- **External files** — outside project + `~/.claude` + `~/.omlx`. Route via `source_uri`.
- **Project analysis paths** — `.claude/brainstorm`, `.claude/diagnostics`,
  `docs/notes`, `docs/scope-memos`, `docs/prior-art`. Edit-mode marker:
  `touch .claude/.bridge-edit-mode` (auto-expires 60 min, override
  `OMCP_HOOK_MARKER_EXPIRE_SEC`; `rm` to exit; git-ignored).
- **Project-internal data files** by extension — `*.log`, `*.diff`, `*.jsonl`,
  `*.ips`, `*.ndjson`, `*.csv`.

Source code / configs / small notes inside the project stay allow-listed —
surgical edits still need raw bytes. Long *understanding* (no edit): use
`summarize-long-chunked` with `source_uri`. Multi-AI critique cycles pipe
between Gemini/Copilot via bash, NOT through frontier.

Token-saving tactics still: `tsc | head -n 50`; `grep` + `Read offset/limit`; `run_in_background` for long shells.

## Things to push back on (challenge user / self)

- More than 2-3 audit rounds on the same scope memo → diminishing returns
- "Boilerplate" commit messages > 30 lines → over-stating the work
- Reading external research output in full before knowing what we're looking
  for → use `extract` with a specific query first
- Doing yet another scope memo when real usage data would resolve the question
  → ship and observe instead

## Outside-help cheat sheet

- **Gemini family** (helpers.sh; full taxonomy in
  `.claude/brainstorm/gem-model-strategy-decision-2026-05-18.md`):
  - `gem` — 3.5-flash REST direct, ~2 s, NO agentic.
  - `gem-pro` — 2.5-pro OAuth, agentic; expires 6/18 (override
    `GEM_PRO_MODEL=gemini-3.1-pro-preview` fail-fast, but prefer `agy_pro`).
  - **`copilot-free`** ⚠ — Copilot agentic ReAct via Google API key
    (gemini-3.5-flash). 设计上填 agentic+free+post-6/18 gap，0 Premium 烧。
    **但 2026-05-22 empirical: AI Studio OAI-compat shim 上限 ~17.2K tokens =
    Copilot 17K sysprompt 后 user prompt 只剩 ~200 字符。长 brief 全 400。
    短任务 OK，长 fan-out brief 不可用。** Cross-provider picker 设计已 fan-out
    收敛 (cross-provider-byok-picker-brief-2026-05-22.md) 但未实施。
  - **`agy_pro`** ⭐ — Antigravity CLI, sticky `/model`; separate quota pool, survives 6/18.
- **GitHub Models** (`ghm`, `ghm_pro`; helpers.sh): multi-vendor proxy
  via PAT `GITHUB_MODELS_TOKEN`. Free quota 50/day high + 150/day low.
  **Dynamic model selection encapsulated in `_ghm_pick_model` (helpers.sh,
  2026-05-22 iron rule, mirrors NIM)**: fresh `/catalog/models` +
  context-aware filter + 5-tok ping on EVERY call, no env override
  possible. Tier inferred from function: `ghm`=low (15/min·150/day),
  `ghm_pro`=high (10/min·50/day, requires tool-calling capability).
  `custom` tier (gpt-5/o-series/deepseek-r1 reasoning models) handled
  separately if/when `ghm_reason` added. **Catalog drifts** — gpt-5
  family + o1/o3/o4 series sit in custom tier; models deprecate over
  time. Picker estimates context need from prompt+stdin byte length
  /4; if GHM proxy returns "Too many requests" plain-text body the
  call surfaces it explicitly instead of generic parse error.
- **Copilot CLI** (`copilot -p ... --effort xhigh --yolo`): full agentic
  `@github/copilot`. `--yolo` REQUIRED in `-p` (plain `--allow-all-tools`
  silent-hangs on path/URL prompts). Student Pack = Copilot Pro,
  300 premium/month. Best for: cross-repo GitHub-MCP context.
- **Nvidia NIM** (`nv_sum`, `nv_pro`): free OpenAI-compat gateway, ~120
  catalog models but **~40-70% 404 daily** (unstable). **Dynamic model
  selection encapsulated in `_nim_pick_model` (helpers.sh, 2026-05-22
  iron rule)**: fresh `/v1/models` + 5-tok ping on EVERY call, no env
  override possible. Tier inferred from function: `nv_sum`=≤15B,
  `nv_pro`=≥50B, random shuffle within tier. **Anti-pattern**:
  hardcoded model id (e.g. old `NV_PRO_MODEL=qwen3.5-397b`) — pinned
  defaults rot silently when the API 404s, and the silent fallback to
  training-data answers IS the hallucination this rule prevents.
  Picker is family-agnostic; for Subject=Qwen workflows re-roll until
  non-qwen picked, or filter at call site.
- **The bridge itself** for everything that fits — see "Bridge-usage
  discipline" above.

### Tool orchestration: portfolio, not fallback

These tools are configured to run **concurrently and in combination**, not as
a try-A-then-B chain. Each has a niche; non-trivial tasks fan out to ≥2 of
them in parallel and Claude synthesizes.

| Tool | Niche |
|---|---|
| Bridge (`mcp__local-mcp__*`) | Structured `extract` / `classify` / `summarize` / `diff-semantic-index`. Small bounded calls. **Use first** — saves frontier without leaving local. |
| `gem` (3.5-flash, fast) | Fan-out brainstorm voices, short summary / extract / classify. |
| `gem-pro` (2.5-pro, agentic) | Adversarial review, multi-file refactors, web research. Until 6/18. |
| `ghm` (GitHub Models PAT) | OpenAI/DeepSeek/Llama/Mistral/Phi voices, fan-out diversity. 50/day high. |
| `copilot` (Student Pro) | Cross-repo lookups, GitHub-MCP, multi-file refactors. 300 premium/month. |
| `nv_sum` / `nv_pro` (Nvidia NIM) | Offload single-shot reasoning to non-Claude / non-Gemini quota. |
| Me (Claude) | Orchestrator + final synthesis + decisions. |

**Anti-pattern**: serial fallback (`gem` failed → `nv_pro` → bridge).
**Right pattern**: parallel fan-out → Claude synthesizes. ≥2 distinct *platforms* (not just families — see auditor-protocol #14).

Quota emergency (Claude session > 85%): handoff via `/handoff-to-gemini` is the
**fallback** path — but the portfolio above is the **default**.

## Files to know

- `docs/scope-memos/` — feature scope memos (Auditor-passed before
  implementation)
- `docs/prior-art/` — Prior Art Review outputs
- `docs/notes/` — research notes (no Auditor required, lighter-weight)
- `docs/process/commit-discipline.md` — **product** (`feat/fix/release/chore`)
  vs **dev-meta** (`meta(*):`) commits, never mixed (since 2026-05-12).
- `CHANGELOG.md` — Keep a Changelog format, SemVer. Version-sync enforced via
  `prepublishOnly`.
