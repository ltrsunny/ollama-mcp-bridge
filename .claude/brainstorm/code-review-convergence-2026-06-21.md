# CONVERGENCE / STABILITY round — the verdict keeps FLIPPING. Diagnose + SETTLE. (no preset)

Across adversarial rounds the conclusion reversed each time more pressure was applied
(code-review: 5-findings → F6-fix-proposed → F6-fix-rejected → "OOM-by-concurrency" found).
The reviewer suspects the flipping is partly an ARTIFACT of always-adversarial prompting
(asking "attack X" always yields attacks), with objection SEVERITY decreasing each round.

This round is NOT another pure attack. Diagnose and SETTLE. Be willing to say "converged".

## Current decision-grade verdict (stress THIS):
- V1: KEEP the broad empty-guard `text.trim()===''` (throw on all empty); do NOT add `&& promptTokens===0` (it reintroduces silent-empty for decode-abort-after-prefill).
- V2: `concurrency:1` in the fallback is a DEFENSIVE nicety, NOT a guaranteed-bug fix — the guard rejected a ~9.9K-token single prefill; a chunk is ~2K, so concurrency=2 ≈ 4K peak, FAR below the 9.9K that was rejected, so it likely fits.
- V3: findings on onProgress / regex-breadth / src.text-Spotlighting / test-gap are all LOW.

## Each voice, independently:
1. Of all the prior reversals, which were DECISION-CHANGING (alter what you'd ship) vs COSMETIC (re-word the same conclusion)? Is the objection severity genuinely decreasing (→ convergence) or are equally-strong objections appearing in both directions (→ true instability)?
2. STRESS V1–V3 for a DECISION-CHANGING flaw ONLY — not a cosmetic/speculative objection. For V2 specifically: is concurrency=2 of ~2K chunks actually unsafe given the guard rejected ~9.9K? Settle it.
3. VERDICT: "CONVERGED — ship: [minimal set]" if only cosmetic/speculative objections remain, OR "NOT CONVERGED — decision-changing flaw: [X]" if a real one stands. Do not manufacture an objection to avoid declaring convergence.
