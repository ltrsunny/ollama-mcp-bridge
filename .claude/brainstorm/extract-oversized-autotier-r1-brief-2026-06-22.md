# Design debate ROUND 1 (INDEPENDENT proposals — do NOT rebut others yet)

## Topic
Plug-and-play handling of OVERSIZED inputs for the Tier-B tools (`extract` / `classify` / `summarize`)
in `local-mcp-toolbelt` (a local MCP server that delegates inference tasks to a local oMLX model server).

## The problem (a plug-and-play violation)
- `extract`/`classify`/`summarize` run on **Tier B** = Qwen3-4B, oMLX numCtx **8192**, safe single-call
  input **~4.9K tokens**. They **HARD-REFUSE** larger inputs with "exceeds safe single-call limit".
- `summarize-long`/`summarize-long-chunked` run on **Tier C** = Qwen3-8B, numCtx **32768**.
- Today the CALLER must remember "input too big → switch to a Tier-C tool / chunk it." That reliance on
  caller memory IS the bug. **Goal: the tool itself auto-handles oversized input** — correct behavior
  must be the DEFAULT path, not something the caller remembers.

## Hard constraints (design within these — do not hand-wave)
- **C1 — 16GB Mac, oMLX is ONE-HOT.** Only one model resident at a time; switching B↔C = 6–11s cold
  load + a pressure-dependent prefill memory guard that can reject a prefill under accumulated pressure.
  Minimize tier swaps; don't assume B and C are both hot.
- **C2 — the 60s wall (UNCERTAIN — treat as a FORK).** Claude Code MCP calls were documented to have a
  hardcoded ~60s wall-clock timeout. BUT one empirical data point (being re-probed now): a single Tier-C
  `summarize-long` call ran **157s with NO mid-call progress** and STILL returned → the wall may be
  stale / not enforced in the current client. **Design for BOTH branches, OR argue the wall is the wrong
  axis to design around.** Note: the bridge already HAS an async-job facility (`enqueue-job` /
  `wait_for_job` / `read_job_result`) explicitly meant as the structural fix for the wall.
- **C3 — lossy summarize is NOT a substitute for structured output.** Empirically, routing a job through
  a lossy `summarize`/`summarize-long` DROPPED the single most important item (a 15.7K input → 378-token
  summary lost a key finding). So for `extract`/`classify` (schema-constrained / structured) output, the
  fix must PRESERVE the structured result — you cannot "just summarize it first."
- **C4 — schema-merge across chunks is hard.** If you chunk `extract`, an entity/field may straddle a
  chunk boundary; merging structured extractions needs dedup/reconciliation (non-trivial, error-prone).
- **C5 — local LLM = lossy bulk only (find-judge-apply).** Small local models are poorly calibrated for
  semantic judgment; don't propose a local-LLM "decide how to split / which tier" judge.

## Round-1 ask (each voice INDEPENDENT — diverge, don't converge yet)
Propose the BEST plug-and-play mechanism for oversized Tier-B-tool input. Be concrete + implementable.
Cover:
1. **The DEFAULT behavior** (per "a configurable knob nobody turns = the default IS the decision"):
   auto-escalate B→C? auto-chunk? async-job? a size-tiered combination? What exactly fires, and at what
   threshold? Is the behavior the same for `summarize` (lossy OK) vs `extract`/`classify` (must stay
   structured)?
2. **How you handle the 60s-wall fork** — does your design even depend on it? If the wall is gone,
   what's simplest? If it's enforced, what changes?
3. **Failure-mode / graceful degradation** — prefer designs whose worst case degrades to a partial
   result over a total failure.
4. **Anti-over-engineering check** — this is a focused fix to existing tools, NOT a rewrite. Flag if any
   option is too heavy for the value.

Return a crisp proposal with: the default mechanism, the threshold(s), the per-tool difference, the
wall-fork handling, the main failure mode, and a one-line "simplest viable version."
