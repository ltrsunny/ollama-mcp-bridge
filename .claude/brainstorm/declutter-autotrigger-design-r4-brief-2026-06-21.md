# Round 4 — DESIGN the auto-trigger mechanism for the validated date-declutter pipeline

We have an EMPIRICALLY-VALIDATED local pipeline (regex FIND → deterministic prefilter of
filenames/table-rows → batched local `extract` JUDGE w/ index-paired schema + rubric + few-shot
→ uncertain→keep → deterministic EDIT; scored 10/12 → ~12/12 with prefilter, 6–10 s, stable).
Now design HOW it fires PLUG-AND-PLAY and AUTO-TRIGGERED — the **user must NOT deliberately
invoke it**. Delivery channel = the same plugin that already ships the MCP server + the
enforce-bridge hook (Claude Code hooks: PreToolUse / PostToolUse / Stop / SessionStart).

## Hard constraints (don't re-litigate)
- oMLX is ONE-HOT on a 16 GB Mac; a 6–10 s local LLM judge must NOT run on every file edit
  (contention + latency + fires constantly mid-task).
- Durable agent-authored docs (CLAUDE.md, memory files, docs/) are high-stakes; silently
  mutating them behind the agent's back is risky.
- Grounded prior-art norm: doc linters DETECT/flag by default; autofix is opt-in/explicit
  (textlint `--fix`, pre-commit re-stage) — NEVER silent.
- Self-discipline is unreliable (a pure "nudge the agent" gets ignored — the bridge-trigger
  lesson); but auto-mutation is risky. RESOLVE this tension, don't dodge it.
- Scope = durable docs only; EXCLUDE `.claude/brainstorm` + historical archive (never retcon, #22) + code.

## Design + debate
1. **WHICH hook event** fires the cheap deterministic DETECTOR (regex cue-match, <100 ms, no
   oMLX)? PostToolUse on Write|Edit (immediate but frequent)? Stop (end of turn, batched over
   files touched)? SessionStart (once)? Justify; weigh intrusiveness vs coverage.
2. **AGGRESSIVENESS** — pick + defend a DEFAULT and an opt-in:
   - (A) flag-only: hook surfaces "file gained N likely-decorative dates"; agent/user acts.
   - (B) detect → run LLM judge on-demand → PROPOSE a ready diff; human/agent one-tap applies.
   - (C) opt-in full safe-apply (a marker like the existing `.bridge-edit-mode`): when ON, hook
     auto detect+judge+apply the safe strips (uncertain→keep), then report what changed.
   Which DEFAULT, which opt-in? How to keep the detector HIGH-PRECISION to avoid alert-fatigue /
   cry-wolf (fire only on cue-adjacent dates; never on filenames/tables/deadlines)?
3. **Where does the expensive LLM judge run** so it never blocks a hook inside the 60 s wall and
   never contends destructively — an on-demand MCP tool the agent calls? a background job?
   batched at Stop?
4. **Relationship to enforce-bridge**: extend the same hooks.json/hook family, or a separate
   hook? (Known gotcha: plugin hooks run a version-FROZEN cache copy → need cache-refresh +
   restart to go live.)

Each voice: END with a concrete recommended DEFAULT design in 2–3 lines.
