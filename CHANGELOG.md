# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
