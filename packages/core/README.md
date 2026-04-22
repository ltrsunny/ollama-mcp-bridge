# ollama-mcp-bridge

Universal MCP server that bridges any MCP client (Claude Desktop, Cursor, Cline,
Zed, …) to a local [Ollama](https://ollama.com) instance. Lets the assistant
delegate lightweight tasks — summarising, drafting, classifying, extracting,
transforming — to a local model so the frontier model's token budget is
preserved for reasoning that actually benefits from it.

**Status: pre-alpha.** Still scaffolding. The CLI commands below work today;
the MCP server and task tools are being built iteratively.

## Install

```bash
npm install -g ollama-mcp-bridge
```

(Not yet published. Clone the monorepo and run from source for now.)

## CLI

The CLI is useful for inspecting the bridge's view of your machine and the
Ollama catalog, and for running the MCP server directly for debugging.

```bash
# What the bridge knows about the local machine
ollama-mcp hardware

# Live catalog from ollamadb.dev (community-maintained index of ollama.com/library)
ollama-mcp catalog

# Full raw response
ollama-mcp catalog --raw
```

Run from source during development:

```bash
# inside packages/core
npm run dev -- hardware
npm run dev -- catalog
```

## Use as a library

```ts
import { detectHardware, fetchCatalog } from 'ollama-mcp-bridge';

const hw = detectHardware();
const catalog = await fetchCatalog({ limit: 200 });
```

## Use with MCP clients

(Instructions for Claude Desktop, Cursor, Cline, Zed, etc. will be added once
the MCP server is wired up.)

## License

Apache-2.0. See the project root [`LICENSE`](../../LICENSE) and
[`NOTICE`](../../NOTICE) for attributions.
