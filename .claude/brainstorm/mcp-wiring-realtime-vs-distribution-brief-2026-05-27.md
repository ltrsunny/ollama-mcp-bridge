# Brief: MCP server wiring — local real-time dev propagation vs external distribution

You are 1 of N voices. Decide how `local-mcp-toolbelt`'s MCP server should
be WIRED (`.mcp.json` command/args + registration scope) to best satisfy
two partly-conflicting goals. Challenge the framing (#22). Mark every
load-bearing claim EMPIRICAL (you verified it) vs CITED-UNVERIFIED
(Claude-Code / npm specifics asserted from memory, not run this session).

## Two goals (in tension)

- **G1 local real-time**: when the dev repo (`~/ollama-claude`) rebuilds the
  bridge (`npm run build` overwrites `dist/`), OTHER local sessions on this
  Mac (esp. sister repo `~/.config/llm-orchestration`) should run the latest
  build automatically on next session/server start — NO npm republish.
  ("real-time" = at server/session start; each session spawns its own stdio
  server, so no mid-session hot-reload is expected.)
- **G2 distribution / plug-and-play**: a remote user installs in ONE step
  (Claude Code plugin `/plugin install`) and gets a working bridge — no dev
  repo, no machine-specific path.
- **G3**: no machine/user-specific absolute paths in any COMMITTED or
  DISTRIBUTED config. (A personal USER-scope config MAY contain local
  absolute paths — that is not distributed, so it's acceptable there.)

## EMPIRICAL (this Mac, verified 2026-05-27)

- npm `local-mcp-toolbelt@0.6.0` published + verified working:
  `npx -p local-mcp-toolbelt local-mcp serve` runs a real MCP server
  (initialize + tools/list + tools/call→oMLX all OK). bin name = `local-mcp`.
- Dev build at `~/ollama-claude/packages/core/dist/bin/cli.js`; `dist/`
  gitignored.
- Current dev-session bridge = PROJECT `.mcp.json` → `node <abs>/cli.js serve`
  (real-time, but hardcoded path + project-scope only → sister session does
  NOT get it).
- NO user-scope MCP registration exists (`~/.claude.json` has no mcpServers).
- node/npm/npx via **fnm → npm global root is VERSION-SPECIFIC**
  (`.../fnm/node-versions/v22.22.2/.../node_modules`). So `npm i -g` /
  `npm link` global bins live under the *current* node version and break when
  fnm switches versions. `npx -p <pkg>` does NOT need a global install
  (per-need cache) → more fnm-robust.
- Package is NOT currently `npm link`ed or `-g` installed.

## Seed options (NOT vetted — propose F+ / hybrids freely)

- **A. Single `npx -p local-mcp-toolbelt local-mcp serve`** (published):
  G2 yes, G3 yes, fnm-robust yes; **G1 no** (stale until republish).
- **B. Single `node <abs>/dist/bin/cli.js serve`** (dev path): G1 yes,
  fnm-ok; G2 no, G3 no.
- **D. `npm link` → global `local-mcp` bin → live dev build; config
  `local-mcp serve`** (local = linked-live, remote = `npm i -g`):
  aims G1+G2 in one config but **fnm makes it fragile** (version-specific).
- **F. Split by AUDIENCE**: (i) LOCAL = USER-scope registration →
  `node <abs>/dist/bin/cli.js serve` → all local sessions (dev + sister) get
  the live dev build, real-time on start (G1; abs path acceptable in personal
  config). (ii) DISTRIBUTION = plugin `.mcp.json` →
  `npx -p local-mcp-toolbelt local-mcp serve` (G2). Separate configs,
  separate audiences, no conflict.

## Decide (≤450 words)

- Best option (or a new F+/hybrid) for G1+G2+G3 at least complexity?
- Top risk of your pick + the ONE empirical test that confirms/kills it.
- Mark EMPIRICAL vs CITED-UNVERIFIED on load-bearing claims; flag if you're
  merely echoing this brief's framing (#22).
