# FULL-POWER DEBATE — which proposal survives? converge on what to build (no preset)

Round 1 (full-power divergent, 7 voices) produced these distinct proposals for "a GENERAL
capability so the local layer reliably + automatically handles the tier-2 work class"
(mechanically-clear, bounded work a frontier LLM finds trivial: doc-hygiene, classify, extract,
diff-triage, lint-judgments, light transforms):

- **P1. Task DECOMPOSITION ENGINE** — dynamically identify + decompose + execute tier-2 tasks. (risk: false decompose / over-trigger)
- **P2. SYMBOLIC PIPELINE + COMPILER + VERIFICATION LAYER.** (risk: brittleness / hallucination / false confidence)
- **P3. SCAFFOLDED LOCAL-JUDGE PRIMITIVE** — one reusable grammar-locked judge that tasks call. (risk: can't decompose complex tasks)
- **P4. FINE-TUNE the local model on real-world failures** ("saturated capability"). (risk: overfit / poor generalization)
- **P5. ASYNC SHADOW-WORKER** — runs tier-2 in the background, non-blocking. (risk: context drift / edit collisions)
- **P6. TASK COMPILER** — translate NL intent → scripts the local model executes. (risk: destructive generated scripts)

DEBATE adversarially and independently. Do NOT defer to other voices; do NOT assume a house answer.

## Hard realities every proposal must survive (facts, not steers)
- Local = ONE model hot on a 16 GB Mac; calls SERIALIZE; ~60 s wall per call; grammar-constrained JSON available.
- Delivery = a plugin that auto-ships an MCP server + hooks to every session (the plug-and-play channel).
- The trigger must fire with NO deliberate user/agent invocation — and agent self-discipline is unreliable (it forgets to offload).
- Any background/async write-back risks overwriting newer edits made during the delay (read → process → write window).
- Speculative breadth unbacked by real usage data tends to be wasted (measure-first).

## Produce
Each voice: (1) which proposal(s) SURVIVE the hard realities and which DIE — with the specific
killing argument; (2) if survivors should be MERGED/MODIFIED into a better shape, state it
concretely; (3) the SINGLE thing to build FIRST, and the cheapest experiment to validate it.
Converge where logic forces it; flag genuine residual disagreement. End with a 2–3 line bottom-line.

---

## SYNTHESIS — full-power debate (7 clean voices: mistral-medium, gpt-4.1, qwen3.5-122b, gemma-3n, deepseek-v4-pro, gemini-3-flash, agy_pro). Robust ≥6-voice convergence.
**WINNER = P3 (scaffolded, grammar-locked local-JUDGE primitive) MERGED with P2's DETERMINISTIC/symbolic VERIFICATION** = a SINGLE SYNCHRONOUS call: inject candidates + rubric + few-shot (the date-probe scaffold) → grammar-locked judgment → deterministic (NOT LLM) verification of the output → deterministic apply.

**DEAD under the hard realities (unanimous-ish):**
- P1 decomposition-engine — latency stacking (decompose→execute→aggregate ≈ 180s+ blackout at one-hot 60s/call); survives only if "decomposition" degrades to a static rule-set = collapses into P3.
- P5 async shadow-worker — write-collision race (read→process→write window) → silent data loss; no OT/CRDT in an MCP server. The brief's own facts kill it.
- P4 fine-tune — no failure corpus to bootstrap, overfit, 16 GB fine-tune cost + VRAM thrash; dead as a STARTING point (maybe a much-later measure-first option on proven real failures — ghm_pro).
- P6 task-compiler (NL→scripts) — destructive generated scripts, no sandbox/rollback; survives only if heavily idempotent/confined.

**Why P3 needs P2-verify + an apply step:** a standalone judge "doesn't ACT" (no execution) and an LLM verifier hallucinates → bake the task taxonomy INTO the grammar (no dynamic decomposition) + replace the LLM verifier with DETERMINISTIC symbolic checks + a deterministic apply. Single synchronous call avoids BOTH P1's latency-stack AND P5's write-race.

**Build-first + experiment (consensus):** build the grammar-locked, deterministically-verified judge primitive; validate it with a ~50-snippet taxonomy/judgment-accuracy experiment BEFORE building any execution/orchestration engine. (measure-first satisfied.)

**The general capability = a reusable JUDGE PRIMITIVE** (concrete, buildable, testable) — NOT a runtime (P1/P5 dead), NOT a vague "pattern". Tasks (date-cleanup = first caller) invoke the same scaffolded+verified judge; it handles the SEMANTIC middle (the judge does semantic classification) while bounding risk via grammar + deterministic verify + safe-default (uncertain→flag). Supersedes the earlier thin-panel wandering (lossless-runtime / pattern / micro-substrate). Consistent with the prior measure-first / uncertain→flag / atomic-safe-write findings (the atomic-safe-write IS part of "deterministic apply").
