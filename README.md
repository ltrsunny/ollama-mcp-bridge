# ollama-mcp-bridge (working name)

> Let any MCP-compatible AI assistant — Claude Desktop, Cursor, Cline, Zed, and
> others — delegate lightweight tasks to a local [Ollama](https://ollama.com)
> model. Save tokens. Stay private. Run offline-capable grunt work on your own
> machine.

**Status: v0.1.2 — alpha.** Five tools available: `summarize`, `summarize-long`,
`classify`, `extract`, `transform`. The working name will be reconsidered before
the first public release.

## Layout

This is a monorepo with two packages:

- [`packages/core`](./packages/core) &mdash; `ollama-mcp-bridge`, the universal
  MCP server and companion CLI. Works with any MCP client. Installable via npm
  and usable standalone.
- `packages/claude-desktop` (coming soon) &mdash; a `.mcpb` one-click installer
  that wraps the core for Claude Desktop users who do not want to edit JSON.

The split exists because the Model Context Protocol is client-neutral: other
clients (Cursor, Cline, Zed, …) also consume MCP servers, so the bridging
logic lives in a framework-agnostic package.

## Tools

All five tools are available over any MCP-compatible client (Claude Desktop,
Cursor, Cline, Zed, …). They all share the same security pipeline and emit
`_meta` telemetry on every response.

### `summarize`

```
summarize(text?: string, source_uri?: string, style?: string) → prose summary
```

Delegates to **Tier B** (`qwen3:4b`). Best for documents up to ~4 K tokens.
Either `text` or `source_uri` must be provided (mutually exclusive).

### `summarize-long`

```
summarize-long(text?: string, source_uri?: string, style?: string) → structured summary
```

Routes to **Tier C** (`qwen2.5:7b`) for long-context documents (1–2 sentence lead + 3–6 bullets).
Either `text` or `source_uri` must be provided.

### `classify`

```
classify(
  text:           string,
  categories:     string[],
  allow_multiple: boolean = false,
  explain:        boolean = false,
) → { labels: string[], reason?: string }
```

Grammar-constrained classification — the model's output is **forced** to be a
valid member of `categories` via Ollama's `format:` schema feature. When
`allow_multiple` is `true`, multiple labels are allowed. When `explain` is
`true`, a `reason` string is appended (source language preserved).

### `extract`

```
extract(text?: string, source_uri?: string, schema: JSONSchemaObject) → { data: <schema-typed> } | isError
```

Structured-data extraction against an arbitrary JSON Schema. The bridge
automatically strips constraints that crash Ollama's grammar compiler before
forwarding (see **Schema constraints** below). Stripped constraints are surfaced
in `_meta` so you can re-validate with Zod on your side.

**Schema constraints** — the sanitizer strips these silently and reports them in
`_meta["dev.ollamamcpbridge/schema_stripped"]`:

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

---

## Security

All tool inputs pass through a two-layer prompt-injection defense before
reaching Ollama:

1. **NFKC normalization** (Unicode TR#15) — collapses Cyrillic/Greek homoglyphs
   to ASCII, defeating basic homoglyph injection.
2. **Spotlighting** (Microsoft, arxiv 2403.14720) — wraps untrusted text in a
   unique per-call delimiter announced in the system prompt so the model treats
   it as data, not instructions.
3. **`@stackone/defender` Tier-1** (always-on) — regex/pattern classifier that
   blocks role-marker overrides, encoding attacks, and instruction-injection
   patterns. Blocked inputs return `isError: true` without calling Ollama.
4. **Tier-2 ML classifier** (opt-in) — MiniLM ONNX model via `@stackone/defender`.
   Enable with `OMCP_DEFENDER_TIER2=1`. Adds ~475 MB in peer dependencies
   (`onnxruntime-node`, `@huggingface/transformers`).

---

## `_meta` telemetry

Every tool response includes a `_meta` record with observability data:

| Key | Always? | Description |
|---|---|---|
| `dev.ollamamcpbridge/model` | ✓ | Resolved Ollama model tag |
| `dev.ollamamcpbridge/tier` | ✓ | `B` or `C` |
| `dev.ollamamcpbridge/latency_ms` | ✓ | End-to-end wall-clock ms |
| `dev.ollamamcpbridge/prompt_tokens` | ✓ | `prompt_eval_count` from Ollama |
| `dev.ollamamcpbridge/completion_tokens` | ✓ | `eval_count` from Ollama |
| `dev.ollamamcpbridge/defender/tier` | When defense ran | `1`, `1+2`, or `off` |
| `dev.ollamamcpbridge/defender/score` | When Tier-2 ran | Float 0–1 confidence |
| `dev.ollamamcpbridge/defender/risk` | When flagged | Tier-1 risk level string |
| `dev.ollamamcpbridge/schema_validation` | `extract` only | `passed` or `failed` |
| `dev.ollamamcpbridge/schema_stripped` | `extract` only (when stripped) | List of stripped JSON Pointer paths |
| `dev.ollamamcpbridge/source_uri` | When `source_uri` used | The URI that was read |
| `dev.ollamamcpbridge/source_bytes` | When `source_uri` used | Raw byte count of fetched content |
| `dev.ollamamcpbridge/saved_input_tokens_estimate` | When `source_uri` used | `floor(bytes/4) − completion_tokens` |

### Telemetry footer

Every successful response also appends a one-line footer as the **last `content[]`
item** — visible to the calling frontier LLM, unlike `_meta`:

```
[bridge: qwen3:4b B 1240ms in=230 out=85]
[bridge: qwen3:4b B 1240ms in=230 out=85 saved~=+210]
```

The `saved~=` field appears when `source_uri` was used. Suppress with
`OMCP_TELEMETRY_FOOTER=0`.

---

## Development

Requirements: Node.js &ge; 22, npm &ge; 10, [Ollama](https://ollama.com)
running locally if you want to exercise the end-to-end flows.

```bash
npm install
cd packages/core
npm run dev -- hardware
npm run dev -- catalog
```

## License

Apache-2.0 &mdash; see [`LICENSE`](./LICENSE). Third-party attributions are in
[`NOTICE`](./NOTICE).
