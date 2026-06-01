# Prior Art Review (DRAFT) — broadening bridge auto-trigger coverage

**Status: DRAFT — fan-out done (2026-06-01); pending Auditor pass on the refined framing + pick (see end).**

**Trigger (Auditor ruling, 2026-06-01):** *"Any case of an available bridge tool
NOT auto-triggering = a severe product-level bug."* Evidence from this session:
(1) `/code-review` fed a 2150-line diff to 6 frontier subagents when
`diff-semantic-index` could have triaged it locally once; (2) the only correct
bridge use all session (`extract` on a 14 KB fanout output) happened ONLY because
the enforce-bridge Read hook physically blocked the raw read — self-discipline
volunteered nothing.

## Problem

The bridge's only MECHANICAL auto-trigger is the enforce-bridge `PreToolUse` hook
on **Read** (large external / analysis / data files). Every other offloadable
operation — classifying a diff/patch, summarizing large `bash`/command output,
triaging bulk text before feeding it to subagents — relies on the agent
REMEMBERING to call the bridge. That self-discipline layer is provably unreliable
(see evidence). **The coverage gap is the severe bug**, and the fix is to widen
mechanical coverage, NOT to "remember harder" (the failed layer).

This REVISES two prior stances (named, not retconned — anti-pattern #22):
- bridge-trigger-checklist's implicit thesis "a self-check list suffices";
- enforce-bridge's documented "tolerate false-negative" threat model.
For **high-value offloadable operations, a false-negative is not tolerable.**

## Decision criteria

1. **Coverage** — catches the real leak classes (diff/patch, large bash output,
   pre-subagent triage), not just `Read`.
2. **Precision** — low false-positive. S5 (`426aafe`) removed general Bash
   reader-verb scanning *precisely because* it was false-positive-prone; do not
   reintroduce that pain.
3. **Mechanical vs advisory** — hard block (`exit 2`) > deterministic skill step >
   injected nudge (`additionalContext`). Advisory can be ignored just like the
   checklist was.
4. **Cost** — per-invocation hot-path cost (the hook fires on every matched tool
   call) + build/maintenance cost.
5. **Honesty about limits** — an LLM agent's triggering is probabilistic; no
   mechanism is 100% without a hook, and a hook acts only on what it can detect
   from the tool signature.

## Candidates (≥3)

### C1 — Skill-level triage steps (deterministic, in-skill) ⭐
Bake "run `diff-semantic-index` / `summarize` FIRST, feed only the triaged result
to frontier/subagents" into `/code-review` and similar skills.
- **Pros:** zero false-positive (a prescribed step, not a heuristic); no global-hook
  change; doesn't touch S5; directly fixes the instance that triggered this ruling.
- **Cons:** per-skill (misses ad-hoc bash run outside a skill); relies on skills
  being authored that way.

### C2 — Narrow high-precision `PreToolUse` Bash trigger
Re-add Bash scanning to enforce-bridge but ONLY for unambiguous high-value patterns
(`git diff`, `git log -p`, large-file `cat`) → nudge / soft-block toward
`diff-semantic-index`.
- **Pros:** global (covers ad-hoc bash); high precision IF strictly limited.
- **Cons:** reopens a sliver of what S5 deliberately removed; command-string parsing
  is fragile (pipes, subshells, heredocs); risk of the very false-positives S5 fled.
  Only viable if kept extremely narrow.

### C3 — `PostToolUse` cumulative-token / large-output monitor (the "S4" idea)
PostToolUse measures output size / cumulative tokens; when a Bash/Read result is
large AND text-analyzable, inject `additionalContext`: "this looks offloadable —
route through the bridge."
- **Pros:** the "purest" expression (measures actual spend, not a proxy); catches
  large output regardless of which command produced it.
- **Cons:** advisory only (PostToolUse can't block — bytes already entered context
  for THAT call; it prevents the NEXT mistake, e.g. re-reading); needs a sound
  "is this analyzable" heuristic; floated before, never built.

### C4 — Status quo (checklist only, no new mechanism)
- **Pros:** zero build.
- **Cons:** this IS the layer that just failed twice. Rejected as primary. The
  checklist update already landed (2026-06-01) as a necessary *complement*, not a
  solution.

## Prior art (in-repo)

- **S5 removal** (`426aafe`): general Bash reader-verb scanning pulled for
  false-positives — the cautionary precedent bounding C2.
- **"S4 cumulative-token monitor"**: already floated (enforce-bridge threat-model
  brainstorm + two-repo memory) as "the purest expression of the self-discipline
  goal — not built" → C3.
- **Deterministic auto-run analogs**: pre-commit hooks / linters / "format on save"
  run a fixed step without asking → the pattern behind C1 (in-skill) and C2 (hook).
- *External prior art (other MCP setups' routing/enforcement): TBD if the fan-out
  surfaces a relevant pattern — keep `[unverified]` until checked.*

## Self-adversarial risks

- Over-triggering re-creates S5's false-positive pain → keep C2 NARROW or drop it.
- Advisory nudges (C3) may be ignored exactly like the checklist was → mechanical /
  deterministic (C1 in-skill, or a block) beats advisory.
- Per-call hot-path cost (C2/C3) on every Bash call; the hook already runs on Read.
- **None reaches 100%** (probabilistic agent) — set expectations; this raises
  coverage, it doesn't eliminate the failure mode.
- Meta-risk: spending a lot of frontier effort *designing* the anti-frontier-waste
  fix. Keep this PA proportionate.

## Tentative recommendation (pending fan-out + Auditor)

- **Adopt C1 now** — in-skill triage; surgical, no enforcement risk, fixes the
  triggering instance.
- **C3 as the strategic layer** — advisory PostToolUse monitor; broad coverage, no
  S5 reopening; build only after a scope memo.
- **C2 only if** ad-hoc bash leakage proves common AND can be kept narrow enough not
  to reawaken S5.
- Keep the 2026-06-01 checklist update as the baseline complement.

## Adversarial fan-out (2026-06-01) — outcome (all points `[unverified]` leads)

3-voice fan-out (gem / nv_pro / agy_pro), routed through the bridge's own
`summarize-long` (Qwen3-8B, tier C) — NOT read raw into frontier (dogfooding the very
ruling this PA exists to enforce; ~6.7 K frontier tokens saved on a 28 KB output).

**New candidate leads:**
- **C5 — predictive pre-execution command classifier** (a model judges, before a Bash
  command runs, whether its output should be bridged). A smarter C2; more flexible than
  regex patterns but adds latency + fuzzy "intent" detection.
- **C6 — declarative tool composition** ⭐ (shift the orchestration INTO the tools:
  provide higher-level bridge ops so "analyze this diff" is ONE call that runs git-diff
  + classify internally, instead of the agent remembering to chain). Makes the right
  path the only path — shrinks the surface where the agent can forget. The bridge
  already does this in spirit via `source_uri`; C6 extends it.
- *Discounted:* "output-stream sampling / progressive load" (complex); "agent
  fine-tuning / RL for tool selection" (not feasible — we don't train the frontier model).

**Sharpened risks we understated:**
- **C2 "pattern creep"** — patterns accrete over time back toward the unsound general
  scan = slow S5 recurrence. Names the decay mechanism behind the S5 worry.
- **C3 advisory fatigue + NET token increase** — if the nudge is ignored (exactly as the
  checklist was), C3 is pure overhead AND adds its own cost → can net-INCREASE spend.
  Advisory-only is weak for the same reason self-discipline is.

**Framing challenge (most important — independent voices push back on the ruling):**
All three converged that *"any available tool not auto-triggered = severe bug"* is
**overbroad as literally stated** → pathological over-triggering + advisory fatigue
(which would get the alerts ignored, recreating the failure). **Refined framing they
propose:** scope "severe" to **HIGH-IMPACT × RELIABLY-DETECTABLE** misses.

## Revised recommendation — Auditor-passed (2026-06-01)

**Scope correction (Auditor catch):** `/code-review` and similar skills are Claude Code
HARNESS artifacts, NOT part of `local-mcp-toolbelt`. So **C1 (edit a skill) is a
personal-workflow fix, not a product fix** — it ships to no product user and helps only
the author's own sessions. It is already effectively done via the bridge-trigger-checklist
update (2026-06-01) and needs no skill edit. **The PRODUCT-scoped levers are the tools
(C6) and the plugin-shipped enforce-bridge hook (C2/C3).**

1. **Framing — APPROVED (refined):** an available bridge tool not triggering for a
   **high-value × reliably-detectable** offloadable op = severe (fix the trigger);
   low-value / context-dependent misses = note, don't escalate. (Session's
   `diff-semantic-index` miss still qualifies as severe.)
2. **C6 = the product direction (APPROVED)** — declarative composed bridge ops (make the
   right path the only path); → feature-intake step 2 (scope memo) next.
3. **C1's PURPOSE (deterministic bridge-triage before bulk analysis) IS product-worthy —
   only the VEHICLE (editing `/code-review`) was wrong.** Realized at product level by:
   - **(a) trigger the EXISTING composed tools** — for the diff case `diff-semantic-index`
     ALREADY does the one-call local triage; the failure was not-triggering it. So C1's
     diff-purpose ≈ the auto-trigger work (hook C2 / checklist), which ships via the plugin
     = product-level. Not a tooling gap, a trigger gap.
   - **(b) C6** — extend the composed-tool surface so more "analyze bulk X" intents map to
     one local call (using the tool = doing the triage, can't be half-done).
   - **(c) optional C1′** — the plugin CAN bundle its OWN slash-command/skill (plugins ship
     commands/skills/agents/hooks/mcp), so "triage-first in OUR shipped command" would be a
     genuine product fix. BUT a review-workflow command risks scope-creep (the product is a
     bridge, not a review framework) — do only if a bridge-aware review flow is explicitly
     wanted. Editing someone else's `/code-review` stays a personal-only proxy (already
     covered by the checklist update).
4. **C3** optional advisory backstop (fatigue / net-token risk); **C2** only if kept
   extremely narrow (pattern-creep → slow S5 recurrence).

## Cross-references

- Trigger ruling + evidence: `bridge-trigger-checklist` memory「严重性铁律」(2026-06-01).
- S5 removal: commit `426aafe`; threat model:
  `.claude/brainstorm/bridge-hook-threat-model-2026-05-29.md`.
- The fix that prompted this: commit `3ad92ee` (normalizeForStrictMode); review
  that found it surfaced the `diff-semantic-index` miss.
