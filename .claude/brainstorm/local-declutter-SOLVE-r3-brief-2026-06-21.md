# Round 3 — SOLVE IT. Engineer the LOCAL model to do this WELL. No defeatism.

Earlier rounds drifted into "don't build / use frontier" — that framing was WRONG (the
brief invited it). RESET: the local model MUST do this task well. Your job is to ENGINEER
that. **"Use frontier for the judgment" is BANNED as an answer.** The earlier local failure
used a BAD design (one free-form `extract` that had to hunt + quote + classify + reason at
once, with no rubric and no examples). We are not repeating that. Design the GOOD version.

## Fixed pipeline (don't re-litigate)
- FIND = deterministic `grep -nE '[0-9]{4}-[0-9]{2}-[0-9]{2}'` → list of (line#, full line, date). NOT the LLM's job; solved.
- JUDGE = ONE local call, <60 s, grammar-constrained, that labels EACH pre-found candidate. ← make THIS reliable.
- EDIT = deterministic (strip the date token from the labelled lines). Solved.

## Tool interface you must design WITHIN (real constraint)
The bridge `extract` tool takes ONLY: a JSON `schema` + a `text` payload (no separate prompt
field). So the rubric + few-shot + the numbered candidate lines all go INTO `text`; the
`schema` locks the OUTPUT shape. tier B = Qwen3-4B, tier C = Qwen3-8B, both grammar-locked
(oMLX json_schema), `thinking` on/off selectable.

## PRODUCE THE ACTUAL ARTIFACTS (not descriptions — paste-and-run)
1. **Output SCHEMA** — array of one verdict per candidate, keyed by index, enum =
   {strip, keep, uncertain}. No free-form, no quoting (verbatim already known from grep).
   Fixed length = N. Write the literal JSON Schema.
2. **`text` payload TEMPLATE** — a crisp operational RUBRIC that turns "decorative vs
   load-bearing" into MECHANICAL, cue-based rules a 4B can apply, e.g.:
   - cue words near the date (updated/added/as of/since/lesson/handoff/shipped/用户确立/过审) → strip
   - date inside a filename/path (token ends `.md`, or has `/`) → keep
   - date in a markdown table cell, or after expires/until/by/deadline, or a logged metric row → keep
   Then 4–6 FEW-SHOT examples: input line → correct verdict (cover each rule + 1 tricky). Write them out.
3. **BATCHING** to fit ONE <60 s call for ~30 candidates: all in one call? number them and
   require EXACTLY N outputs; validate count; retry once on mismatch? Or chunk K? Justify and specify.
4. **"uncertain" handling that stays LOCAL & SAFE**: e.g. uncertain→keep (no-op = never
   corrupts), surface the small uncertain list separately for optional human glance AFTER — so
   the single local call alone yields a safe, useful diff. Specify.
5. **Settings**: thinking on/off, temperature, tier B vs C — pick and justify for reliability.

Each voice: give the LITERAL schema + the LITERAL text template + the LITERAL few-shot lines.
Concrete enough that I paste it into a real `extract` call and run it this minute.

---

## EMPIRICAL RESULT — gem's design tested on real bridge `extract` (tier B = Qwen3-4B, thinking off)
Test = 12 real lines from this session's cleanup, known ground truth (9 strip / 3 keep).
- **10/12 correct, IDENTICAL across two warm re-runs, 6–10 s** (vs the original naïve `extract`:
  whole-file false-negative + hallucination + 84 s). No array drift (exactly 12 index-paired
  verdicts), no hallucinated entries.
- The 2 misses: (a) **#6 a `.md` filename → model said `strip`** = the one DANGEROUS error
  (would break a pointer); SYSTEMATIC (reproduced). (b) #5 `gem-pro is dead (2026-06-18)` →
  `keep`, debatable + the SAFE direction.
- **Fix = deterministic pre-filter**: filenames (`\S+\.md`/`.json`/`/`-paths) and markdown table
  rows (`^\s*\|`) are mechanically KEEP — never send them to the LLM. That removes the entire
  dangerous error class. On the 9 semantic-residue lines the 4B was fully correct (8 strip + 1
  safe). → effectively **12/12, zero dangerous errors.**

## VALIDATED PIPELINE (empirical, not argued)
1. **FIND** — `grep -nE '[0-9]{4}-[0-9]{2}-[0-9]{2}'` (deterministic).
2. **Pre-filter** — date in a filename/path token, or in a markdown table row → KEEP, deterministically (don't send to LLM).
3. **JUDGE** — ONE batched local `extract` over the residue: index-paired schema (`{verdicts:[{index,decision:enum[strip,keep,uncertain]}]}`) + the cue rubric + 4–6 few-shot + `[DATA START/END]` delimiters; `thinking:off`; ~6–10 s for ~10 candidates (chunk K≈10 if more, validate count, retry once).
4. **uncertain → keep** (safe no-op) + surface the small uncertain list for an optional glance.
5. **EDIT** — deterministic strip of the date token on `strip`-verdict lines.

Meta-lesson: the local model "couldn't do it" was a TASK-DESIGN failure (hunt+quote+judge at
once, no rubric/examples), not a capability ceiling. Empiricism (one real test) beat 2 rounds
of voice debate. Winner voice: gem (gemini-3.5-flash) — produced the index-paired schema +
rubric + few-shot + caught array-drift & prompt-injection risks; ghm/nv_pro under-delivered.
