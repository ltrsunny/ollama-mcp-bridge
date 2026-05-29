# helpers.sh `_copilot_pick_model` anomaly: winner = `claude-haiku-4.5` despite stronger candidates

Date: 2026-05-29
Context: G3 adversarial review fan-out on the [B] hook-fix batch.
Called `fanout brief copilot_pro ghm_pro agy_pro gem` from sister
helpers.sh (post-commit 69aa30a in `~/.config/llm-orchestration/`).
copilot_pro returned a substantive review, but the model selected
looks wrong for `tier=reason`.

## What happened

The picker emitted (verbatim from the fanout output):

    [_copilot_pick_model: tier=reason probing 15: gpt-5.5 gpt-5.4
     gpt-5.3-codex gpt-5.2 gpt-5.2-codex claude-opus-4.7 claude-opus-4.6
     claude-opus-4.6-fast claude-opus-4.5 claude-sonnet-4.6
     claude-sonnet-4.5 gpt-4.1 claude-haiku-4.5 gpt-5.4-mini gpt-5-mini]
    [_copilot_pick_model: winner=claude-haiku-4.5]

At `tier=reason`, the probe list contains top-tier reasoning models
(gpt-5.5, gpt-5.4, gpt-5.3-codex, gpt-5.2, claude-opus-4.7, claude-opus-4.6,
claude-sonnet-4.6, claude-sonnet-4.5), all of which support
reasoning-effort configuration. The winner was claude-haiku-4.5, which
is mid-tier (it accepts `--effort` but its reasoning capacity is well
below the listed opus / gpt-5.x candidates).

## Why this matters

`copilot_pro` was added precisely to AUTO-SELECT a strong reasoning
model so callers don't hand-specify `--model gpt-5.2 --effort xhigh`
(painpoint A1 from `helpers-tooling-painpoints-2026-05-27.md`). If the
picker reliably returns `haiku-4.5` despite top-tier candidates in the
probe list, the wrapper delivers the convenience layer but NOT the
strength — the original problem (under-using available reasoning
power) returns.

The actual review output for this run was usable; haiku-4.5 produced
substantive adversarial critique. But quality-vs-capability is a real
degradation: gpt-5.5 / opus-4.7 reasoning on adversarial review of a
safety-hook batch would likely catch more subtle holes.

When `fanout` uses `copilot_pro` as one of N voices, the weakest of
those N voices is consistently a mid-tier model when it could have
been top-tier.

## Hypotheses

The emitted debug line doesn't expose the winner-selection criterion.
Plausible causes:

1. **Speed-based selection** — picker probes each candidate (5-tok ping
   per the iron rule), selects the fastest responder. At probe time
   gpt-5/opus may have been slower / rate-limited, so haiku won by
   latency.
2. **Quota-aware fallback** — picker may avoid models with recent
   throttle signals, falling back to haiku as a known-cheap default.
3. **Random within healthy set** — multiple models pass the probe and
   the picker picks randomly; haiku happened to win this draw.
4. **Hierarchy inversion** — the picker's ordering of "reason"-tier
   candidates may not actually prefer stronger models within the tier.

Without reading the picker body, all four are CITED-UNVERIFIED.

## Reproduce

Run any fanout that includes `copilot_pro` and inspect the
`[_copilot_pick_model: winner=...]` debug line. If `winner` is
consistently haiku / sonnet (mid-tier) when gpt-5 / opus candidates
are listed in the probe set, the picker is biased toward lower tiers
within `tier=reason`.

Cross-check: time-of-day variation, total probe count, individual
ping latencies (if the picker logs them).

## Suggested fix directions (sketches, not prescriptions)

1. **Strong-tier preference WITHIN `tier=reason`** — explicit ordering
   (gpt-5.x > opus-4.x > sonnet-4.x > haiku-4.5). Pick the first that
   passes the probe, not the fastest.
2. **Capability-aware probing** — probe with a small reasoning task
   (not a 5-tok ping). Select the model whose response demonstrates the
   strongest reasoning, not the fastest one.
3. **Caller-opt-in fast vs strong** — split `tier=reason` into two
   sub-tiers: `reason-fast` (haiku / sonnet OK) for quick reviews,
   `reason-strong` (gpt-5 / opus only) for adversarial / multi-step
   tasks like fanout adversarial review.
4. **Surface the criterion** — emit `[_copilot_pick_model: criterion=<X>
   winner=<Y> ping=<ms>]` so callers can see why a model was selected
   and tune.

## Severity

UX / quality cliff, not a workflow blocker. `copilot_pro` returns
usable output but at lower capability than its declared intent.
Compounds in multi-voice review contexts where one weak voice
diminishes the breadth/depth that the fanout was supposed to provide.

## Cross-references

- Original [H] painpoint: `.claude/brainstorm/helpers-tooling-painpoints-2026-05-27.md`
  item A1 ("copilot has NO auto model-selection")
- Sister commit that shipped `copilot_pro`: commit `69aa30a` in
  `~/.config/llm-orchestration/` (the [H] fix batch)
- Observed during: G3 fan-out on
  `.claude/brainstorm/b-batch-g3-review-brief-2026-05-28.md`,
  task-output captured at
  `/Users/rd/ollama-claude/g3-voice-output.txt` (scratch, see top of
  the `VOICE: copilot_pro` section)
- Same fanout, working tools: `_retry 2` (gem 503 → retry → success),
  `_ghm_pick_model` (chose meta/llama-4-maverick-17b high tier),
  `agy_pro` (clean run), fanout PID-wait fix (G2 catch)

## Update 2026-05-29 — G4 fanout surfaced two more bugs

Re-ran `fanout` for G4 (5 voices: copilot_pro + ghm_pro + agy_pro +
nv_pro + gem). The original picker symptom **varied** between runs,
and two additional tooling bugs surfaced.

### Update on the original `_copilot_pick_model` symptom

G3 winner = `claude-haiku-4.5`. G4 winner on a nearly-identical
probe set = `gpt-4.1`. Different model across runs.
Still mid-tier within "reason" (not the listed gpt-5.x / opus-4.x).
Reinforces that the selection criterion is **not** "strongest model
alive" — strengthens fix directions #3 (split `reason-fast` vs
`reason-strong`) and #4 (surface the criterion in debug output).

### Bug 2: `_retry` ignores HTTP `Retry-After` header

G4 `ghm_pro` hit rate-limit. Server returned `retry-after: 59` and
the picker dutifully printed it. `_retry` then waited **the
hard-coded 1 second** before the next attempt, ignoring the header.

Worked this run only because `_ghm_pick_model` re-selected a
DIFFERENT model on retry (`deepseek-v3-0324` → `meta/llama-4-scout-17b`),
so the rate-limit didn't reapply. If a rate-limit applies across
models (per-PAT, per-quota-pool), the 1-second retry would thrash.

**Fix sketch**: parse the `retry-after` value from the printed quota
line (already detected by `_ghm_pick_model`) and pass it through to
`_retry` as a delay floor, capped at e.g. 30 s for sanity.

### Bug 3: `_nim_pick_model` no language-preference filter

G4 `nv_pro` picked `stockmark/stockmark-2-100b-instruct` — a
primarily Japanese model — for an English-language brief. The voice
returned its critique in **Chinese** (model's secondary language).
Quality of analysis was OK but cross-language switching adds
friction in multi-voice review and risks losing nuance for English-
context tasks.

**Fix sketch**: `_nim_pick_model` accepts an optional `lang=en`
(default for callers like `fanout`) filter, or inspects the model's
documented primary language at probe time and prefers matches.

### Aggregate sister-side handoff payload

This memo now documents three related tooling bugs. On next
sister-session handoff: implement (1) `_copilot_pick_model`
criterion surfacing + strong-tier preference, (2) `_retry`
honoring `Retry-After`, (3) `_nim_pick_model` language filter.
