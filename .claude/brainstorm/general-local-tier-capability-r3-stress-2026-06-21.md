# Round 3 — STRESS-TEST the synthesis to a DECISION (converge, don't re-diverge; no preset)

Rounds 1–2 (diverge → debate) converged on this SYNTHESIS — now ATTACK its load-bearing
assumptions and force the open decisions. This is a CONVERGE round: take decisive stances,
converge where logic forces it, and flag only genuine residual uncertainty.

## The synthesis under test
A local **structured-transform RUNTIME**, scoped to the **lossless-structured sub-tier only**
(doc-hygiene, schema-extract, diff-triage, lint-judgments; lossy-generative like summarize is
OUT). "General" because tasks share one substrate + plug in as config/rule-packs. Substrate =
(1) one-hot resource/concurrency manager, (2) file version-locking for safe async write-back,
(3) a sub-10 ms local classifier (ONNX/distilled) + deterministic rules for triggering, (4) the
scaffolded-local-judge + grammar + deterministic-verification pattern. Build a MINIMAL substrate
now with date-cleanup as instance #1; grow rule-packs measure-first.

## Attack these four — each to a verdict
1. **A vs B (the build decision).** A = commit to the minimal shared substrate now (date-cleanup
   = instance #1 on it). B = ship date-cleanup as an honest point-tool now, extract the substrate
   only once 2–3 real instances exist. Argue the STRONGER case for each, then PICK one and say why.
2. **The "prerequisites-first" paradox.** gem (r2) says build the resource-manager + version-lock
   FIRST or it becomes spaghetti. But that is up-front infrastructure off N=1 — the exact thing
   measure-first/YAGNI warns against. RESOLVE: does the date-cleanup MVP *itself* actually need a
   resource-manager + version-lock (it's one occasional, fast, consent-gated task), or do those
   only earn their keep at multi-pack concurrency? If the MVP doesn't need them, "build them first"
   is premature — true or false?
3. **Is "lossless-structured" a real boundary or a clever fiction?** gem (r2) also argued even
   "lossless-structured" leaks (CSV field-alignment needs semantic intent = lossy; grammar
   constraints can dead-end). Where EXACTLY is the verifiable boundary — is it "output is
   deterministically checkable against the input" (so date-strip/diff-triage qualify, schema-map
   may not), or something tighter? Define the inclusion test precisely, or admit the scope is fuzzy.
4. **Did the synthesis secretly RE-NARROW?** The original ask was "a GENERAL capability for this
   whole difficulty tier," after rejecting one-tool-at-a-time. Is "a lossless-structured transform
   runtime" a faithful general answer, or a doc-hygiene point-solution wearing a 'runtime' costume?
   Be brutal: if it re-narrowed, what is the genuinely-general capability that was lost?

## Produce
Each voice: a verdict on all four (esp. a PICK on #1), the single assumption most likely to be
wrong, and the one experiment that would settle #1 cheapest. 2–3 line bottom-line at the end.

---

## SYNTHESIS (round 3 — clean 3-voice pass after re-roll; UNANIMOUS; overturns the r2 synthesis)
Voices: cohere-command-a, mistral-large-3-675b, qwen3-next-80b, gemini-2.5-flash.
1. **A vs B → B, unanimous.** Ship date-cleanup as an honest point-tool now; do NOT build the
   substrate/prerequisites speculatively. Extract a shared substrate ONLY when 2–3 DIVERSE real
   instances reveal genuine shared pain (gem's experiment: build date-cleanup + 2–3 other tasks
   standalone, document duplicated logic → THAT defines the minimal substrate, not theory).
2. **Prerequisites-first → premature, unanimous** (gem REVERSED its r2 "build foundations first"):
   a single, occasional, consent-gated task has no contention + negligible concurrent-write risk →
   resource-manager + version-lock are SCALING solutions for a multi-pack future, not the N=1 core.
3. **"lossless-structured" boundary → tighter than the synthesis claimed:** qualifies only if
   invertible/information-preserving + transform logic is deterministic config (no inference at
   execution) + strict-fail on violation. date-strip/diff-triage/lint qualify; **schema-extract
   does NOT** (extraction = inference = lossy). The synthesis wrongly included "extract".
4. **Re-narrow? → YES (majority + gem).** "lossless-structured runtime" collapsed "general
   capability for the tier" into deterministic data-hygiene (glorified regex + validation),
   EXCISING the semantic middle (content-classification, normalization, fact-extraction,
   light-judgment) — most of the tier, and where the value + difficulty live. "A doc-hygiene
   point-solution in a 'runtime' costume."

**Reconciled answer (orchestrator):** the genuinely-general capability is NOT a runtime to build
now — it is the PROVEN PATTERN: deterministic-decompose + scaffolded-local-judgment + SAFE-DEFAULT
(uncertain → no-op) + verify/consent gate. The date-probe is the existence-proof that this handles
a SEMANTIC judgment safely (decorative-vs-load-bearing, 10/12, uncertain→keep). Apply the pattern
per task measure-first (date-cleanup = application #1, pattern-conformant ⇒ not throwaway); extract
shared infra ONLY when ≥2–3 diverse instances justify it. Not defeatist (pattern works), not
over-built (no speculative engine), not re-narrowed (pattern covers semantic judgment). The earlier
`doc-hygiene-autotrigger` scope memo should DROP its now-premature resource-manager/version-lock and
ship as a pattern-conformant point tool.

---

## WIDE RE-RUN (7-voice / 5-platform — added because the Auditor asked "why only 3?")
Roster = ghm ghm_pro nv_pro nv_sum nv_code gem agy_pro (6 clean / 1 degraded). Broadening did NOT
reverse the headline — it REFINED it, and caught a real correctness gap the 3-voice panel missed:
- **B still holds** (majority): point-tool-first; build a shared substrate only when ≥2–3 diverse
  instances show real duplication. The big runtime / resource-manager stays rejected.
- **CORRECTION to r3 #2 (the thin panel was WRONG here):** atomic / staleness-safe write-back is
  NOT "premature infrastructure" — it is a MANDATORY N=1 CORRECTNESS primitive (write-to-temp +
  verify-source-unchanged + atomic-rename, or re-read+hash before write; ~5 lines). r3's "don't
  build prerequisites at all for the MVP" is a data-loss liability — the read→judge/consent-delay→
  write window allows a stale overwrite even at N=1. But it's a 5-line function, NOT a
  resource-manager / lock-manager / daemon. ("Build them first" wrong; "don't build at all" also wrong.)
- **uncertain → FLAG for human review, not silent no-op** (silent no-op = attrition + lost trust).
- **Cheap compose-conventions from day 1** (consistent exit codes / log + consent format) so
  standalone tools can compose later — avoids "10 scripts that can't talk."
- gem's "build a warm-model daemon (A)" is CONDITIONAL on high-frequency triggering; with a Stop-hook
  (per-turn) trigger, cold-start is acceptable → no daemon needed yet.
- Re-narrow CONFIRMED again: the verifiable slice (date-cleanup) is buildable now; the semantic
  middle stays the open hard problem, handled instance-by-instance via the pattern, not a general
  engine yet.
(Process note: an intermediate tail-only capture of this run showed only the 3 most A-leaning voices
and wrongly suggested a full reversal to A; the full capture shows majority-B + the safety correction.
Lesson: capture fanout output in full before concluding.)
