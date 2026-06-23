# Design debate ROUND 4 (full power — resolve the 2 remaining disagreements to CONVERGENCE)

Rounds 1–3 converged on most of the design (context: Tier-B tools `extract`/`classify`/`summarize`,
oMLX Qwen3-4B numCtx 8192 safe ~4.9K tok; Tier C = Qwen3-8B numCtx 32768; 16GB one-hot Mac). Settled:
no sticky-lock; no truncation-with-`_warning` for extract/classify (silent semantic corruption); no
naive auto-escalate; threshold = real CJK-aware tokenizer count (not char/N). The 60s wall is not
client-enforced (two silent Tier-C calls 148s+157s returned) but long sync blocks are still bad UX.

**Two genuine disagreements remain UNRESOLVED. Resolve EACH to one convergent answer — not a menu.**

## Disagreement 1 — `summarize` oversized: Tier-B map-reduce vs Tier-C escalate
- **Map-reduce on the already-hot Tier-B 4B** (nv_code, gem): no 8B load, no swap-death; the merge step
  is itself lossy but `summarize` is lossy by contract.
- **Escalate to Tier-C 8B** (nv_pro, ghm_pro): better single-pass quality; the EXISTING
  `summarize-long-chunked` is already Tier-C map-reduce; 32K ctx fits for the call duration.
- **Resolve:** on a 16GB one-hot Mac, what is the right DEFAULT for `summarize` oversized? Weigh
  swap-death risk of an 8B-resident call vs quality vs the fact that `summarize-long-chunked` already
  exists. Give ONE default + the size where (if ever) behavior switches.

## Disagreement 2 — `extract`/`classify`: blanket structured-refusal vs a NARROW safe auto-handle subset
R3 proved GENERAL auto-handle fails. But nv_code carved out cases it called legitimate auto-handle
candidates: (i) array-of-INDEPENDENT-PRIMITIVES ("all email addresses" → exact-string dedup, no entity
straddling); (ii) "classify each paragraph" (chunk on paragraph boundaries, union by concatenation, no
semantic merge).
- **Narrow-subset camp:** auto-handle ONLY when schema = array-of-independent-items AND dedup is
  exact-match AND chunking is on semantic boundaries (paragraph/line/JSON-object); else refuse. Honors
  the user's directive for the safe cases.
- **Blanket-refuse camp (agy_pro strongest):** schema-detection is brittle — adding one scalar field
  flips auto-handle→refuse (least-astonishment violation); "independent primitives" is hard to detect
  reliably; even array-of-emails can miss a middle/straddling item; the narrow subset isn't worth the
  API unpredictability + detection complexity. Refuse uniformly; let the agent chunk.
- **Resolve to convergence:** ship the narrow safe subset, or blanket-refuse? If narrow-subset, define
  the EXACT machine-detectable condition that is provably safe AND counter agy_pro's brittleness
  (how is detection reliable + predictable?). If blanket-refuse, show why the safe subset isn't worth
  it. Do not leave it split.

## Ask
For EACH disagreement: converge on ONE answer + the reasoning that DEFEATS the other camp. If a camp
genuinely cannot be defeated, state the honest residual and recommend the lower-risk default (prefer the
default whose worst case degrades gracefully; refusal > silent corruption). End with the final
shippable spec for all three tools (oversized behavior + threshold).
