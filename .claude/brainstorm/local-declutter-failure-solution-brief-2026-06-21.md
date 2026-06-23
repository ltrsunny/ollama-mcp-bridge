# Brief: make the LOCAL model reliably de-clutter "noise" from files

DEBATE this. Give concrete, divergent proposals + tradeoffs; challenge the premise.

## Product context
`local-mcp-toolbelt` = an MCP bridge that offloads text tasks to a LOCAL oMLX server
(Apple-Silicon, one-hot 16 GB — one model hot at a time, swaps cost 6–11 s). Tiers:
B = Qwen3-4B-Instruct (8 K ctx, the default), C = Qwen3-8B (32 K), V = Qwen3-VL-4B (images).
Strict-JSON is grammar-constrained at decode time (oMLX `json_schema`, so output ALWAYS
matches the schema). Tools: `summarize` / `classify` (grammar-locked enum label) /
`extract` (grammar-locked JSON object) / `transform` (free rewrite) / `diff-semantic-index`.
The product's whole value: raw bytes stay LOCAL, never enter the frontier model's context.
60 s hard wall per MCP call.

## The task the local model just FAILED
De-clutter decorative dates from markdown/memory files. Three sub-steps:
(1) FIND every date occurrence; (2) CLASSIFY each — decorative (when-noted metadata,
removable) vs load-bearing (a deadline / the date IS the fact) vs keep-as-is (filename
pointer, version id, data-table row); (3) produce EDITS that delete only the decorative
ones, preserving everything else byte-exact incl. markdown.

## Observed failures (Qwen3-4B tier B via `extract`, real run, schema = array of {verbatim, category, reason})
- File A (16 dates present): `extract` returned `{"occurrences": []}` — TOTAL FALSE-NEGATIVE.
  It DID read the file (in≈5086 tok) but found nothing.
- File B (31 dates): returned 22 items but — (a) marked nearly ALL "load_bearing": it
  conflated "the surrounding sentence is important" with "the DATE is load-bearing" — which
  is exactly the distinction the task needs; (b) HALLUCINATED a date (`2026-05-05`) absent
  from the text (self-noted "likely inference"); (c) "verbatim" fields were PARAPHRASED, not
  exact → useless for a surgical find-and-replace edit; (d) duplicates. Took 84 s.
- The frontier model + plain `grep -nE '[0-9]{4}-[0-9]{2}-[0-9]{2}'` did the whole job
  correctly and in seconds. So the TASK is easy; the small LOCAL model is the weak link.

## Questions to debate
1. RIGHT DECOMPOSITION? e.g. deterministic regex/`grep` does FIND (dates are a regex, not an
   LLM job); the LLM only does JUDGE on each pre-found candidate with tight local context;
   the frontier (or a deterministic apply) does the EDIT. Who should own each sub-step?
2. WRONG TOOL? `extract` (free-form whole-file array) may be the worst fit. Would
   per-candidate `classify` (grammar-locked single enum, the bridge's most reliable mode)
   beat it? Is `extract` only reliable for dense, obviously-present fields — not "find the
   needles + judge them"?
3. WHY did `extract` false-negative an entire file, and how to prevent it — chunking,
   injecting the grep-found candidates INTO the prompt (so the model judges, never hunts),
   schema framing, thinking-mode on/off, few-shot examples of decorative vs load-bearing?
4. CHALLENGE THE PREMISE: is "100 % local" even the goal? The bridge's value is offloading
   the BULK (reading the file bytes), not necessarily the judgment. Is "regex-find +
   local-classify-per-candidate + frontier-applies-edits" the honest architecture — and is
   that still a real frontier-token win?
5. Would tier C (Qwen3-8B) make the JUDGE step reliable, or is decorative-vs-load-bearing
   judgment fundamentally beyond a small local model regardless of size?
6. Is there a GENERALIZABLE pattern here (local "annotate/triage with injected candidates")
   worth a new bridge tool or a documented recipe, beyond this one date task?

Assume: one-hot 16 GB, 60 s wall, strict-JSON available, grep/sed available to the orchestrator.
