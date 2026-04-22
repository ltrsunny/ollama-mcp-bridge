# ollama-mcp-bridge (working name)

> Let any MCP-compatible AI assistant — Claude Desktop, Cursor, Cline, Zed, and
> others — delegate lightweight tasks to a local [Ollama](https://ollama.com)
> model. Save tokens. Stay private. Run offline-capable grunt work on your own
> machine.

**Status: pre-alpha.** The working name will be reconsidered before the first
public release.

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
