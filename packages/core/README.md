# local-mcp-toolbelt

[![CI](https://github.com/ltrsunny/local-mcp-toolbelt/actions/workflows/ci.yml/badge.svg)](https://github.com/ltrsunny/local-mcp-toolbelt/actions/workflows/ci.yml)

> Delegate summarise / classify / extract / transform tasks from any MCP client
> to a local [oMLX](https://github.com/jundot/omlx) inference server.
> Save frontier tokens. Stay private. Run offline on Apple Silicon.

Single backend: **MlxHttpBackend** → oMLX serving Qwen3 MLX-4bit models.
KV-cache persistent across requests. OpenAI Structured Outputs strict mode
for grammar-constrained outputs.

## Tools

| Tool | Tier | Use case |
|---|---|---|
| `summarize` | B (Qwen3-4B-Instruct) | Short text ≤ ~2 K words |
| `summarize-long` | C (Qwen3-8B, numCtx=32 K) | Up to ~25 K words single-call |
| `summarize-long-chunked` | C | Map-reduce for documents > 25 K words |
| `classify` | B | Grammar-constrained enum labels |
| `extract` | B | Grammar-constrained JSON against a supplied schema |
| `transform` | B | Free-form rewrite / translation |

All tools accept `source_uri: "file:///..." | "https://..."` to read source
directly — raw bytes never enter the frontier context.

## Setup

### 1. Install oMLX

```bash
brew tap jundot/omlx
brew install omlx
brew services start jundot/omlx/omlx
```

### 2. Download models

```bash
npm run download-models
# Default: B + C (~7.5 GB)
#   Qwen3-4B-Instruct-2507-4bit  (Tier B, ~2.5 GB)
#   Qwen3-8B-4bit                (Tier C, ~5 GB)
#
# Power-user opt-in for Tier D (24+ GB Mac only):
npm run download-models -- --tiers B,C,D
#   + Qwen3-14B-4bit             (Tier D, ~5 GB more)
```

### 3. Configure your MCP client

```jsonc
// ~/Library/Application Support/Claude/claude_desktop_config.json
{
  "mcpServers": {
    "local-mcp-toolbelt": {
      "command": "node",
      "args": [
        "/path/to/packages/core/dist/bin/cli.js",
        "serve"
      ]
    }
  }
}
```

Or install from npm and use `npx`:

```jsonc
{
  "mcpServers": {
    "local-mcp-toolbelt": {
      "command": "npx",
      "args": ["-y", "local-mcp-toolbelt", "serve"]
    }
  }
}
```

## CLI

```bash
local-mcp-toolbelt serve                   # MCP server over stdio (default)
local-mcp-toolbelt serve --mlx-url URL     # Custom oMLX URL
local-mcp-toolbelt serve --tier-b-model M  # Override Tier B model name
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `OMCP_MLX_URL` | `http://127.0.0.1:8000` | oMLX server URL |
| `OMCP_TIER_B_MODEL` | `Qwen3-4B-Instruct-2507-4bit` | Tier B model name |
| `OMCP_TIER_C_MODEL` | `Qwen3-8B-4bit` | Tier C model name |
| `OMCP_TIER_D_MODEL` | `Qwen3-14B-4bit` | Tier D model name (power-user opt-in only) |
| `OMCP_URL_MAX_BYTES` | `10485760` | Max `http(s)://` body size |
| `OMCP_URL_TIMEOUT_MS` | `30000` | Fetch timeout (ms) |
| `OMCP_URL_DENY_PRIVATE` | `1` | Block private/loopback hosts (SSRF) |
| `OMCP_CHUNK_SIZE` | `2000` | Target tokens per chunk (chunked summarizer) |
| `OMCP_CHUNK_OVERLAP` | `200` | Overlap between adjacent chunks |
| `OMCP_CHUNK_CONCURRENCY` | `2` | MAP fan-out cap |
| `OMCP_TELEMETRY_FOOTER` | `1` | Set `0` to suppress footer in `content[]` |

## Development

```bash
npm test                # unit tests — no oMLX required
npm run build           # tsc → dist/
```

See [`tests/eval/README.md`](./tests/eval/README.md) for the per-tier
latency + quality eval harness (requires oMLX running).

## License

Apache-2.0 — see the project root [`LICENSE`](../../LICENSE) and
[`NOTICE`](../../NOTICE) for attributions.
