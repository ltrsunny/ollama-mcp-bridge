# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
