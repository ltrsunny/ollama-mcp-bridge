# Tooling pain points → helpers.sh evolution (handoff doc, 2026-05-27)

Compiled from a G2-review fan-out where **2 of 3 launched voices failed**
(gem→503, gem-pro→exit1; ghm earlier→quota; copilot→weak default model).
The portfolio's RESILIENCE + ERGONOMICS is the bottleneck, not the analysis.

Tag per item: **[H]** = helpers.sh / sister repo (`~/.config/llm-orchestration`)
work · **[B]** = ollama-claude bridge repo (`enforce-bridge.sh`). The sister
side takes the [H] items; the [B] items stay in ollama-claude.

## A. Cross-cutting (highest leverage — matches "abstract auto-selection")

1. **[H] copilot has NO auto model-selection.** Defaults to weak
   `claude-haiku-4.5`; I must hand-type `--model gpt-5.2 --effort xhigh` every
   call. NIM/GHM already auto-pick via `_nim_pick_model` / `_ghm_pick_model`;
   copilot has no equivalent. → add a `copilot` wrapper that auto-selects a
   strong reasoning model + effort level (no per-call `--model`).
2. **[H] No unified fan-out interface.** Each voice differs: invocation (REST
   / gemini-CLI / shell-fn / binary), agentic-vs-stdin (some read files, some
   need `cat | tool`), and failure modes. I juggle every quirk by hand. →
   one abstraction: "spawn N adversarial voices on this brief file", hiding
   per-tool differences (incl. auto file-read vs stdin).
3. **[H] No auto-retry / failover on transient failures.** 503 / capacity-
   exhaust / timeout / quota each = a manual stop. → retry transient errors
   1–2× and/or auto-failover to a sibling platform.
4. **[B] Can't read my own background-task outputs.** enforce-bridge treats
   `/private/tmp/claude-*/.../tasks/*.output` as ">1KB external" and blocks it
   → every voice result must be bridge-extracted (lossy 4B paraphrase) or is
   unreadable (gem-pro's 3221-byte output today). → exempt the agent's own
   task-output dir from the hook.

## B. Per-tool

- **[B] bridge / enforce-bridge hook**: (i) **over-block** — a reader verb
  (tail/grep/head) ANYWHERE in a command triggers scanning ALL path tokens,
  incl. args to non-reader commands → `rm /ext/big; ls | tail` is false-
  blocked. Fix: segment-scoped scan (split on `| ; && ||`; only scan path
  args of segments whose first word is a reader). (ii) **1 KB external
  threshold too aggressive** — blocks legit small reads (1137 B
  `~/.claude.json`, 1689 B outputs). (iii) plugin tools are **deferred** →
  need a ToolSearch to surface.
- **[H/upstream] gem (3.5-flash)**: 503 on high demand (Google, transient);
  non-agentic (cat/stdin only); shallow.
- **[H] gem-pro (2.5-pro)**: slow — default 180 s timeout too tight for
  agentic file reads (300 s also risky); capacity-exhaust / exit-1 (twice
  today). → raise default timeout; detect capacity-exhaust → failover.
- **[H] copilot**: weak default model; `--effort` errors without a reasoning
  model; no picker (see A1).
- **[H] copilot-free**: 17 K input cap (AI Studio shim) → long briefs dead;
  hardcoded gemini-3.5-flash. (cross-provider BYOK picker designed, unbuilt —
  see `cross-provider-byok-picker-brief-2026-05-22.md`.)
- **[H] ghm / ghm_pro**: daily quota (50 high / 150 low) → mid-fanout "Too
  many requests"; picker doesn't surface remaining quota or fail-soft.
- **[H/upstream] nv_sum / nv_pro**: 40–70 % of catalog 404 daily; picker
  re-selects but can't fix upstream.
- **[H] agy_pro**: Gemini-backed (shares Google capacity dips); reliability
  uncertain (killed/stopped this session).

## Priority
**A1 (copilot picker) + A2 (unified interface) + A4 (bridge task-output
exemption)** — these three decide whether a fan-out can reliably convene.

## Sister-side kickoff
Open a Claude conversation anchored in `~/.config/llm-orchestration/`, point
it at this file: "Read this; implement the **[H]**-tagged items in helpers.sh,
starting A1 + A2; the **[B]** items belong to ollama-claude — don't touch the
bridge hook." Cross-repo read of this path is already allow-listed.
