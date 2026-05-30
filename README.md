# local-mcp-toolbelt

[![CI](https://github.com/ltrsunny/local-mcp-toolbelt/actions/workflows/ci.yml/badge.svg)](https://github.com/ltrsunny/local-mcp-toolbelt/actions/workflows/ci.yml)

> Let any MCP-compatible AI assistant — Claude Desktop, Cursor, Cline, Zed, and
> others — delegate lightweight tasks to a local oMLX inference server.
> Save tokens. Stay private. Run offline-capable grunt work on your own
> Apple Silicon machine.

**Six tools:** `summarize`, `summarize-long`,
`summarize-long-chunked`, `classify`, `extract`, `transform`.
Single backend: `MlxHttpBackend` → [oMLX](https://github.com/jundot/omlx)
serving Qwen3-4B/8B/14B (MLX 4-bit) on Apple Silicon. KV-cache persistent
across requests; OpenAI Structured Outputs strict mode for grammar
enforcement.

## Layout

This is a monorepo with two packages:

- [`packages/core`](./packages/core) &mdash; `local-mcp-toolbelt`, the MCP
  server and companion CLI. Works with any MCP client. Installable via npm
  and usable standalone.
- `packages/claude-desktop` (coming soon) &mdash; a `.mcpb` one-click installer
  that wraps the core for Claude Desktop users who do not want to edit JSON.

The split exists because the Model Context Protocol is client-neutral: other
clients (Cursor, Cline, Zed, …) also consume MCP servers, so the bridging
logic lives in a framework-agnostic package.

## Tools

All six tools are available over any MCP-compatible client (Claude Desktop,
Cursor, Cline, Zed, …). They all share the same security pipeline and emit
`_meta` telemetry on every response.

### `summarize`

```
summarize(text?: string, source_uri?: string, style?: string) → prose summary
```

Delegates to **Tier B** (`Qwen3-4B-Instruct-2507-4bit`, non-thinking
variant). Best for documents up to ~4 K tokens. Either `text` or
`source_uri` must be provided (mutually exclusive).

### `summarize-long`

```
summarize-long(text?: string, source_uri?: string, style?: string) → structured summary
```

Routes to **Tier C** (`Qwen3-8B-4bit` MLX, `numCtx=32768`) for long-context
documents (1–2 sentence lead + 3–6 bullets). Either `text` or `source_uri`
must be provided.

> Qwen3-8B is a thinking model; the bridge auto-injects `\n/no_think` into
> user content so the model emits the summary directly without first
> burning the per-tool cap on a `<think>...</think>` reasoning trace.
>
> **`numCtx=32768`** admits ~25 K words of source in a single call.
> Server-side residency is ~5 GB weights + ~3 GB KV at full context, so
> total ~8 GB on the 16 GB Mac (fits when Tier D 14B is not also loaded).
> Documents longer than ~25 K words exceed the model's context — use
> `summarize-long-chunked` for those.

### `summarize-long-chunked`

```
summarize-long-chunked(
  text?:        string,
  source_uri?:  string,
  style?:       string,
  max_chunks?:  number = 100,
) → coherent final summary
```

Map-reduce chunked summarization for documents that exceed Tier C's single-call
ceiling (~25 K words). Splits the source into overlapping chunks (default
2 000 tokens, configurable), summarizes each in parallel via `p-limit`, then
recursively combines chunk summaries until one bucket fits a single REDUCE call.

- Same Tier C model as `summarize-long`.
- Per-call soft timeout 50 s; chained `AbortSignal` per chunk so client
  disconnects propagate cleanly without leaking work.
- Recursion depth ≤ 3 covers up to ~200 K-token inputs; beyond that returns
  `partial: true` with the first bucket reduced.
- **Fast-path:** if the source fits Tier C in one call, the tool runs as a
  single equivalent call (no chunking tax). Strict superset of `summarize-long`.

> **Client-timeout reality.** Claude Code's MCP request timeout is a hard ~60 s
> that **cannot be extended** via `settings.json` or any documented env var
> (`MCP_TIMEOUT` controls only server startup — see
> [anthropics/claude-code #5221](https://github.com/anthropics/claude-code/issues/5221),
> [#22542](https://github.com/anthropics/claude-code/issues/22542)). The
> chunking work itself takes minutes on a 16 GB Mac, so from Claude Code this
> tool is useful in **fast-path mode only** — for documents up to ~12-15 KB
> Chinese / ~25 KB English. Larger documents force the full chunking path,
> exceeding 60 s of total wall time and timing out the MCP request even though
> each individual local-model call stays under the per-call 50 s budget.
>
> The chunked path **is reachable from clients with longer timeouts** (Claude
> Desktop: 240 s default; custom integrations: configurable). The smoke suite
> (`tests/smoke-bridge.mjs`) exercises it end-to-end with a 600 s harness
> timeout.

### `classify`

```
classify(
  text:           string,
  categories:     string[],
  allow_multiple: boolean = false,
  explain:        boolean = false,
) → { labels: string[], reason?: string }
```

Grammar-constrained classification — the model's output is **forced** to
be a valid member of `categories` via OpenAI Structured Outputs strict
mode (`response_format: {type:"json_schema", strict:true}`) on oMLX.
When `allow_multiple` is `true`, multiple labels are allowed. When
`explain` is `true`, a `reason` string is appended (source language
preserved).

### `extract`

```
extract(text?: string, source_uri?: string, schema: JSONSchemaObject) → { data: <schema-typed> } | isError
```

Structured-data extraction against an arbitrary JSON Schema. The bridge
automatically strips constraints unsupported by oMLX's strict-mode decoder
(see **Schema constraints** below) and adds the `additionalProperties:
false` + full `required` keys that strict mode requires. Stripped
constraints are surfaced in `_meta` so you can re-validate with Zod on
your side.

**Schema constraints** — the sanitizer strips these silently and reports them in
`_meta["dev.localmcptoolbelt/schema_stripped"]`:

| Constraint | Example Zod | Status |
|---|---|---|
| `pattern` | `z.string().regex(/…/)` | Stripped — use Zod re-validation |
| `format: "email"` | `z.email()` | Stripped |
| `format: "uri"` | `z.url()` | Stripped |
| `format: "date-time"` | `z.string().datetime()` | Stripped |
| `multipleOf` | `z.number().multipleOf(0.01)` | Stripped |
| `$ref` | cross-schema references | **Hard reject** → `isError: true` (flatten first) |

**Tip:** prefer `z.discriminatedUnion` over bare `z.union` when branches have
disjoint output shapes — structural grammar is enforced but branch-selection
semantics are not (the model may pick the wrong branch on ambiguous inputs).

### `transform`

```
transform(text?: string, source_uri?: string, instruction: string) → string
```

Free-form text transformation. The model applies `instruction` to `text` (or to the
content at `source_uri`) and returns only the result. Language is preserved unless the
instruction says otherwise.

### `source_uri` — direct-read input

`summarize`, `summarize-long`, `extract`, and `transform` accept an optional
`source_uri` parameter instead of `text`. The bridge reads the source directly —
raw content never enters the frontier's context window — which is the only
architecture where delegation actually saves frontier tokens.

```
source_uri: "file:///path/to/document.txt"
source_uri: "https://example.com/article.html"
```

**Supported schemes:** `file://` (unrestricted local access) and `http(s)://`
(size-capped at 10 MB, 30 s timeout, `text/*` / `application/json` /
`application/xml` content types, SSRF protection for private IPs).

**Environment variables:**

| Variable | Default | Description |
|---|---|---|
| `OMCP_URL_MAX_BYTES` | `10485760` | Max `http(s)://` body size in bytes |
| `OMCP_URL_TIMEOUT_MS` | `30000` | Fetch timeout in ms |
| `OMCP_URL_DENY_PRIVATE` | `1` | Block private/loopback hosts (SSRF) |
| `OMCP_URL_HOSTS` | *(unset)* | Comma-separated hostname allowlist |
| `OMCP_TELEMETRY_FOOTER` | `1` | Set `0` to suppress footer in `content[]` |
| `OMCP_CHUNK_SIZE` | `2000` | `summarize-long-chunked` target tokens per chunk |
| `OMCP_CHUNK_OVERLAP` | `200` | `summarize-long-chunked` overlap between adjacent chunks |
| `OMCP_CHUNK_CONCURRENCY` | `2` | `summarize-long-chunked` MAP fan-out cap (oMLX serializes generation on Metal so >2 mostly adds queueing) |
| `OMCP_MLX_URL` | `http://127.0.0.1:8000` | oMLX server URL — overridden by `--mlx-url` |
| `OMCP_TIER_B_MODEL` | `Qwen3-4B-Instruct-2507-4bit` | Tier B model name (must exist under `~/.omlx/models/`) |
| `OMCP_TIER_C_MODEL` | `Qwen3-8B-4bit` | Tier C model name |
| `OMCP_TIER_D_MODEL` | `Qwen3-14B-4bit` | Tier D model name (power-user opt-in only — see CLAUDE.md) |

---

## Security

All tool inputs pass through a two-layer prompt-injection defense before
reaching oMLX:

1. **NFKC normalization** (Unicode TR#15) — collapses Cyrillic/Greek homoglyphs
   to ASCII, defeating basic homoglyph injection.
2. **Spotlighting** (Microsoft, arxiv 2403.14720) — wraps untrusted text in a
   unique per-call delimiter announced in the system prompt so the model treats
   it as data, not instructions.
3. **`@stackone/defender` Tier-1** (always-on) — regex/pattern classifier that
   blocks role-marker overrides, encoding attacks, and instruction-injection
   patterns. Blocked inputs return `isError: true` without calling oMLX.
4. **Tier-2 ML classifier** (opt-in) — MiniLM ONNX model via `@stackone/defender`.
   Enable with `OMCP_DEFENDER_TIER2=1`. Adds ~475 MB in peer dependencies
   (`onnxruntime-node`, `@huggingface/transformers`).

---

## `_meta` telemetry

Every tool response includes a `_meta` record with observability data:

| Key | Always? | Description |
|---|---|---|
| `dev.localmcptoolbelt/model` | ✓ | Resolved oMLX model name (e.g. `Qwen3-4B-Instruct-2507-4bit`) |
| `dev.localmcptoolbelt/tier` | ✓ | `B`, `C`, or `D` |
| `dev.localmcptoolbelt/latency_ms` | ✓ | End-to-end wall-clock ms |
| `dev.localmcptoolbelt/prompt_tokens` | ✓ | `usage.prompt_tokens` from oMLX |
| `dev.localmcptoolbelt/completion_tokens` | ✓ | `usage.completion_tokens` from oMLX |
| `dev.localmcptoolbelt/defender/tier` | When defense ran | `1`, `1+2`, or `off` |
| `dev.localmcptoolbelt/defender/score` | When Tier-2 ran | Float 0–1 confidence |
| `dev.localmcptoolbelt/defender/risk` | When flagged | Tier-1 risk level string |
| `dev.localmcptoolbelt/schema_validation` | `extract` only | `passed` or `failed` |
| `dev.localmcptoolbelt/schema_stripped` | `extract` only (when stripped) | List of stripped JSON Pointer paths |
| `dev.localmcptoolbelt/source_uri` | When `source_uri` used | The URI that was read |
| `dev.localmcptoolbelt/source_bytes` | When `source_uri` used | Raw byte count of fetched content |
| `dev.localmcptoolbelt/saved_input_tokens_estimate` | When `source_uri` used | `floor(bytes/4) − completion_tokens` |

### Telemetry footer

Every successful response also appends a one-line footer as the **last `content[]`
item** — visible to the calling frontier LLM, unlike `_meta`:

```
[bridge: Qwen3-4B-Instruct-2507-4bit B 1240ms in=230 out=85]
[bridge: Qwen3-4B-Instruct-2507-4bit B 1240ms in=230 out=85 saved~=+210]
```

The `saved~=` field appears when `source_uri` was used. Suppress with
`OMCP_TELEMETRY_FOOTER=0`.

---

## Development

Requirements: Node.js &ge; 22, npm &ge; 10, [oMLX](https://github.com/jundot/omlx)
running locally for end-to-end flows.

```bash
# Start oMLX inference server (Apple Silicon only)
brew services start jundot/omlx/omlx

# Install dependencies + build
npm install

# Download MLX weights — B + C (Tier D is power-user opt-in; pass
# `--tiers B,C,D` only on 24+ GB Mac with raised hot_cache_max_size)
cd packages/core && npm run download-models

# Verify oMLX is serving
curl -s localhost:8000/v1/models | jq '.data[].id'
```

## License

Apache-2.0 &mdash; see [`LICENSE`](./LICENSE). Third-party attributions are in
[`NOTICE`](./NOTICE).
