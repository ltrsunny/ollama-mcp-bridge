# Exploration (divergent) — where can the bridge save MORE frontier tokens? Rank by ROI.

`local-mcp-toolbelt` is a local MCP server: it saves a frontier LLM's tokens by keeping raw bytes out
of the frontier context (read via `source_uri`) and offloading summarize / extract / classify /
transform / diff-semantic-index to a local oMLX model. It saves tokens ONLY when (a) the caller routes
work to it, and (b) the content isn't already in the frontier context (source_uri, not inline).

We just spent effort on a LOW-ROI fix (oversized-input handling — rare). Now find the HIGH-ROI savings.

## Grounded seed (where frontier tokens actually leak — expand & challenge these, add your own)
- **A. Auto-trigger coverage gap (structural).** Bridge savings depend on the agent REMEMBERING to
  route to it; only "Read a file >4KB" is physically hook-enforced. Diff classification, bash
  large-output analysis, **fanout-output digestion**, and tool-result digestion all rely on
  self-discipline (a plug-and-play violation: "remember to use it" = the anti-pattern). Observed this
  session: ~110KB+ of multi-voice fanout output was read into the frontier context for synthesis.
- **B. Fanout / large-LLM-output digestion (recurring, acute).** Every fanout round emits 15–30KB. The
  SYNTHESIS/JUDGE must stay on the frontier (small local models can't judge — a settled conclusion),
  but does the FULL RAW text need to enter frontier? Could the bridge pre-structure it (per-voice:
  position + key claims + dissents) losslessly-ENOUGH for the frontier to judge a compressed form?
  Constraint: plain summarize is too lossy (it dropped a key finding in practice); `extract` is capped
  to the small tier (~4.9K tokens) so it can't ingest a 15K output in one call.
- **C. find-judge-apply leaks.** FIND (search/grep) or APPLY (mechanical edits) done in the frontier
  that could be local/deterministic — frontier should do JUDGE, not bulk FIND/APPLY.
- **D. source_uri discipline.** Content read into frontier that should have been `source_uri`'d first
  (so it never entered context). What classes of this are common + auto-detectable?

## Ask (each voice INDEPENDENT — diverge, then rank)
1. What is the SINGLE biggest frontier-token leak for an agent using this bridge? Defend the ranking.
2. For the top 2–3 leaks, what's the CHEAPEST high-impact fix? Strongly prefer STRUCTURAL fixes
   (auto-trigger / plug-and-play — the tool routes itself) over discipline-based ("remember to…").
3. For leak B specifically: is there a design that compresses large LLM outputs for the frontier JUDGE
   WITHOUT the lossiness that drops key points? (e.g. per-voice structured extraction with a
   bigger-tier or chunked path; a "structured digest" tool; map-only-no-merge so the frontier does the
   merge.) Or is reading the raw output into frontier actually the right call (JUDGE needs the raw)?
4. Anti-over-engineering: flag any idea whose token-savings won't repay its build/latency cost.

Return: your ranked leak list (biggest first), the cheapest high-impact fix for the top one, and the
single highest-ROI thing you'd build next.
