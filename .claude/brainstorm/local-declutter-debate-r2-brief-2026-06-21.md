# Round 2 — DEBATE the round-1 consensus (refute or defend, then converge)

Round-1 fanout (3 voices) CONVERGED on this architecture for making a small LOCAL model
de-clutter "decorative dates" from files reliably:
  FIND  = deterministic regex/grep (NOT the LLM) →
  JUDGE = local LLM classifies each PRE-FOUND candidate (grammar-locked `classify`, the
          candidates INJECTED into the prompt so the model never has to hunt) →
  EDIT  = deterministic sed / frontier applies.
Two voices also proposed a NEW bridge tool (`local-triage` / `annotate_candidates`) that
batches the pre-found candidates into the prompt for classification.

Now ATTACK this consensus. Resolve these hard tensions; do NOT just restate the consensus.

1. **60 s-wall vs N serial calls.** The local server is one-hot on a 16 GB Mac — calls
   SERIALIZE on Metal. One real file had 31 date candidates. "classify per candidate" = 31
   serial LLM calls; even at ~5–10 s each that's 150–300 s, blowing the hard 60 s MCP wall.
   But the BATCH alternative (all candidates in one call → array output) is exactly the
   free-form-array mode that just FALSE-NEGATIVED a whole file and hallucinated a date. How
   do you get a RELIABLE judge inside ONE 60 s call? (one grammar-constrained call with a
   fixed-length enum-per-candidate schema keyed by candidate index? chunked batches of K?
   something else?) Be concrete about the schema.

2. **Why will the LOCAL judge be reliable NOW** when tier-B `extract` just (a) returned empty
   on a file full of dates and (b) marked nearly everything load-bearing? Injecting candidates
   fixes the FIND miss — but does it fix JUDGE QUALITY (decorative vs load-bearing)? Is that
   semantic call within a 4B/8B's reach at all, even with few-shot examples? If it is NOT,
   then the JUDGE must be frontier — say so plainly.

3. **ROI / build-vs-don't.** Frontier + `grep` already did this whole job correctly in
   seconds. What concretely justifies building a new tool or pipeline — at what file
   volume / frequency does local FIND+JUDGE+EDIT actually save frontier tokens, net of the
   orchestration the frontier still does (writing the regex, applying/validating edits)? Or
   is the honest verdict "don't build — grep + frontier-judge is correct for rare cleanups;
   reserve the local model for genuinely high-volume bulk"?

4. Each voice: END with a ONE-LINE verdict — build WHAT exactly, or build NOTHING.

---

## VERDICT — 3-voice debate (mistral-medium / mistral-medium-3.5 / gemini-2.5-flash) converged, clean (3 ok)

> ⚠️ **SUPERSEDED.** This round's "don't build / JUDGE must be frontier" conclusion was a DEFEATIST artifact of an adversarially-framed brief (auditor-protocol "brief framing seeds woozle"). Round 3 EMPIRICALLY REFUTED it: an engineered local pipeline scored 10/12 (stable across warm re-runs, 6–10 s) on tier-B 4B, → effectively 12/12 once filenames/table-rows are deterministically pre-filtered. The local model CAN do it. See `local-declutter-SOLVE-r3-brief-2026-06-21.md`.

- **Don't build a local JUDGE.** decorative-vs-load-bearing is frontier-class reasoning, beyond tier B/C even with few-shot; a grammar constrains output SHAPE not TRUTH (batch still omits/dupes/invents); low file-volume ⇒ negative ROI vs the dev+corruption+maintenance cost.
- **Architecture = deterministic `grep` FIND + frontier JUDGE + deterministic `sed`/Edit EDIT.** This is exactly what the cleanup session used — confirmed correct, NOT a workaround.
- The local model "failed" = task↔capability mismatch, not a tuning gap. bridge's real niche = lossy bulk compress/extract of DENSE, present content — NOT sparse needle-find + nuanced judgment.
- Recorded durably in the [[bridge-trigger-checklist]] memory "不应使用 bridge 的场景" section.
