# FULL-POWER DEEP STRESS — attack the matured conclusion's REMAINING assumptions (no preset)

After diverge → debate → stress, the matured conclusion is:
> A scaffolded, grammar-locked local-JUDGE primitive whose guarantees are FORM + SAFETY/REVERSIBILITY,
> NOT semantic correctness. Semantic correctness is bounded-not-guaranteed; managed by safe-default
> (uncertain → FLAG human, never silent) + reversibility + narrow scope; higher-stakes → escalate to
> human / cross-check / frontier. Date-cleanup = good first instance (bounded / reversible / flaggable).

"Verification is hollow for semantics" is SETTLED — do not re-litigate it. Press the NEW frontier;
attack these remaining load-bearing assumptions, independently and adversarially.

1. **Does "uncertain → flag" actually protect anything?** It only fires when the model KNOWS it is
   uncertain. The dangerous case is CONFIDENT-WRONG — a small model confidently misclassifies. Small
   models are poorly calibrated, so on the exact inputs where it is wrong it will NOT flag. Is the
   safety mechanism therefore hollow for the failure mode that matters — catching only the easy cases?
2. **Is a LOCAL judge the right LOCUS at all?** Given: (a) local cannot guarantee correctness; (b) the
   frontier model is ALREADY in the orchestration loop; (c) the JUDGMENT is cheap (a few tokens per
   pre-found candidate); (d) the expensive part is the bulk READ, which deterministic find/grep + local
   already handle. Why put the unreliable judgment on local at all? Steelman the alternative: **local
   does deterministic FIND + APPLY; the FRONTIER does the JUDGE** (cheap, reliable). Is the "local-judge
   primitive" solving the wrong problem — a solution chasing a justification? Or is there a real reason
   the JUDGE must be local (privacy? offline? volume?) that survives scrutiny?
3. **Is the FORM/SAFETY floor even solid?** Grammar-constrained decode can dead-end / loop; the bridge
   just shipped a silent-empty bug (a form/safety failure that slipped for a long time); "reversibility"
   assumes git, but the memory dir is NOT git-tracked. How reliable is the safety floor we lean on?
4. **Did we pick date-cleanup as the first instance because it is genuinely ideal, or because it is the
   probe we happened to run (motivated reasoning)?** What task would FALSIFY "date-cleanup is representative"?

## Hard realities (unchanged)
One model hot on 16 GB; calls serialize; ~60 s wall/call; grammar-constrained JSON; plugin auto-ships
MCP+hooks; trigger fires with no deliberate invocation; async write clobber risk; measure-first;
the frontier model is already present and orchestrating.

## Produce
Each voice: verdict on 1–4; the SINGLE deepest flaw still standing; and — given all of it — should we
BUILD the local-judge primitive, build LOCAL-find + FRONTIER-judge + LOCAL-apply instead, or NOT build
yet and gather more probes? Name the cheapest experiment to decide. 2–3 line bottom-line.

---

## SYNTHESIS — full-power DEEP STRESS (7 clean: gpt-4o-mini, llama-4-scout, mistral-large-675b, gemma-2-2b, qwen3.5-397b, gemini-3-flash, agy_pro). UNANIMOUS — reverses the LOCUS.
**Q1 — unanimous YES, "uncertain→flag" is hollow.** Small models are poorly calibrated → CONFIDENT-WRONG on exactly the inputs where they err → the flag never fires for the dangerous case. Grammar can even MASK uncertainty (forced to emit valid JSON, can't refuse). "Functionally equivalent to no safety net for the failure modes that matter."
**Q2 — unanimous: move the JUDGE to the FRONTIER.** All 7 → **LOCAL-find + FRONTIER-judge + LOCAL-apply**: the frontier is already in the loop, judgment is token-cheap, the bulk cost is the READ (deterministic find handles it). A local judge = "optimization theater that reduces safety" / "a solution searching for a justification" / "a silent corruption engine" (esp. with the untracked, un-undoable memory dir). ONLY justification for local-judge = strict air-gap / PII / offline — none present here.
**Build verdict — unanimous: do NOT build the local-judge primitive. Build LOCAL deterministic FIND + FRONTIER JUDGE + LOCAL/deterministic APPLY.**
**Cheapest experiment:** measure CALIBRATION — run ambiguous/edge-case inputs through the local judge; what % of WRONG outputs triggered "uncertain"? Expected ~0% → falsifies the safe-default hypothesis. (Or: confident-wrong caught local-vs-frontier; frontier ≥3× → frontier-judge.)

**Decisive answer (orchestrator):** the local layer should NOT own the semantic JUDGMENT — it owns deterministic FIND + APPLY; the FRONTIER (already in the loop, cheap, calibrated) owns the JUDGE. Token savings still come from local/deterministic doing the READ/FIND (bytes stay out of frontier), not from local judgment. This VALIDATES what the cleanup session actually did BY HAND (grep FIND + frontier JUDGE + Edit APPLY) and REFUTES the "local-judge primitive" that was about to be productized. Caveat — this is for the FIND+JUDGE+APPLY class; pure lossy SUMMARIZATION (read-all-to-produce) is a separate tradeoff (local = unreliable but bytes stay local; frontier = reliable but pays the bytes). Supersedes the "judge-primitive" conclusion on the LOCUS.

## Full arc (how multi-source full-power pressure moved the answer)
date-tool → lossless-runtime → pattern → judge-primitive → judge-primitive(form/safety only, not correctness) → **LOCAL-find + FRONTIER-judge + LOCAL-apply (don't put judgment on local at all)**. Each round stripped an over-claim; the deepest (calibration → confident-wrong defeats the only safety mechanism) reversed the locus.
