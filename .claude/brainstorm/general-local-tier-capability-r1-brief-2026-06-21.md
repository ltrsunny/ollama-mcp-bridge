# Brief — what GENERAL capability should we build? (DIVERGE widely; there is NO preset answer)

This is a DIVERGENT brainstorm. Propose genuinely DIFFERENT framings; do NOT converge yet, and do
NOT ratify a house answer — there isn't one. Invent the option space.

## The problem (at altitude)
A whole CLASS of work — call it "tier-2": mechanically clear / bounded, the kind a frontier LLM
finds trivial (summarize, classify, extract, doc-hygiene, diff-triage, lint-like judgments) — is
today handled badly. It either (a) burns expensive frontier tokens, (b) FAILS when naively handed
to the local/small model, or (c) depends on the agent REMEMBERING to offload it. We do NOT want to
solve this one scenario at a time with hand-built tools (that's the dumb path). We want a GENERAL
capability so this entire tier is handled RELIABLY by the local layer, AUTOMATICALLY — plug-and-play,
zero deliberate invocation by user or agent.

## The evidence (a probe — DATA, not a template to copy)
We probed the tier with one task: strip decorative dates from docs. Naive local `extract` FAILED
(false-negatived a whole file, mislabeled, hallucinated). It only worked (10/12, stable, ~8 s) after
being RESTRUCTURED: deterministic find + a tightly-scaffolded bounded local judgment + deterministic
apply. That is one data point about one task. It is explicitly NOT the prescribed general solution —
do not assume the general answer is "a decomposition engine."

## Setup / constraints (facts, not steers)
Local = oMLX on a one-hot 16 GB Mac (one model hot; calls serialize; ~60 s wall per bridge call;
grammar-constrained JSON available). Delivery today = a plugin that auto-ships an MCP server + hooks
to every session. "Self-discipline is unreliable" — the agent forgets to offload. Auto-mutating
durable files is risky. Prior finding: speculative broad coverage unbacked by real usage data tends
to be wasted (measure-first).

## What to produce — DIVERGE (first principles)
Each voice: propose THE general capability you would build so the local layer reliably + automatically
handles this whole tier. Reason from first principles. Deliberately differ from the other voices.
Divergence seeds (NOT a menu to pick from — invent beyond them): a reusable decomposition/scaffolding
engine; a general scaffolded local-judge primitive that subsumes the point tools; an auto-dispatcher
that detects offloadable sub-tasks and routes them; a "task compiler" (NL task → deterministic+LLM
plan); a better local model / setup so no scaffolding is needed; a verification/safety layer as the
core; a pure agent-protocol with no new mechanism; or something none of these name.

For your proposal state, concisely: (1) the capability in one paragraph; (2) what makes it GENERAL
(works across the tier, not a point tool); (3) its single biggest risk / failure mode; (4) the
cheapest experiment that would prove or kill it on real work. Invent — don't ratify.
