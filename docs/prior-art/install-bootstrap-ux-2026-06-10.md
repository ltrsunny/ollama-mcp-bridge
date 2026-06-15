# Prior Art — one-command bootstrap UX (`local-mcp setup` / `doctor` / SessionStart nudge)

**For:** v0.7 plug-and-play install scope memo (B — "others install the plugin AND it just works").
**Date:** 2026-06-10. **Method:** auditor-protocol fanout, ≥2 independent families.
**Fanout health note:** first attempts hit a portfolio outage (AI Studio REST `gem` daily-quota +
503; GitHub Models 429; Copilot Premium 402). Per the [fanout-breakage handoff rule] the breakage
was handed to the `llm-orchestration` sister, which fixed the AI-Studio health-probe false-kill +
429-as-transient bug and confirmed independent pools healthy. PA then resumed **to standard** — no
single-source degradation.

**Sources (3 independent families, same bounded prompt, convergent):**
- `nv_pro` round 1 → **Llama** (meta/llama-3.3-70b, NIM)
- `nv_pro` round 2 → **Qwen** (qwen3.5-397b, NIM)
- `agy_pro` → **Gemini** (Antigravity, independent pool)

The Claude-Code-plugin *facts* below are separately doc-grounded (claude-code-guide →
code.claude.com/docs plugins-reference), not fanout leads.

## Candidates surveyed

| Tool | What to copy | Pitfall to avoid |
|---|---|---|
| **ollama** (`pull`) | Separate binary-install from model-fetch; rich progress (size/speed/ETA); resume partial via range requests; idempotent re-pull (hash-check, skip if present) | "latest" tag drifts size; daemon-not-running → confusing `connection refused` instead of "start it" |
| **llamafile / lm-studio** | Early hardware (Metal/Apple-Silicon) validation, fail-fast; manage download via the CLI so checksums are verifiable | single-file download "feels frozen" w/o `Content-Length`; running from `~/Downloads` → repeated Gatekeeper prompts |
| **pre-commit / husky** | Print the required secondary step explicitly right after install ("run `X` to activate"); fail gracefully with clear errors | passive discovery — users forget the setup step, only find out when something breaks → need an *active* surface |
| **Homebrew** (`brew services`, `brew doctor`) | `brew doctor` prints the exact copy-pasteable fix command, not just "failed"; `brew services start` is idempotent (no-op if running) | **`brew services list` shows "started" even if the process crashed on launch** → must check the *real* health endpoint, not the service-manager status |
| **AWS/Azure CLI** | `--yes` for non-interactive; back up existing config (`.backup`) before overwrite | overwriting user config silently |

## Convergent recommendations (all 3 families agreed)

1. **Consent for the 7.5 GB download** — never auto-download. Interactive default: prompt
   `Download models? 7.5 GB needed (NN GB free) [y/N]` showing size + target dir + free disk.
   `--yes` for CI/headless. On decline, exit clean with "run `local-mcp setup --models` when ready".

2. **Idempotency = make `setup` a re-runnable "fix-it button"** — before doing work, check each
   state and skip what's done: (a) brew formula installed? (b) weights present + size/checksum? (c)
   `~/.omlx/settings.json` written + port pinned? (d) service running? Running `setup` 10× must be
   safe + fast (state-check < 2 s). Resume partial downloads (`curl -C -` / range), never restart
   from 0%. **Atomic config writes** (temp + `mv`); if a *custom* config exists, **warn, don't
   overwrite**.

3. **`doctor` proves the stack end-to-end** (layered, report WHICH stage failed):
   - arch = arm64 + macOS (fail-fast otherwise)
   - brew formula installed/linked; CLI version ↔ service (oMLX) version
   - config exists, port pinned (8000), port not stolen by another proc (`lsof -i :8000`)
   - weights exist + size (full SHA only on `--deep`)
   - **THE PROOF:** send a minimal real request to :8000 (a 1-token generation *and* a strict-JSON
     decode — the bridge's actual contract) and verify a conforming response within a timeout.
     Distinguish "port refused" vs "service up but model failed to load."
   - on failure: print the exact log path / tail last ~15 lines (don't fly blind) + a copy-pasteable
     fix command (brew-doctor style).

4. **Plugin nudge — triangulated** (docs + both fanout families independently converged): the plugin
   *cannot* show a banner. SessionStart hook runs a fast check (ping :8000 health / check a
   `${CLAUDE_PLUGIN_DATA}` setup marker); if not-ready, **inject `additionalContext`** so Claude
   itself tells the user to run `local-mcp setup`. **The LLM is the messenger.** This is also the
   documented LSP-plugin idiom ("user must install the binary separately first").

5. **Apple-Silicon specifics** — fail-fast if not arm64 ("requires Apple-Silicon Mac"); ensure the
   brew formula is arm64 (no Rosetta/x86 fallback — crashes heavy inference). Matches our
   AS-Mac-only decision; `detectHardware()` already exists in `bin/cli.ts`.

## PM judgment — where I OVERRIDE the fanout

Both fanout voices proposed an **aggressive** nudge ("Claude MUST refuse all coding tasks until
setup is confirmed"). **Rejected.** The bridge is an *optional token-saving offload*, not a hard
dependency — Claude works fine without it (just doesn't save frontier tokens / stay offline). The
nudge must be a **gentle, low-frequency, dismissible** one-time hint ("the local bridge isn't set
up; run `local-mcp setup` to enable private/offline token-saving"), never a work-blocking gate.
Aggressive refusal would make installing the plugin *worse* than not having it. This is the
single most important correction to the leads.

## Map to `local-mcp` (what `setup` orchestrates; what exists)

- **exists, reuse:** `download-models` (scripts/download-models.mjs, B+C default, idempotent
  skip-if-present), `detectHardware()` (arch guard), `smoke:cross-client` (doctor's stdio leg),
  `serve` (commander CLI — `setup`/`doctor` are clean new `.command()` blocks in `bin/cli.ts`).
- **net-new:** brew-install-oMLX step; write/pin `~/.omlx/settings.json` (port 8000 — note `omlx
  serve --port` persists into settings); the strict-JSON `doctor` probe; a **SessionStart hook**
  (add to `hooks/hooks.json`, currently only PreToolUse/Read) that injects the gentle nudge.

## Open design tensions (→ resolve in the scope memo / Auditor)

1. **Scope boundary** — narrow (Claude-Code *plugin* + `local-mcp setup`, this session's CEILING
   framing) vs the stale memo's broad multi-client `omcp install` (auto-write Cursor/Cline/Zed
   configs). The plugin already IS the Claude-Code config surface → broad multi-client auto-config
   is likely out of scope now. **Biggest fork.**
2. **brew auto-install** — does `setup` run `brew install jundot/omlx/omlx` itself, or detect +
   print the command? (Stale memo: don't auto-install Homebrew *itself*; oMLX-via-brew is the
   question.)
3. **`setup` impl** — POSIX-sh vs Node. Node ships with the package anyway; the nudge *hook* is a
   tiny shell script (matches enforce-bridge.sh).
4. **doctor depth by default** — fast (size-check) vs `--deep` (full SHA + inference probe).

[fanout-breakage handoff rule]: ~/.claude/.../memory/fanout-breakage-handoff-rule.md
