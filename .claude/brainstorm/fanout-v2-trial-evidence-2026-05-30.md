# fanout-v2 trial evidence (2026-05-30) — sister handoff

Trialed sister helpers.sh `cf75bef` via a real 5-voice `fanout`
(agy_pro copilot_pro gem-pro ghm nv_pro) reviewing the ollama-claude
stale-comment cleanup diff. Batch completed EXIT=0; fail-soft worked
(4/5 voices returned despite 1 quota failure).

## Validated fixed ✓

- **copilot picker criterion** (was: opaque / non-deterministic winner).
  Now surfaces: `criterion=strongest-passing winner=gpt-4.1 rank=13/16
  ping=19414ms`. winner=gpt-4.1 is CORRECT given this account lacks
  gpt-5.x/opus access (ranks 1-12 fail the probe). Criterion-surfacing
  + strong-tier-preference both working.
- **nim language filter** (was: picked Japanese stockmark for English).
  Now: `_nim_pick_model: tier=large lang=en` → picked English
  `nemotron-3-super-120b`. Filter working.

## Not exercised (inconclusive)

- **_retry Retry-After**: ghm did NOT 429 this run (picked
  gpt-4.1-nano, succeeded), so Retry-After honoring couldn't be
  observed. Re-trial when a 429 actually occurs.

## NEW finding → needs a fix

- **gem-pro capacity-exhaustion retries ~5 min, UNBOUNDED by the 200s
  per-voice timeout.** gem-pro hit "You have exhausted your capacity on
  this model"; the underlying gemini client then retried 10× with
  11–34 s backoff (~253 s of waits) before failing with
  RetryableQuotaError. rc=3 fail-fast + the 200s `_timeout` did NOT
  bound it — the retry loop lives INSIDE the gemini client, below the
  `_retry` wrapper. Batch fail-soft still worked (gem-pro dropped, other
  4 returned), but ~5 min was wasted on one voice.
  - Fix sketch: wrap agentic voices in a HARD wall-clock `_timeout` that
    KILLS the child process at the budget (not just rc-based fail-fast),
    so the client's internal retry can't exceed it. Or pass a
    disable-retry / max-retries flag to the gemini client if it exposes
    one.

## Usage notes (mine — not sister bugs)

- `fanout`'s `$1` is a brief FILE PATH, not a string. Passing contents
  → `cannot read brief file: <contents>` (a clear, good error). Either
  document path-only, or also accept an inline string.
- Prompt-only voices (ghm, nv_pro) cannot read a file referenced in the
  brief (e.g. a diff at `/tmp/...`): ghm speculated blindly, nv_pro
  returned "diff not accessible". File-based reviews should use agentic
  voices only (agy_pro / copilot_pro / gem-pro), or `fanout` could warn
  when a brief references a path while prompt-only voices are included.

## Cross-ref

- Original 3-bug memo: `llm-orchestration-copilot-picker-anomaly-2026-05-29.md`
  (picker + retry + nim). Picker & nim now validated fixed; retry
  not-yet-exercised; gem-pro timeout is the new item.
