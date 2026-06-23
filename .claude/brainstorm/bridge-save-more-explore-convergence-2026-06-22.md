# Convergence — where can the bridge save MORE frontier tokens? (1 divergent fanout round, 6 voices)

The exploration REFRAMED the question and overturned the brief's seed ranking.

## Ranked leaks (synthesized — biggest first)
1. **Tool-output spillover / un-intercepted environment streams (THE biggest — gem, agy_pro, nv_code).**
   When an agent runs `grep`/build/test/`find`/`git log`/`bash`, the raw output goes DIRECTLY into the
   frontier context. By the time the agent "sees" it to route it to the bridge, the tokens are ALREADY
   SPENT — a structural RACE CONDITION ("the frontier must ingest the data to know it needs to offload
   it"), NOT a discipline failure. Subsumes seed-D (source_uri). This is the real form of seed-A.
2. **find-judge-apply FIND leaks (C).** Frontier reads whole files / dumps to find one thing. A strict
   extractive query (paths + line + 2-line context, never whole files) keeps FIND cheap. Medium ROI —
   but disciplined `grep -n` + `Read offset` already gets most of this; a new tool may not beat it.
3. **Retry/fallback loop — the bridge as a LIABILITY (agy_pro, new).** A lossy local summary → the
   frontier realizes it lacks detail → re-reads the raw → pays bridge tokens PLUS raw tokens = NET
   NEGATIVE. ⇒ usage principle (not a build): never route JUDGE-class / fidelity-class work to the
   lossy local model. Aligns with the settled find-judge-apply conclusion.
4. **Fanout / large-LLM-output digestion (seed-B) — DO NOT BUILD (TRAP).** agy_pro's reality check
   (and the cost/benefit): 15–30KB ≈ 5–10K tokens — minuscule on a 1M-context frontier. A local
   pre-structuring pipeline WILL drop outlier arguments + degrade the JUDGE (the very nuance the
   4-round debate showed matters), for a fractional-cent saving. The brief's seed OVER-WEIGHTED this.
   (nv_pro/nv_code/ghm wanted a chunked `fanout_digest` tool; the reality-check defeats it on ROI.)

## The honest, slightly-deflationary bottom line
- The #1 leak is **largely HARNESS territory**, not the bridge's: it needs an interceptor on the
  tool-output path BEFORE the frontier ingests it. The bridge's plugin already does the clearest case
  (enforce-bridge **PreToolUse** BLOCKS a >4KB `Read` — prevents ingestion). Extending to large
  **Bash/tool OUTPUT** is the deferred "PostToolUse output-size monitor" noted in CLAUDE.md.
- **CRUX to verify before building anything (do not assert — the session's recurring lesson):** can a
  Claude Code **PostToolUse hook actually REPLACE/truncate the tool output the model ingests**, or only
  OBSERVE + inject additionalContext? If it can only observe, the raw output still reaches frontier →
  the structural fix isn't possible at the hook layer and is a harness feature request (out of bridge
  scope). If it CAN replace → build the deferred output-monitor (dump >Nkb output to a file + return a
  `source_uri` + a tiny local TOC). This is the same shape as the 60s-wall question: verify the
  capability empirically first.

## Recommendation
1. **Don't build the fanout-digest tool** (trap — saves pennies, degrades the JUDGE).
2. **Verify the PostToolUse hook capability** (can it replace output?) — that's the gate for the only
   real high-ROI structural fix (tool-output spillover). Cheap to check; decisive.
3. If yes → the deferred PostToolUse output-monitor is the highest-ROI build. If no → it's a Claude
   Code harness feature request; the bridge's clearest win (PreToolUse Read-block) already exists.
4. Adopt the **retry/fallback-loop** caution as an explicit usage rule (don't route fidelity work to
   lossy local — already implied by find-judge-apply).

## Process note
This exploration was ONE divergent round and it productively KILLED the obvious build (fanout-digest)
and reframed the leak — exactly the right use of fanout (negative results that prevent over-building).
The grounding-audit false-positives this round (`docker-compose.yml`, and R4's `01/02/2023`,
`extract/classify`) flagged EXAMPLE strings as ungrounded repo paths — see the sister feedback.
