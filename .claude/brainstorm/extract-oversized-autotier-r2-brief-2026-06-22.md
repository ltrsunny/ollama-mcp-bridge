# Design debate ROUND 2 (REBUT + converge) — oversized-input auto-handling for extract/classify/summarize

This is round 2. Round 1 ran 6 voices independently on: "how should the Tier-B bridge tools
(`extract`/`classify`/`summarize`, oMLX, Qwen3-4B numCtx 8192, safe ~4.9K tok) auto-handle inputs that
exceed their limit, plug-and-play, on a 16GB one-hot Mac (Tier C = Qwen3-8B numCtx 32768)?"

## What R1 established
**Convergent:** (a) split by tool type — `summarize` (lossy OK) vs `extract`/`classify` (must stay
structured); (b) NO local-LLM router — deterministic char/token threshold (~char/3.8); (c)
**truncation-with-warning** is a real, underrated option (preserve schema, inject a warning field,
never crash).

**New empirical input (since R1):** the 60s-wall now has TWO data points — 148s and 157s single Tier-C
calls (stdio transport, local plugin MCP) both returned silently → wall very likely NOT client-enforced
here. BUT: n=2 isn't proof a documented timeout is dead, AND even uncapped, a 150s synchronous block is
bad UX (no observability, client looks hung).

## Four challenges R1 raised to the original brief — ENGAGE, don't dodge
1. **Refusal = backpressure, not just a bug (agy_pro).** Hard-refuse stops a looping agent from
   invisibly triggering a 6–11s model swap + GPU monopoly + memory thrash on 16GB. Auto-escalation
   REMOVES that backpressure. Is plug-and-play worth that?
2. **Ping-pong thrashing (gem).** Agentic loop small→large→small auto-escalating = repeated B↔C swaps
   (30–50s + SSD wear). Proposed fix: a **Sticky-Tier lock** — once escalated to C, subsequent Tier-B
   calls also run on C for ~120s (C ⊇ B in ctx+capability) → ~1 swap/session.
3. **Async breaks the agent loop (gem, agy_pro).** Returning `{job_id}` mid-call breaks synchronous
   agent reasoning (client doesn't know to poll) → async-job is NOT a plug-and-play drop-in here.
4. **"Correct behavior" was never defined (nv_code).** Never-refuse? Always-same-schema?
   Preserve-semantic-accuracy? Without it, auto-handling is shooting blind.

## The forming synthesis — ATTACK it
- **Define correct behavior:** never hard-refuse on size alone; ALWAYS return a valid structured result
  (extract/classify) or a summary (summarize); on a resource limit (memory guard) DEGRADE to a
  partial/truncated result carrying an explicit `_warning` field — never crash, never silent loss.
- **`summarize` oversized →** auto-escalate to the existing `summarize-long`/`-chunked` (Tier C); lossy
  is acceptable here by definition.
- **`extract`/`classify` oversized →** auto-escalate to Tier C, BUT (a) **sticky-tier lock** to bound
  thrashing to ~1 swap/session; (b) if the memory guard rejects → **degrade to truncated Tier-B
  extraction + injected `_warning` field** (schema preserved, never crashes); (c) deterministic
  char/token threshold, no LLM router.
- **Wall:** treat as non-blocking (n=2 ⇒ uncapped) but bound synchronous wait for UX; do NOT switch to
  async (breaks the agent loop).

## Round-2 ask (rebut, then converge)
1. **Attack the synthesis.** Where does sticky-lock backfire — e.g., do small fast calls now pay
   Tier-C latency + memory for 120s after one big call? Is that acceptable, or worse than thrashing?
2. **Is "refusal = backpressure" strong enough to KEEP refusal** for `extract`/`classify` (just with a
   better actionable error) instead of auto-escalating? Weigh against the user's hard plug-and-play
   directive ("correct behavior must be the default, not caller-remembered").
3. **Truncation-with-warning for `extract`/`classify`:** safe, or a NEW silent corruption (truncating
   may drop the very entity being extracted)? When is truncation OK vs harmful? Does the `_warning`
   field actually protect the caller, or just look like it does?
4. **Converge:** state the DEFAULT you'd ship, the exact threshold(s), and the single biggest residual
   risk. If you still dissent from the synthesis, say precisely why and what you'd ship instead.
