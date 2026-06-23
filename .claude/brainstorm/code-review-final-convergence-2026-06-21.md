# FINAL CONVERGENCE — settle to a unanimous ship-decision (do NOT manufacture objections)

Prior rounds settled: V1 (keep the broad empty-guard `text.trim()===''` as-is; do NOT add
`&& promptTokens===0`) — unanimous. V3 (onProgress / regex-breadth / src.text-Spotlighting /
test-gap) — unanimously LOW. The ONLY remaining split was V2: is `concurrency=2` of ~2 K-token
chunks memory-safe, given a single ~9.9 K-token prefill was rejected by the guard?
  - nv_code: "OOM hypothesis falsified by the numbers — 2×2 K ≈ 4 K KV-cache peak, < half the
    9.9 K that was rejected; V2 is a cosmetic defensive nicety."
  - nv_pro / gem: "token-count ≠ memory-safety; must MEASURE empirically before declaring safe."

KEY FACT: the V2 split is EMPIRICAL and becomes MOOT under the proposed action — EVERY voice last
round either DEMANDED or ACCEPTED `concurrency:1` for the under-pressure fallback; NONE argued
against it. So the proposed SHIP-DECISION is:
  • V1 — keep the broad empty-guard as-is (committed code is already correct; nothing to change).
  • V2 — set `concurrency:1` in the fallback's chunkedSummarize (strictly safest; dissolves the
    memory question entirely — no measurement needed because we don't run 2 concurrently).
  • V3 — record onProgress / regex / src.text / test-gap as LOW; defer.

Each voice — answer ONLY:
1. Do you ACCEPT this ship-decision? (Y / N)
2. If N: name the ONE concrete, DECISION-CHANGING, ship-BLOCKING bug that remains, as a specific
   wrong-output or crash that ships GIVEN [guard-as-is + concurrency:1 + V3-deferred].
   RULES: "we should measure/validate X" is NOT a blocker (concurrency:1 already sidesteps it).
   A cosmetic/speculative/process objection is NOT a blocker. Name a concrete failure or converge.
3. If you cannot name such a concrete ship-blocker, you MUST answer "CONVERGED".

Converging is the CORRECT answer when no concrete ship-blocker exists. Do not invent an objection
to avoid converging.

---

## FINAL VERDICT (orchestrator synthesis after full-convergence round; 7 clean: 5 CONVERGED-on-[concurrency:1], 2 NOT — gem/agy_pro)
The 2 dissents were RIGHT on substance: `concurrency:1` serializes ~5 chunks × 6–10 s ≈ 30–50 s →
risks the 60 s wall / gateway timeout. So BOTH proposed fixes are over-corrections:
- `promptTokens===0` → reintroduces silent-empty for decode-abort-after-prefill (prior round, unanimous).
- `concurrency:1` → trades a (likely-non-existent, 4K-KV ≪ 9.9K-KV) memory fault for a real timeout fault.

**Reconciled convergence (satisfies all 7): hardcode NEITHER.** The committed code already uses
`concurrency: parseEnvInt('OMCP_CHUNK_CONCURRENCY')` (configurable, default 2) — which is the correct
call: memory likely fine + faster (fits the wall) + tunable to 1 under genuine external pressure.

**REFUTED on verification:** gem's division-by-zero (no division by promptTokens anywhere);
control-char-trim bypass (needs oMLX to emit \x00; non-real, no crash); multimodal-empty (these are
text tools; responses are always non-empty text); "untested fallback" (a happy-path test exists;
only chunked-partial coverage is missing = low).

**SHIP DECISION: no code change required.** The diff (`de3af4a` + `7b96516`) is sound. Optional LOW
polish: forward `onProgress` in the fallback (avoid a frozen progress bar). Everything else defers.

Meta: "debate to full convergence before fixing" was the correct call — it prevented shipping the
`concurrency:1` timeout regression. The flipping converged once the proposed fixes were exhausted and
each shown to be an over-correction → the original code stands.
