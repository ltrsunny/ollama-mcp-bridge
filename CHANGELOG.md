# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Theme

**"Multimodal offload — local VLM tier."** Images are the most token-expensive
bytes in the frontier; the bridge gains a vision tier so `extract`, `classify`,
and `summarize` can run over an image `source_uri` locally — raw image bytes
never enter frontier context (the largest per-call frontier saving of any tool).

### Added

- **Tier V** (`Qwen3-VL-4B-Instruct-4bit`, Apache-2.0, ~2.9 GB) — the dedicated
  Qwen3-VL vision-language model, picked via a 9-model bakeoff + hard-suite +
  quant + real-render checks (see `docs/scope-memos/v0.8.0-multimodal-2026-06-16.md`).
  Thinking suppressed via `chat_template_kwargs` (`/no_think` is inert on Qwen3-VL).
- **Image input on `extract` / `classify` / `summarize`** via an image
  `source_uri` (`file://` or `http(s)://`; png/jpg/webp) plus a `modality`
  (`auto` | `image` | `text`) knob; `auto` sniffs by file extension.
- `io/imageReader.ts` — image fetch (SSRF-guarded, shared with the text reader)
  + magic-byte MIME sniff (PDF rejected with a deferred-support message) +
  `sips` downscale to ≤1568 px (dimension-gated so already-small images are not
  re-encoded/bloated).
- `download-models` fetches tier V by default; `--tiers B,C` for a text-only install.
- enforce-bridge hook routes project image reads (png/jpg/jpeg/webp) to the bridge.

### Fixed

- **Oversize text inputs — per-tool plug-and-play handling.** `summarize` now
  AUTO-DELEGATES an over-Tier-B input to the Tier-C chunked map-reduce (single call if it
  fits Tier C, else map-reduce) — it never refuses on size alone. `summarize-long` /
  `extract` / `classify` return an actionable refusal (`summarize-long-chunked` / async-job,
  or — for `extract`/`classify` — split the input, since chunking structured extraction
  would silently corrupt via entity-straddling); the oversized-`extract` hint also points at
  `summarize-long` for digest-class needs. Plus a translation of oMLX's prefill
  memory-guard 400 — instead of an opaque failure on large files.
- **CJK-aware size accounting.** The size guard and the chunker now count CJK glyphs ~1:1
  (the previous flat `chars/3.5` proxy under-counted CJK ~3×, letting CJK-dense input slip
  past the guard into oMLX's prefill memory guard). Latin/code token counts are unchanged.
- **Silent empty completions** — `MlxHttpBackend.chat` now THROWS when oMLX
  returns a 200 with an empty completion (`in=0/out=0` — e.g. a decode abort or a
  prefill memory-guard soft-reject) instead of passing the blank result through as
  success. This funnels through the one shared `chat` path, so it protects every
  tool (summarize/extract/classify/transform) from silently corrupting downstream
  output. (Observed deterministically on a ~9.9 K-token `summarize-long` input.)
- **`summarize-long` RECOVERS from a memory-guard rejection instead of erroring** — when its single
  Tier-C call returns empty (the pressure-dependent oMLX prefill guard, NOT a fixed size ceiling), it
  transparently falls back to the chunked map-reduce path (smaller per-chunk prefills fit under the
  guard) and returns the summary. An error to the caller is still a failure; genuinely huge inputs that
  even chunking can't fit in the 60 s wall still surface (use the async-job path via `enqueue_job`).
- **SSRF via HTTP redirects** — `safeFetch` re-validates every redirect hop's
  host (`redirect: 'manual'`, ≤3 hops, intermediate bodies cancelled); shared by
  the text and image source readers.
- **Memory DoS** — `readCappedBody` streams the response with a hard byte cap
  (Content-Length preflight + mid-stream cancel) instead of buffering the whole
  body before checking its size.
- `backendForTool` fails cleanly when a forced tier is unconfigured (no
  `TypeError` crash); the backend cache key now includes `thinkingMode`.

### Engine

- Verified + pinned oMLX **0.4.4** — real chat + strict-JSON AND Qwen3-VL image
  + strict-JSON both pass. The 0.4.4-final release fixed the rc1 unicode-escape bug.

---

## [0.6.0] — 2026-05-18

### Theme

**"Async-job triad portable across MCP clients + per-tool thinking
mode."** v0.3.0 shipped `enqueue-job` (kebab) + `wait_for_job`
(long-poll) + `read_job_result`, but the long-poll path needs RFC 6202
support on the client side and the implicit "client has a Bash tool"
assumption was Claude-Code-only. v0.6.0 splits the triad into a
portable pair (`enqueue_job` + `check_progress`) plus optional
Claude-Code shortcuts (`wait_command` returned in `enqueue_job`'s
response, an inline `read_job_result` mode under the 8 KB threshold).
Per-tool thinking mode is now a first-class input on every sync tool
plus an `enqueue_job` field — server resolves to a concrete `on/off`
and persists `thinking_resolved` into job metadata + hashes it into
the dedup key. See `docs/scope-memos/v0.6.0-async-and-thinking-2026-05-11.md`
for the full Draft 2 spec and `docs/scope-memos/v0.7.0-bridge-enforcement-2026-05-15.md`
for the v0.7+ enforcement direction extracted from this cycle's
dogfood pain.

### Added

- **`enqueue_job`** (snake-case, sister of `wait_for_job` /
  `read_job_result`). Strict superset of v0.3.0 `enqueue-job`:
  returns `job_id`, `enqueued_at`, `expires_at`, `result_uri`
  (`file://...<id>.md`), `thinking_resolved` (concrete `on`/`off`),
  and — only when the client advertises bash capability via
  `OMCP_ASSUME_BASH_CLIENT=1` — a `wait_command` POSIX one-liner
  (single-quoted to defend against shell metachars in
  `OMCP_MEMORY_DIR` overrides).
- **`check_progress`** — cross-client universal poll. Instant
  return, no long-poll dependency, no bash dependency. Returns
  `{status: queued|running|done|failed|unknown, progress?, error?}`.
  Clamps `progress` to `[0, 100]` when handler emits
  `current > total` (adversarial-review fix).
- **`read_job_result` inline/file_path mode** — small results
  (≤ `OMCP_INLINE_THRESHOLD_BYTES`, default 8192) return body inline;
  larger results return `{file_path}` so the caller can read on
  demand.
- **Per-tool thinking-mode resolver**
  (`src/config/thinking-defaults.ts`). Registry of default thinking
  `on/off` per tool: `classify` / `extract` / `transform` /
  `diff-semantic-index` default on; `summarize` / `summarize-long` /
  `summarize-long-chunked` default off. `resolveThinking()` picks
  the value: per-call > env (`OMCP_THINKING_<TOOL>`,
  `OMCP_THINKING_MODE`) > registry default.
- **`thinking` parameter on the 6 sync tools** (`'on'|'off'|'auto'`).
- **`MlxHttpBackend` honours `opts.disableThinking`** to suppress
  the model's reasoning trace (faster; used by summarize tools by
  default).
- **`bashSingleQuote()`** helper for wait_command shell escaping
  (POSIX-only — no `[[` or zsh-isms).

### Changed

- **`wait_for_job` description marked DEPRECATED** — recommend
  `check_progress` for portable polling or `wait_command` for the
  Claude-Code-only Bash fast-path. Still maintained through v0.6.x;
  removal in a future major.
- **`enqueue-job` (kebab-case) description marked DEPRECATED** —
  recommend `enqueue_job` (snake-case). Still maintained through
  v0.6.x for backward compat.
- **Job runner deep-clones args** via `structuredClone()` before
  invoking the wrapped tool — defends against handler mutation of
  nested objects in `args` (adversarial-review fix; 3/3 voices in
  gem/copilot/nv_pro flagged the prior shallow spread as race-prone).
- **`enqueue_job` dedup hash includes `thinking_resolved`** — same
  tool + args + thinking returns the same `job_id`; same tool + args
  + different thinking returns a different `job_id`.
- **Tier D demoted** (`Qwen3-14B-4bit`). 4-bit 14B (~7-8 GB) +
  `hot_cache_max_size=6GB` is OOM-prone on 16 GB Mac target hardware;
  v0.6.0 async triad erodes the 60 s wall pressure that originally
  motivated the v0.5.0 Tier D promotion. CLAUDE.md tier table no
  longer lists D; `npm run download-models` defaults to `--tiers B,C`
  (was `B,C,D`). Code path remains — power-user opt-in via a
  user-supplied `toolTierMap` override + `--tiers B,C,D` on download.
  5-voice fan-out 2026-05-15: 0/4 reliable voices to keep as default
  (Qwen-family inside view explicitly disclosed bias and still voted
  against). See `.claude/brainstorm/tier-d-demotion-*` artifacts.
  Caveat: OOM evidence was collected on macOS 25 (Sequoia); macOS 26
  (Tahoe) may relax Metal command-buffer accounting, but the UX math
  is OS-agnostic — 14B (~7-8 GB) + hot_cache (~6 GB) ≈ 14 GB of 16 GB
  unified memory leaves <2 GB for host OS, IDE, and background
  processes. Tier D remains the wrong default for 16 GB regardless of
  macOS version. v0.7+ may re-evaluate on macOS 26 + Foundation Models
  data (queued as separate spike).

### Fixed

- **`download-models` Tier B mapping** (pre-existing bug). Before this
  release `MODELS.B` pointed at `mlx-community/Qwen3-8B-4bit` (same
  repo as Tier C, deduped away); the actual Tier B model
  (`Qwen3-4B-Instruct-2507-4bit`) was never downloaded. Tier B
  routing therefore depended on the model existing locally from
  some other source. **Migration for existing v0.5.x users**: re-run
  `cd packages/core && npm run download-models` after upgrade to
  fetch the 4B-Instruct weights. The script is idempotent — only
  missing models are downloaded.

### Notes

- **Forward-compat with MCP Tasks SEP-2663**: the v0.6.0 async triad
  is a temporary compat layer for clients that don't yet support
  native task return. When SEP stabilises and a major client ships
  native support, the triad sunsets entirely (the 6 sync tools plug
  in directly — they already accept `thinking`).
- Tests: 147 → 207 unit. New coverage: `enqueue_job` v0.6.0 shape,
  `check_progress` status + clamp, runner deep-clone, thinking-resolver
  registry + env overrides, `wait_command` quoting, and the new
  `thinking-mode-behavioural.test.ts` (14 tests asserting boundary
  propagation through `RecorderBackend` for all 7 sync tools, per-call
  overrides, and env-var overrides).
- Cross-client smoke: `scripts/cross-client-smoke.mjs` (run via
  `npm run smoke:cross-client`) exercises the real stdio transport
  end-to-end — spawns the bridge via `node dist/bin/cli.js serve`,
  asserts `initialize`, `tools/list` set membership (12 tools), and a
  representative `check_progress` round-trip. Verifies what
  Claude Desktop / Cursor / Cline will actually see at the JSON-RPC
  protocol layer, not the InMemoryTransport used in the unit suite.
- **Bridge enforcement hook** introduced in v0.5.0 was extended this
  cycle to also gate project-internal "analysis paths" (.claude/
  brainstorm, .claude/diagnostics, docs/notes, docs/scope-memos,
  docs/prior-art) and data-file extensions (*.log, *.diff, *.jsonl,
  *.ips, *.ndjson, *.csv) above 4 KB. Seed for the v0.7+ scope memo
  on shipping `omcp install-hooks` as a first-class product feature.

### Upstream (no code in this release)

- `jundot/omlx#1106` — three follow-ups posted this cycle bringing
  Metal command-buffer OOM error code
  (`kIOGPUCommandBufferCallbackErrorOutOfMemory`, IOKit 0x00000008)
  to the maintainer's attention. Persistent stderr mirror at
  `~/.omlx-persistent.log` (set up 2026-05-12) captured the first
  clean exception text on 2026-05-15.

---

## [0.5.1] — 2026-05-11

### Theme

**"Stabilize against the oMLX SIGABRT abort surface."** Two crashes on
2026-05-10 + 2026-05-11 traced to MLX's `mlx::core::gpu::check_error`
throwing a C++ exception from a Metal command-buffer completion handler
with no `try { } catch (...) { }` in the oMLX wrapper —
`std::__terminate → abort()` tore down the inference server mid-request.
Upgrading oMLX to HEAD (post-2026-05-11 — includes upstream PRs #1126
OOM guard, #1146 async_eval cache-store, #1101 hot-cache flush) reduces
the trigger rate considerably (classify-scale calls stop reproducing).
**It does NOT add the missing try/catch**, so longer decodes still
abort; the local `MlxHttpBackend` circuit-breaker (now covering both
`fetch()` rejection and undici stream-`terminated`) is what makes the
client side transparent through a launchd-managed restart. See the
2026-05-11 15:08 correction note in
`docs/notes/v0.5.x-omlx-stability-2026-05-11.md` for the third crash
that triggered the marker-list expansion.

### Added

- **`MlxHttpBackend` circuit-breaker**: when the underlying `fetch` fails
  with a connection-reset class error (ECONNRESET / ECONNREFUSED /
  socket-hang-up / `fetch failed` from undici / undici `terminated` on
  mid-stream abort) — symptomatic of oMLX aborting mid-request while
  launchd auto-restarts it — the backend now polls `/health` for up to
  5 s and retries the chat request once. HTTP 4xx/5xx, authentic JSON
  parse errors, and caller-cancelled aborts still propagate immediately.
  The `terminated` marker specifically covers the failure mode where
  oMLX SIGABORTs during decode after headers have already been sent
  (manifests as `TypeError: terminated` in `response.json()`).
- Internal-only `_restartPollBudgetMs` / `_restartPollIntervalMs`
  `MlxHttpBackendOptions` for tests to override the 5 s / 200 ms defaults.

### Changed

- `~/.omlx/settings.json` `hot_cache_max_size`: documented safe value
  lowered from `10GB` → `6GB` for 16 GB-Mac dev hardware (10 GB
  triggered the abort surface above; 6 GB leaves the system ~4 GB
  headroom while still keeping Tier D warm).
- `CLAUDE.md` outside-help cheat-sheet: `copilot --yolo` now flagged as
  required in `-p` mode — plain `--allow-all-tools` silently hangs
  on permission prompts that headless mode can't answer.

### Fixed

- 16-minute permission-denied retry loop when `copilot -p` was launched
  with only `--allow-all-tools` (covers tools, not paths or URLs).
  `--yolo` (= `--allow-all-tools` + `--allow-all-paths` + `--allow-all-urls`)
  is now the documented flag.

### Notes

- Crash diagnostics archived locally at `.claude/diagnostics/`
  (`.ips` files are gitignored; the `upstream-bug-report.md` draft is
  committed for future filing against `jundot/omlx`).
- Tests: 152 unit (up from 147) — 5 cases for the circuit-breaker:
  success retry on ECONNRESET, success retry on undici `terminated`,
  no retry on HTTP 500, no retry on caller-aborted signal, "did not
  recover" propagation when oMLX never comes back within budget.
- Upstream status: the `check_error` exception path remains unguarded
  in oMLX HEAD-3d62ea0. PRs #1126/#1146/#1101 reduce trigger
  frequency but do not catch the exception. A user-visible report
  to `jundot/omlx` is still recommended after this release.

---

## [0.5.0] — 2026-05-10

### Theme

**"Collapse to single oMLX backend; hard-enforce bridge usage"** — both
Ollama and llama.cpp backends were removed in favor of a single
`MlxHttpBackend` talking to a local oMLX server (`jundot/omlx`). All
three tiers (B/C/D) now serve different MLX models out of one process.
`.claude/settings.json` ships a `PreToolUse` hook that blocks direct
external file reads >1 KB and routes Claude back through the bridge.
See `docs/scope-memos/v0.5.0-shipped-2026-05-10.md` for the full
post-mortem and `v0.5.0-threat-model-2026-05-10.md` for the
single-user-machine threat model.

### Breaking changes

- **Package name**: `ollama-mcp-bridge` → `local-mcp-toolbelt`
- **Binary**: `ollama-mcp` → `local-mcp` (e.g. `local-mcp serve`)
- **MCP server self-name & client key**: `ollama-bridge` →
  `local-mcp-toolbelt`. Update your MCP client config:
  ```json
  { "mcpServers": { "local-mcp-toolbelt": { ... } } }
  ```
  Tool prefix becomes `mcp__local-mcp-toolbelt__classify` etc.
- **`TierConfig` shape**: `model?`, `modelPath?`, `keepAlive?` fields
  removed. Replaced by `mlxUrl?` + `mlxModelName?`. Existing user
  configs using the old fields throw at config-resolve time with a
  clear migration message.
- **CLI flags**: `--tier-{b,c}-model` and `--tier-{b,c}-path` removed.
  Replaced by `--mlx-url` and `--tier-{b,c,d}-model` (which now mean
  *MLX model names*, not Ollama tags).
- **No more Ollama daemon** is acceptable: `ollama` package removed
  from dependencies. No more llama.cpp either: `node-llama-cpp`
  removed.
- **GGUF files no longer used**: replace with MLX weights under
  `~/.omlx/models/`. Run `npm run download-models` to fetch defaults.

### Added

- **`MlxHttpBackend`** (`src/llm/mlx-http-backend.ts`) — only
  `LlmBackend` implementation. Speaks OpenAI-compatible HTTP to oMLX,
  uses `response_format: { type: "json_schema", strict: true }` for
  schema enforcement, auto-injects `\n/no_think` into user content for
  Qwen3 thinking models.
- **`MlxHttpBackend.normalizeForStrictMode()`** — patches every object
  node in a JSON Schema with `additionalProperties: false` + full
  `required` lists so oMLX strict mode actually engages (without this,
  oMLX silently falls back to unconstrained mode).
- **`MAX_OUTPUT_TOKENS`** per-tool budgets (`src/mcp/server.ts`):
  summarize 600, summarize-long 1200, classify 200, transform 1200,
  extract 2048, diff-semantic-index 1024. Mirrored in
  `tests/eval/lib/invoke.mjs`.
- **Tier D** (Qwen3-14B-MLX-4bit at numCtx=16384) opt-in via
  `toolTierMap` override. Routable for `classify` + `transform` per
  capped-eval data; `summarize-long` and `extract` stay on B/C.
- **`PreToolUse` hook** (`.claude/hooks/enforce-bridge.sh`,
  `.claude/settings.json`) — exit-2 blocks direct reads of external
  files >1 KB; injects `mcp__local-mcp-toolbelt__*` tool name + the
  matching `source_uri` pattern back into the model's context.
- **`npm run download-models`** — fetches the three default MLX
  weights (4B-Instruct, 8B, 14B) into `~/.omlx/models/` via oMLX's
  bundled Python.
- **CLI**: `--mlx-url`, `--tier-b-model`, `--tier-c-model`,
  `--tier-d-model` flags.

### Removed

- **`OllamaBackend`**, **`OllamaClient`**, **`OllamaDaemonError`**,
  **`LlamaCppBackend`**, all backend-factory branches for Ollama and
  llama.cpp paths. Single MLX HTTP path remains.
- **`tests/smoke-bridge.mjs`** — the Ollama-daemon-coupled 58-test
  smoke harness. No replacement ships in v0.5.0; tracked as v0.6.0
  follow-up F4 (eval-as-smoke harness).
- **`models` and `catalog` CLI subcommands** — relied on the Ollama
  daemon HTTP API.
- **Runtime deps**: `ollama@^0.6.3`, `node-llama-cpp@^3.18.1`.

### Changed

- **Tier B default**: `qwen3:4b-instruct-2507-q4_K_M` (Ollama tag) →
  `Qwen3-4B-Instruct-2507-4bit` (MLX dir name). The "Instruct-2507"
  variant is non-thinking; bare Qwen3-4B is a thinking model that
  burns the per-tool cap on reasoning.
- **Tier C default**: `qwen2.5:7b` (Ollama) → `Qwen3-8B-4bit` (MLX) at
  numCtx 32 768. Qwen3-8B is a thinking model; bridge auto-injects
  `/no_think` to disable the reasoning trace at call time.
- **Migration snapshot test contract** (`tests/unit/migration-snapshot.test.ts`):
  was Ollama-vocabulary fields (`model`, `keepAlive`, `numPredict`).
  Is now the v0.5.0 `LlmBackend.ChatOptions` payload — purely
  vocabulary-neutral.
- **`sanitizeSchemaForOllama` → `sanitizeSchemaForStrictMode`** — same
  behaviour (strips `pattern`, `format: email/uri`, `$ref`), accurate
  name for the oMLX strict-mode regime it now serves.
- **README, `packages/core/README.md`, CLAUDE.md** — rewritten for the
  oMLX architecture. Old llama.cpp / Ollama prose deleted.

### Fixed

- **Tier B thinking-mode bug**: bare Qwen3-{4,8,14}B emit
  `<think>...</think>` reasoning before output, exhausting the per-tool
  `MAX_OUTPUT_TOKENS` cap (200 tokens for classify) before producing
  any JSON. Fixed by switching Tier B to the explicit-non-thinking
  Instruct-2507 variant + universal `/no_think` user-content suffix
  for Tier C/D thinking variants.
- **OpenAI Structured Outputs strict-mode silent fallback**: requests
  without `additionalProperties: false` AND `required: <all keys>` on
  every object node were accepted by oMLX but with strict disabled,
  yielding unconstrained output that ignored enums and required
  fields. Fixed by `normalizeForStrictMode()` walking the schema.
- **`nv_pro` shell helper config drift**: default model in
  `~/.config/claude-dev/helpers.sh` was `qwen3-coder-480b` but the
  CLAUDE.md cheat-sheet promised `deepseek-v4-pro`. Both updated to
  `qwen/qwen3.5-397b-a17b` (verified live 2026-05-10).

### Runtime dependencies added

(none beyond v0.4.0 base)

### Known follow-ups (not v0.5.0)

| ID | Item | Phase |
|----|------|-------|
| F1 | 4B-Instruct eval matrix re-run (5 trial × 4 task) | v0.6.0 P1 |
| F2 | Type-B docs (per-tier latency tables) | v0.6.0 P2 |
| F3 | Security hardening scope memo | v0.6.0 P3 (parallel) |
| F4 | Eval-as-smoke harness | v0.6.0 P1 |
| F5 | Output-side bridge dogfooding (transform for boilerplate) | v0.7.0+ |

---

## [0.3.0] — 2026-04-27

### Theme

**"Async jobs + diff semantic index"** — breaks through the 60-second MCP wall
by adding a persistent Memory Bank and three async-job tools, and adds a
`diff-semantic-index` tool that distils a `git diff` into a structured JSON
summary for commit-message drafting and CI annotation.

### Added

- **Memory Bank** — file-backed job store at `.memory/jobs/<id>.{json,md}`.
  Jobs persist across bridge restarts. Default TTL 7 days (configurable via
  `ttl_days`). GC runs at server startup and marks orphaned running-jobs
  (from a previous crash) as failed.

- **`enqueue-job` tool** — submits any whitelisted tool call as a background
  job. Returns a `job_id` immediately. Idempotent: repeated calls with
  identical `(tool_name, args)` while the prior job is still queued/running
  return the existing `job_id`. Whitelist: `summarize`, `summarize-long`,
  `summarize-long-chunked`, `classify`, `extract`, `transform`,
  `diff-semantic-index`.

- **`wait_for_job` tool** — long-polls (RFC 6202 style) up to `max_wait_ms`
  (default/cap 45 s, env `OMCP_WAIT_CAP_MS` up to 50 s) for a job to finish.
  Returns `{status: done|failed|running|unknown}`. On client-disconnect the
  underlying job continues; caller can re-attach with the same `job_id`.

- **`read_job_result` tool** — returns the persisted `.md` result body for a
  `done` job. Returns `isError: true` for unknown, expired, not-yet-done, or
  failed jobs.

- **`diff-semantic-index` tool** — Tier B (qwen3:4b) grammar-constrained tool
  that parses a `git diff` into a typed JSON summary:
  `change_type`, 1-sentence `summary`, per-file `files_touched` (role + lines),
  `key_decisions`, `risk_callouts`, `test_coverage_hint`.
  Accepts `diff_text` (≤ ~7 K tokens) or `source_uri` (preferred for large
  diffs; avoids macOS ARG_MAX). Token-budget guard returns `isError` with a
  hint when the diff is too large.

- **`.claude/commands/draft-from-diff`** — slash command for Claude Code that
  captures the staged diff, delegates to `diff-semantic-index` via
  `source_uri`, and composes a conventional-commit message from the JSON.

- **43 new unit tests** (134 total) and **Smoke T10/T11**.

### Fixed

- **`progress-capture.ts`** — `setProgress` is now wrapped in try/catch so a
  disk-write failure (EIO, ENOSPC) during progress reporting cannot abort an
  already-running `backend.chat()` call that has already burned tokens.
- **`registry.ts`** — `writeMetadata` is now persisted *before* mutating
  in-memory `active` / `inflightHashes`. Reversing this order would have left
  ghost jobs (in memory but no on-disk record) when a write failed mid-enqueue.
- **`map-reduce.ts`** `packIntoBuckets()` — now throws an actionable error when
  any single entry exceeds the per-bucket token budget, instead of silently
  passing it to REDUCE where the backend would fail with a confusing
  context-window error.
- **Default `OMCP_MEMORY_DIR`** — now `$HOME/.ollama-mcp-bridge/jobs` instead
  of `$CWD/.memory/jobs`. Fixes the bridge crashing on
  `ENOENT mkdir '//.memory'` when MCP clients (e.g., Claude Desktop) spawn the
  bridge with an empty cwd.

### Runtime dependencies added

| Package | Version | License |
|---|---|---|
| `p-queue` | ^9.2.0 | MIT |
| `nanoid` | ^5.1.9 | MIT |
| `parse-diff` | ^0.12.0 | MIT |

---

## [0.2.0] — 2026-04-25

### Theme

**"Backend-agnostic + chunked"** — introduces a neutral `LlmBackend` interface so v0.3.0 can swap Ollama for llama.cpp without rewriting tool handlers, plus a new `summarize-long-chunked` tool that handles documents past Tier C's single-call ceiling via map-reduce. Bundles the v0.1.3-ish docs / CI / config improvements that accumulated since 0.1.2.

### Added

- **`LlmBackend` interface (`src/llm/backend.ts`)** — narrow neutral contract: `chat(opts, signal?)`, `countTokens(text)`, `ping()`. Anything Ollama-specific (`keep_alive`, the qwen3 `think` flag, native option names) lives on the concrete `OllamaBackend` class. Field renames at the boundary: `numCtx` → `maxInputTokens`, `numPredict` → `maxOutputTokens`. v0.3.0's `LlamaCppBackend` will be a parallel implementation.
  - `chat()` accepts an `AbortSignal` so chunked jobs can cancel cleanly when the MCP client disconnects (the SDK already passes a client-cancellation signal as `extra.signal`, verified at `@modelcontextprotocol/sdk/.../shared/protocol.d.ts:177`).
  - `countTokens()` lives on the interface so v0.3.0's llama-server `/tokenize` endpoint can replace js-tiktoken's proxy without a chunker refactor.

- **`OllamaBackend` (`src/llm/ollama-backend.ts`)** — implements `LlmBackend` against the existing `OllamaClient`. `countTokens` uses `js-tiktoken` (cl100k_base) as a proxy with explicit ~20 KB string slicing and `setImmediate` yields between segments to keep the Node event loop responsive on 100 K-token+ documents.

- **`backendForTool()` factory (`src/mcp/backend-factory.ts`)** — resolves `(BridgeConfig, toolName)` → `OllamaBackend`. v0.3.0 will branch on a backend-selector to return either `OllamaBackend` or `LlamaCppBackend`.

- **`summarize-long-chunked` tool** — map-reduce chunked summarization. Splits the source into overlapping ~2000-token chunks (configurable), summarizes each in parallel via `p-limit`, then recursively combines chunk summaries until one bucket fits a single REDUCE call.
  - Routes to Tier C (qwen2.5:7b), same model as `summarize-long`.
  - Per-call soft timeout 50 s via `AbortSignal.any([jobSignal, AbortSignal.timeout(50_000)])` chaining.
  - REDUCE bucket budget 3 K tokens (sized so `prompt-eval + generation ≤ 50 s` even under thermal-throttling on a 16 GB Mac; full math in `docs/scope-memos/v0.2.0-backend-abstraction-and-chunked-summarize.md` §5.2).
  - Recursion depth ≤ 3; beyond that the tool returns `partial: true` with the first bucket reduced (intro / thesis preserved, not the appendix-tail).
  - Fast-path: if the source fits Tier C in one call, the tool runs as a single `summarize-long`-equivalent call (no chunking tax). Makes the chunked tool a strict superset.
  - Failure isolation: per-chunk MAP errors substitute placeholders and bump `_meta.chunks_failed`; REDUCE-call errors in intermediate buckets do the same and bump `_meta.reduce_failed`; terminal-reduce errors degrade gracefully to "join chunk summaries + `partial: true`" instead of discarding all MAP work.

- **Configuration** — three new env vars affecting only the chunked tool:
  - `OMCP_CHUNK_SIZE` (default 2000): target tokens per chunk.
  - `OMCP_CHUNK_OVERLAP` (default 200): overlap between adjacent chunks.
  - `OMCP_CHUNK_CONCURRENCY` (default 2): MAP fan-out cap.

- **`OLLAMA_HOST` env var support** — `serve` and `models` CLI commands honor the standard `$OLLAMA_HOST` (the same one Ollama itself recognizes) as a fallback when `--host` isn't passed.

- **Telemetry additions on `_meta`** — `chunks_processed`, `reduce_depth`, `partial`, `chunks_failed`, `reduce_failed`. Footer adds `chunks=N` and `partial` flag. Existing telemetry unchanged.

- **`AbortSignal` propagation through `OllamaClient.chat`** — the `signal` field was declared on `ChatOptions` since 0.1.2 but never wired through. Now it injects the signal via a per-call `Ollama` wrapper with custom `fetch` (the npm package's public API has no per-request signal slot — only class-level `abort()`).

- **`docs/prior-art/summarize-long-chunked.md`** and **`docs/scope-memos/v0.2.0-backend-abstraction-and-chunked-summarize.md`** — Prior Art Review (3 independent passes: Claude / Gemini 2.5 Pro / Gemini 3.1 Pro Preview / Copilot CLI) and 5-draft scope memo with cumulative 14 audit conditions all addressed.

- **`tests/unit/`** — 26 new tests (now 59 total): `ollama-backend.test.ts` (modelId + countTokens), `migration-snapshot.test.ts` (8 scenarios captured pre-migration, asserted byte-identical post-migration), `recorder-client.ts` (test util), `fake-backend.ts` (test util with scriptable delays / aborts), `split.test.ts` (5 chunker cases), `map-reduce.test.ts` (15 orchestrator cases), `abort-propagation.test.ts` (4 AbortSignal scenarios — queue-drain guard, per-call timeout isolation, pre-aborted signal short-circuit, chained-signal direction).

- **Smoke T9** — `tests/smoke-bridge.mjs` adds an end-to-end test of `summarize-long-chunked` against a live Ollama daemon. Asserts `chunks_processed > 1`, `reduce_depth ≥ 1`, footer contains `chunks=N`. Brings total smoke checks from 51 → 58.

### Changed

- **All five existing tools (`summarize`, `summarize-long`, `classify`, `extract`, `transform`) migrated to `LlmBackend`** — their handlers now call `backendForTool(...).chat(...)` instead of `client.chat(...)` directly. Migration is provably non-behavioral: the `migration-snapshot.test.ts` suite captures the deterministic ChatOptions payload reaching `OllamaClient.chat()` for 8 representative scenarios; pre- and post-migration recordings are byte-identical for all 8.

- **Tier C `num_ctx`: 16384 → 32768** — doubles single-call document size from ~12 K to ~25 K words. Closes the silent-left-truncation issue that prompted this work (a 55 K-token podcast transcript was being reduced to 16 384 tokens at the old setting). KV cache rises ~1 GB → ~2 GB; measured total ~6.7 GB on 16 GB Mac. **Latency doubles** (~100 s → ~220 s wall time for a 32 K-token input). Inputs > 25 K words still silently left-truncate by Ollama itself; the structural fix is `summarize-long-chunked` (above).

- **Honest token-savings messaging across all tool descriptions** — `summarize`, `summarize-long`, `extract`, `transform` descriptions and parameter hints now make explicit that real frontier-token savings only happen with `source_uri` ("if you can pass it inline, you already paid for it"). `classify` repositioned away from "saves tokens" toward its real value prop: grammar-constrained reliability that small local models cannot self-enforce.

### Fixed

- **Bridge no longer crashes when Ollama isn't running yet** — `runBridgeServerStdio` previously did `await client.ping()` before MCP registration. After a reboot, Ollama wouldn't yet be up and the bridge subprocess would crash, leaving Claude Code with "bridge load failed" and no actionable signal. The bridge now registers cleanly regardless of Ollama state. If a tool is invoked before Ollama is reachable, `OllamaClient.chat()` raises `OllamaDaemonError` ("Cannot reach Ollama daemon at <host>. Is it running?") which `toolCallError` surfaces to the calling LLM as `isError: true` — actionable, not catastrophic.

- **`OllamaClient.chat()` connection errors wrapped** — ECONNREFUSED / fetch-failed / ENOTFOUND / EHOSTUNREACH from the underlying ollama npm client are now caught and re-thrown as `OllamaDaemonError`, so existing error-message paths produce friendly text. `AbortError` is re-thrown unchanged.

### Dependencies

- Added: `@langchain/textsplitters` ^1.0.1 (MIT, ~104 kB; transitive: `js-tiktoken` ^1.0.21 + `base64-js`, all pure JS / MIT).
- Added: `p-limit` ^7.3.0 (MIT, transitive: `yocto-queue`, also MIT, zero-dep).
- Added: `js-tiktoken` ^1.0.21 (MIT, pure JS port — no WASM, no postinstall — verified against `dqbd/tiktoken/js/README.md` and package.json).
- Workspace-root `overrides.uuid: ^14.0.0` to clear a moderate `@langchain/core` transitive advisory (uuid bug only triggers on the buf-providing v3/v5/v6 paths we don't touch). `npm audit` reports 0 vulnerabilities post-override.

### Diagnostics

- **`tests/diag-long-input.mjs`** — one-off probe that sends a long file through Tier C at multiple `num_ctx` settings and reports `prompt_eval_count`, latency, and output preview, separating silent-truncation / client-timeout / OOM failure modes. Used during 0.1.x to diagnose the truncation bug that motivated the chunking work.

### Infrastructure

- **GitHub Actions CI** — `.github/workflows/ci.yml`, two jobs (build + vitest) × Node 22, 24. Triggered on push to / PRs to `main`. Guardrails: `contents: read` permission, 10-min job timeout, cancel-in-progress concurrency, `fail-fast: false`. Ollama-dependent tests (smoke, num_ctx probe, diag) intentionally excluded — see `CONTRIBUTING.md`.
- **`CONTRIBUTING.md`** — documents the Tier-1 (CI) vs Tier-2 (local-only) test split.
- **README CI badge**.

### Known limits (Claude Code CLI specifically)

The chunked tool is usable from any MCP client with a request timeout > ~5 minutes (Claude Desktop, custom integrations, the smoke harness). **Claude Code CLI has a hardcoded ~60 s MCP wall** that cannot be extended via `settings.json` or any documented env var (see [anthropics/claude-code #5221](https://github.com/anthropics/claude-code/issues/5221), [#22542](https://github.com/anthropics/claude-code/issues/22542)).

From Claude Code, `summarize-long-chunked` is therefore useful in **fast-path mode only** — for documents up to ~12-15 KB Chinese / ~25 KB English (anything that fits one Tier C call comfortably under 60 s). Larger documents force the chunking path, whose total wall time exceeds 60 s and causes Claude Code to time out the MCP request even though each individual Ollama call stays under the per-call 50 s budget. Removing this from the Claude Code path requires either (a) a streaming response shape with intermediate flushes, (b) splitting the chunked job across multiple MCP tool calls coordinated by the frontier, or (c) Anthropic providing a configurable client-side timeout. All three are post-v0.2.0.

---

## [0.1.2] — 2026-04-24

### Theme

**"Prove it saves tokens"** — closes the fundamental gap where delegation via tool arguments was actually *more* expensive than inline processing. Adds direct-read capability so source content never enters the frontier's context window, plus a visible feedback loop so the frontier LLM can see whether it saved anything.

### Added

- **`source_uri` parameter (F2)** — `summarize`, `summarize-long`, `extract`, and `transform` now accept an optional `source_uri: string` (mutually exclusive with `text`). The bridge reads content directly from a `file://` or `http(s)://` URI; raw source never traverses the frontier's context window.
  - `file://`: unrestricted local reads (bridge runs with the user's own filesystem access).
  - `http(s)://`: size cap (default 10 MB, `OMCP_URL_MAX_BYTES`), timeout (default 30 s, `OMCP_URL_TIMEOUT_MS`), content-type allowlist (`text/*`, `application/json`, `application/xml`), SSRF protection.
  - SSRF: private/loopback hosts blocked by default (`OMCP_URL_DENY_PRIVATE=1`); allowlist via `OMCP_URL_HOSTS=host1,host2`.
  - New module: `src/io/sourceReader.ts`.

- **Telemetry footer in `content[]` (F3)** — every successful tool response appends a terse one-line footer as the **last** `content[]` item, visible to the calling frontier LLM:
  ```
  [bridge: qwen3:4b B 1240ms in=230 out=85]
  [bridge: qwen3:4b B 1240ms in=230 out=85 saved~=+210]
  ```
  The `saved~=` field appears only when `source_uri` was used. Opt-out via `OMCP_TELEMETRY_FOOTER=0` (telemetry still emitted in `_meta`).
  - New module: `src/mcp/footer.ts`.

- **Estimated token savings in `_meta` (F5)** — when `source_uri` is used, `dev.ollamamcpbridge/saved_input_tokens_estimate` is emitted alongside `source_uri` and `source_bytes`. Formula: `floor(sourceBytes / 4) − completionTokens`.

- **Explicit `num_ctx` per tier (F1)** — Ollama's runtime default is 4096 regardless of the model's maximum context, causing silent left-truncation on longer inputs. Now set explicitly per tier: Tier B → 8192, Tier C → 16384. Verified by `tests/probe-numctx.mjs` (Tier B: `prompt_eval_count` 6444; Tier C: 6465 — both above the old 4096 cap).

- **New environment variables** — see table in [Environment variables](#environment-variables) section.

### Fixed

- **`classify` `reason` field echoed input verbatim (F4)** — `CLASSIFY_SYSTEM` said "Preserve the source language inside the reason field" without specifying what `reason` should contain; the model correctly interpreted this as "copy the source text." Rewritten to: "write ONE brief sentence explaining your choice, in the same language as the source text." Regression test added to smoke-bridge T4.

- **`summarize-long` mirrored bullet-structured inputs (F4)** — when the source was itself a bullet list, the model would mirror the structure producing 20+ output bullets instead of the promised 3–6. Fixed by adding to `SUMMARIZE_LONG_SYSTEM`: "If the source is itself bullet-structured, collapse related bullets into themes — never mirror the source structure. Never exceed 6 bullets in the output."

- **Summarizer temperature defaulted to Ollama's 0.7 (F4)** — `summarize` and `summarize-long` were missing explicit temperature settings, inheriting Ollama's verbose default. Both now explicitly use 0.2 for deterministic output.

### Tests

- `tests/probe-numctx.mjs` — new script; sends a ~7150-token synthetic input and asserts `prompt_eval_count ≥ 4200` for each tier.
- `tests/smoke-bridge.mjs` — updated to v0.1.2: T1 footer check (F3), T4 reason regression (F4), T8 new (`source_uri` file:// round-trip, footer, savings estimate). 51 checks total (was 43).

### Environment variables added

| Variable | Default | Description |
|---|---|---|
| `OMCP_URL_MAX_BYTES` | `10485760` (10 MB) | Max body size for `http(s)://` reads |
| `OMCP_URL_TIMEOUT_MS` | `30000` (30 s) | Fetch timeout for `http(s)://` reads |
| `OMCP_URL_DENY_PRIVATE` | `1` (on) | Block private/loopback hosts (SSRF protection) |
| `OMCP_URL_HOSTS` | *(unset)* | Comma-separated hostname allowlist for `http(s)://` |
| `OMCP_TELEMETRY_FOOTER` | `1` (on) | Set to `0` to suppress footer in `content[]` |

---

## [0.1.1] — 2026-04-23

### Added

- **`classify` tool (F1)** — delegates text classification to a local Ollama model.
  Uses `format:` JSON-schema grammar to guarantee the response is a valid member
  of the caller-supplied `categories` list. Supports `allow_multiple` and an
  optional `explain` flag that preserves source language in the reason string.

- **`extract` tool (F2)** — structured-data extraction against an arbitrary JSON
  Schema. Key additions:
  - `sanitizeSchemaForOllama()` preprocessor strips constraints that crash the
    Ollama/llama.cpp GBNF grammar compiler (`pattern`, `format: email|uri|date-time`,
    `multipleOf`); stripped paths are returned in `_meta` so callers can
    re-validate with Zod.
  - Hard-rejects `$ref` (unresolvable in bridge scope) with `isError: true`.
  - Token cap: `num_predict: 2048`.
  - Unit test suite (16 cases, vitest): `tests/unit/sanitize.test.ts`.

- **`transform` tool (F3)** — free-form text transformation via a natural-language
  instruction. Plain `chat()` call, no `format:` schema. Temperature 0.3.

- **`_meta` emission (F5)** — every tool response now carries a `_meta` record
  namespaced under `dev.ollamamcpbridge/*`:
  - Always-emitted: `model`, `tier`, `latency_ms`, `prompt_tokens`,
    `completion_tokens`.
  - Conditional: `defender/tier`, `defender/score`, `defender/risk`,
    `schema_validation`, `schema_stripped`.

- **Prompt-injection defense (F4)** — two-layer defense on all tool inputs:
  - Layer 1a: Microsoft Spotlighting (arxiv 2403.14720, Hines et al.) — wraps
    untrusted text in a unique per-call delimiter announced in the system prompt.
  - Layer 1b: Unicode NFKC normalization (Unicode TR#15) — collapses Cyrillic
    and other homoglyphs to ASCII before processing.
  - Layer 2: `@stackone/defender` (Apache-2.0) Tier-1 regex classifier, always on.
    Tier-2 MiniLM ONNX classifier opt-in via `OMCP_DEFENDER_TIER2=1`.
  - Blocked inputs return `isError: true` without calling Ollama.

- **Streaming progress notifications (F6)** — when the MCP client supplies
  `_meta.progressToken`, the bridge emits `notifications/progress` at three
  waypoints (routing → defender → generating) so progress bars work in
  clients that support them.

- **`sanitize.ts` + `meta.ts` + `defense.ts`** — new pure-module helpers backing
  F2/F4/F5; each independently unit-testable.

### Fixed

- **Tier B `keep_alive` OOM fix** — changed from `-1` (keep forever) to `'10m'`
  (auto-unload after 10 minutes idle). Prevents the Ollama process from holding
  the full model in VRAM indefinitely on 16 GB Macs, causing OOM when other
  heavy tasks start.

### Changed

- **`client.chat()` return type** — now returns `ChatResult { text, promptTokens,
  completionTokens }` instead of `string`, exposing Ollama's `prompt_eval_count`
  and `eval_count` for `_meta` emission.

- **`server.ts` full rewrite** — all five tools now share the same
  defend → progress → chat → meta pipeline. `ToolExtra` structural interface
  replaces the generic `RequestHandlerExtra` import (avoids TS2314 with
  `@modelcontextprotocol/sdk` v1.29).

### Dependencies added

- `@stackone/defender` ^0.6.2 — Apache-2.0 prompt-injection classifier.
  Default install ~24 MB (Tier-1 only). Tier-2 opt-in adds ~475 MB peer deps
  (`onnxruntime-node`, `@huggingface/transformers`).

### Schema constraints known to crash Ollama's GBNF compiler (document for callers)

Zod schemas passed to `extract` must not contain (the sanitizer strips them, but
callers should be aware):

- `pattern` on any string field (`z.string().regex(...)`, `z.email()`, `z.url()`)
- `format: "email" | "uri" | "date-time"`
- `multipleOf` on numbers

Prefer `z.discriminatedUnion` over bare `z.union` for branches with disjoint
shapes — the grammar enforces structural validity but not branch-selection
semantics (see scope memo Run B ¹).

---

## [0.1.0] — 2026-04-20

### Added

- **`summarize` tool** — delegates summarization to Tier B (`qwen3:4b`). Returns
  Markdown bullet-point summary.
- **`summarize-long` tool** — routes to Tier C (`qwen2.5:7b`) for long-context
  documents.
- **Tier-based model routing** — `B` (fast, 4B) vs `C` (long-form, 7B); config
  in `src/config/tiers.ts`.
- **`think: false` default** — disables chain-of-thought bleed in hybrid-reasoning
  Qwen3 models.
- **`hardware` CLI command** — prints Ollama hardware info.
- **`catalog` CLI command** — lists available local models.
