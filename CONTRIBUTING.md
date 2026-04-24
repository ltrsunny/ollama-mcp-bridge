# Contributing

## Development setup

Requirements: Node.js ≥ 22, npm ≥ 10, [Ollama](https://ollama.com) running locally.

```bash
git clone https://github.com/ltrsunny/ollama-mcp-bridge.git
cd ollama-mcp-bridge
npm install
```

## Running tests

This project has two test tiers with different requirements.

### Tier 1 — Unit tests (no Ollama required)

Pure in-process logic; runs anywhere, including CI.

```bash
cd packages/core
npm test          # vitest run — 16 cases, ~1 s
```

Covered: JSON Schema sanitizer (`sanitize.test.ts`), schema constraint stripping,
`$ref` hard-reject, meta field assembly.

### Tier 2 — Integration tests (Ollama daemon + models required)

These require a running Ollama instance with `qwen3:4b` and `qwen2.5:7b` pulled locally.
They are **not run in CI** because the models total ~7 GB and are unavailable on GitHub
Actions runners.

```bash
cd packages/core

# End-to-end smoke tests (all 5 tools, ~51 assertions)
node tests/smoke-bridge.mjs

# Context-window probe (verifies num_ctx > 4096 for both tiers)
node tests/probe-numctx.mjs
```

Run these locally before any change that touches `src/config/tiers.ts`, `src/mcp/server.ts`,
or the Ollama client layer.

## CI

GitHub Actions runs the unit tests and TypeScript build on Node 22 and Node 24 for every
push to `main` and every pull request targeting `main`. See
[`.github/workflows/ci.yml`](./.github/workflows/ci.yml). The CI badge in the README
reflects the `main` branch status.

Integration tests (`smoke-bridge.mjs`, `probe-numctx.mjs`) are intentionally excluded
from CI because they depend on a running Ollama daemon and ~7 GB of model weights —
run them locally before any change to the Ollama client layer, tier configuration,
or MCP server pipeline.
