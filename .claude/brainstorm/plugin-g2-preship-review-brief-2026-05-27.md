# Brief: pre-ship collective review — local-mcp-toolbelt PLUGIN G2 readiness

You are 1 of N adversarial voices. Before shipping the `local-mcp-toolbelt`
Claude plugin to OTHER users (G2), pressure-test the conclusion, the ship
plan, and a hook fix. Challenge the framing (#22). Mark every load-bearing
claim EMPIRICAL (verified this session) or CITED-UNVERIFIED.

## Context (EMPIRICAL, 2026-05-27, Claude Desktop)

- Removed BOTH manual bridge sources — the `claude_desktop_config.json` MCP
  entry AND the project `.claude/settings.json` `Read|Bash` enforce-bridge
  hook — then opened a FRESH conversation. It STILL got the bridge AND hard
  enforcement: a direct Read of a >1 KB external file was BLOCKED and
  auto-routed to the plugin's `extract` → oMLX (returned the correct buried
  value). Tool name was `mcp__plugin_local-mcp-toolbelt_…__extract`.
- So the globally-enabled PLUGIN alone delivers: MCP server (bundled
  `.mcp.json`) + hard enforce-bridge hook (bundled `hooks/hooks.json`), zero
  manual config, in all conversations.
- The plugin's bundled `.mcp.json` uses a MACHINE-SPECIFIC ABS dev path
  (`node /Users/rd/ollama-claude/packages/core/dist/bin/cli.js serve`). Works
  on the dev machine; a remote user has no such path.
- npm `local-mcp-toolbelt@0.6.0` published + verified: `npx -p
  local-mcp-toolbelt local-mcp serve` runs standalone (initialize +
  tools/list + tools/call all OK). NOT yet verified AS a plugin's `.mcp.json`
  command in a real install.
- Plugin was installed from a "directory" marketplace source pointing at the
  dev repo. plugin.json homepage = `github.com/RRdD/...` (RRdD = local mac
  username, WRONG); package.json repository = `ltrsunny`. `dist/` is gitignored.

## Review items (verdict + top risk + ONE empirical test each)

1. **Conclusion soundness**: "plugin alone delivers everything; the manual
   configs were redundant; the current clean state is correct." Holes? Does it
   survive Desktop app updates / plugin reinstall / a DIFFERENT machine? Did
   removing the project hook leave any gap in the ollama-claude PROJECT context
   (the fresh test conversation may not have been project-anchored)?

2. **G2 ship plan**: for remote users — (a) change plugin `.mcp.json` →
   `npx -p local-mcp-toolbelt local-mcp serve`; (b) marketplace source → real
   github (not local directory); (c) fix plugin.json homepage RRdD→real handle;
   (d) `dist/` absence OK since npx pulls published. Risks? Is "npx AS a plugin
   `.mcp.json` command" actually going to work on a fresh install
   (CITED-UNVERIFIED)? First-run `npx` confirm-prompt / latency hanging the MCP
   handshake? `${CLAUDE_PLUGIN_ROOT}` hook-path expansion on a remote install?

3. **Hook fix**: `enforce-bridge.sh` Bash branch currently scans ALL path
   tokens of a command once ANY reader verb (cat/head/tail/grep/jq/…) appears
   ANYWHERE → false-blocks external-file args of NON-reader commands (e.g.
   `rm /ext/big.log; ls /dir | tail`). Proposed fix: segment-scoped — split the
   command on `|` `;` `&&` `||`, only scan path-args of segments whose FIRST
   word is a reader verb. Does this OPEN A HOLE (reader hidden via `$(...)`,
   backticks, `xargs cat`, `eval`, `bash -c`)? Is segment-first-word the right
   scope, or too narrow/broad?

4. **Anything missed** before shipping to others (security, license, the
   deferred copilot-free 17K / BYOK picker, version sync, etc.)?

## Output (≤450 words)
Per item above. Mark EMPIRICAL vs CITED-UNVERIFIED on load-bearing claims.
Flag explicitly if you are merely echoing this brief's framing.
