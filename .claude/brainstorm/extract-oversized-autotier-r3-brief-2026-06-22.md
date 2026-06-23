# Design debate ROUND 3 (FINAL — anti-woozle / steelman the user's directive)

Rounds 1–2 done. Topic: how the Tier-B bridge tools (`extract`/`classify`/`summarize`; oMLX Qwen3-4B
numCtx 8192, safe ~4.9K tok; Tier C = Qwen3-8B numCtx 32768; 16GB one-hot Mac) should handle inputs
exceeding the Tier-B limit, plug-and-play.

## R2 produced a STRONG convergence (5–6 of 6 voices)
- **KILL the sticky-tier lock** — holding the 8B resident ~120s on 16GB → OS swap-death when the user
  has a browser/IDE open; small calls pay Tier-C latency; a resetting timer = infinite lock.
- **KILL truncation-with-warning for `extract`/`classify`** — silent semantic corruption: the entity /
  decisive clause is often in the dropped tail → valid-looking JSON with empty/wrong data; agents
  ignore the `_warning` field; can crash a strict schema.
- **KILL auto-escalation for `extract`/`classify`** — removes backpressure / the circuit-breaker that
  forces a runaway agent to change strategy; lost-in-the-middle; memory hazard.
- **SHIP:** `extract`/`classify` oversized → a **structured, actionable refusal**
  `{error, input_tokens, limit, suggestion}` (the agent reads it and chunks / summarizes-first).
  `summarize` oversized → auto-handle (route to summarize-long / map-reduce; lossy OK). Threshold =
  real tokenizer count (CJK-aware), not char/N.

## The anti-woozle challenge (the WHOLE point of R3)
The USER's explicit directive that started this: **"tier handling must be part of the TOOL MECHANISM,
not something the caller must remember."** The R2 panel converged on REFUSE-with-a-nice-error — which
still pushes the chunking WORK back to the caller. **Is that convergence legitimate engineering, or is
it the panel rationalizing the comfortable path AGAINST the user's explicit ask?** "Return a structured
error telling the agent to chunk" can be a dressed-up "the caller still has to do it."

## R3 ask
1. **STEELMAN the user's directive.** Design the STRONGEST possible TRUE auto-handling of oversized
   `extract`/`classify` that does NOT incur the R2 hazards (no silent corruption, no 8B-resident
   swap-death, no backpressure loss, no lost-in-the-middle). Develop and attack this candidate:
   **schema-shape-aware auto-handling** — when the requested schema is an ARRAY-of-items ("extract all
   X" / classify each of N) the tool auto-runs a bounded **chunk → extract-per-chunk → deterministic
   UNION + dedup-by-key** with chunk OVERLAP to catch straddling entities (no LLM merge → no C5
   violation); when the schema is a SINGLE scalar/aggregate ("the total", "the verdict") it refuses
   (chunking is unsafe). Is array-union genuinely safe with overlap? Where does it still break?
2. If, after steelmanning, true auto-handling for `extract`/`classify` is still unsafe / not worth it,
   **say so explicitly and concede the R2 convergence** — but converge because the steelman GENUINELY
   fails, not by fatigue.
3. Resolve two open sub-points: (a) `summarize` oversized — escalate to Tier-C vs **map-reduce on the
   already-hot Tier-B** (better on a 16GB one-hot box?); the existing `summarize-long-chunked` is
   already Tier-C map-reduce. (b) Confirm a real-tokenizer (CJK-aware) threshold over char/N.
4. State the FINAL default you'd ship for each of the three tools + the single residual risk.
