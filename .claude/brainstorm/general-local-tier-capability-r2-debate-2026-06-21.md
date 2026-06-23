# Round 2 — DEBATE: what general capability HONESTLY survives the constraints? (no preset)

Round 1 produced three divergent positions on "a GENERAL capability so the local layer reliably +
automatically handles the tier-2 work class":
- **P1 (router):** an always-on, learned meta-controller that detects tier-2 sub-tasks and auto-routes them to local.
- **P2 (ATAR):** a decompose → route → feedback-loop framework, task-agnostic.
- **P3 (phantom — adversarial):** under the real constraints, NO such general capability can exist
  without wrecking UX or corrupting files; build nothing general yet.

P3 raised FOUR killers. Debate them head-on; do NOT dodge, do NOT default to either optimism or
defeatism. Make P1/P2 (or a new proposal) confront each killer, and say honestly what survives.

1. **Latency / one-hot.** Local = ~60 s wall, one model hot, calls serialize. An always-on or
   per-turn background classifier/router is therefore infeasible. (Counter-data: the date probe's
   working design used a Stop-hook DETERMINISTIC detector + an async/consent-gated judge, never
   blocking.) Does any GENERAL capability survive this, or only per-task deterministic triggers?
2. **Trigger paradox.** If neither user nor agent deliberately invokes it: a DETERMINISTIC trigger
   (regex/hook/AST) is arguably "just a point tool" (the dumb path we rejected) — so is a
   *library of deterministic triggers behind one engine* genuinely GENERAL, or N point tools in a
   trenchcoat? A SEMANTIC trigger (local classifier each turn) costs 60 s/turn. Resolve this.
3. **Category error.** Is "tier-2" even ONE class? P3 splits it: LOSSY-generative (summarize —
   subjective, context-heavy, a 16 GB local model degrades) vs LOSSLESS-structured (doc-hygiene /
   extract / diff-triage — exact, grammar-constrainable, verifiable). Does the general capability
   apply ONLY to the lossless-structured sub-tier (where grammar + deterministic verification make
   local reliable)? Re-scope honestly.
4. **N=1 / measure-first.** One probe (date-strip) can't justify a general engine. Is the only
   honest "general" move a reusable SUBSTRATE grown instance-by-instance from real demand (which
   IS measure-first), rather than a speculative compiler/router built up-front?

## Produce
Each voice: take a clear stance — does a general capability survive, and if so what is its HONEST
shape (scope, trigger, latency story, how it earns "general" without being N point tools, and what
it deliberately EXCLUDES)? If "none survives," say what to build instead. Confront all four killers
explicitly. End with a 2–3 line verdict. Diverge from each other; converge only where forced.

---

## SYNTHESIS (orchestrator, after diverge + debate)
The debate killed the phantom (gem-r1) AND the naive-router (P1/P2) versions, and forged a bounded, real answer.

**What survives = a local STRUCTURED-TRANSFORM RUNTIME, scoped to the LOSSLESS-STRUCTURED sub-tier ONLY.**
- IN: grammar-constrainable, deterministically-verifiable work — doc-hygiene, schema-extract, diff-triage, lint-judgments.
- OUT: lossy-generative (summarize/rewrite) — local degrades + can't be verified → stays frontier/manual. (gem's category-error fix; all voices agree.)

**What makes it GENERAL (not N point-tools, not a learned router off N=1):** a shared runtime + substrate that tasks plug into as rule/grammar-packs —
1. a one-hot-aware **resource/concurrency manager** — BUILD FIRST (gem: VRAM contention; async background vs interactive local call).
2. **file version-locking / transactional write-back** — BUILD FIRST (gem: write-after-read race → silent corruption if a 60 s async task writes back edits derived from a now-stale version).
3. trigger = a **sub-10 ms local classifier** (ONNX / distilled ~100 M, NOT the 60 s model, NOT brittle-regex-only) + deterministic rules + opt-in — gem's middle ground that DISSOLVES the trigger paradox.
4. the **scaffolded-local-judge + grammar + deterministic-verification** pattern (the date-probe's winning shape) — with timeouts/guards for grammar dead-ends (gem: constrained decoding isn't free — 2–5× latency, can trap/loop).
5. tasks = config/rule-packs; generality = the shared runtime + a shareable grammar/schema repo, NOT bespoke code per task.

**Measure-first reconciliation (the key call):** do NOT build a speculative big engine (N=1 can't justify it), but do NOT build date-cleanup as a throwaway point-tool either. Build the date capability ON a MINIMAL version of the substrate (items 1–4 at their smallest) so it is instance #1 of the general thing; grow rule-packs by real demand with telemetry-gated graduation.

**Verdict:** the general capability is REAL — but only (a) scoped to lossless-structured, (b) built on a resource-manager + version-lock foundation FIRST, (c) grown measure-first. The earlier `doc-hygiene-autotrigger` scope memo becomes rule-pack #1 ON this substrate (and inherits the two prerequisites it was missing).
