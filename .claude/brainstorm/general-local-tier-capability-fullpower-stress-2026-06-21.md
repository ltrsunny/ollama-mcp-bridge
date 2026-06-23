# FULL-POWER STRESS — attack the "judge-primitive" conclusion (converge; no preset)

The prior full-power debate converged on this as THE general capability for the tier-2 work class:
> A scaffolded, grammar-locked, **DETERMINISTICALLY-VERIFIED** local-JUDGE PRIMITIVE — one
> synchronous call: inject candidates + rubric + few-shot → grammar-locked judgment → deterministic
> (NOT LLM) verification of the output → deterministic apply. (It killed: decomposition-engine
> [latency], async-shadow-worker [write-race], fine-tune [no data/VRAM], NL→script-compiler [destructive].)

ATTACK this conclusion hard and independently. Do NOT defer; do NOT ratify a house answer.

1. **Is the "deterministic verification" real, or hollow for the semantic middle?** A grammar +
   symbolic check verifies output SHAPE/constraints (well-formed JSON; the cited token exists in the
   input), NOT semantic CORRECTNESS ("is this date actually decorative"). For the semantic judgments
   where the VALUE lives, does deterministic verification guarantee anything — or is it shape-validation
   in a safety costume, leaving correctness 100% on the unreliable local judge?
2. **Does "bake the taxonomy into the grammar" buy anything?** A grammar constrains the output SET
   ({strip,keep,uncertain}), not the semantic mapping. Is judgment QUALITY still entirely on the raw
   model, with grammar adding only format-safety (no reliability gain)?
3. **Generality vs re-narrowing (again).** The proposed validation = a ~50-snippet accuracy experiment
   — which validates ONE task (date-cleanup). A primitive proven on date-snippets is NOT proven for
   diff-triage / lint / extract. Is the "primitive" genuinely general, or date-cleanup re-narrowed
   with a 'primitive' label? What would ACTUALLY demonstrate generality?
4. **Steelman a killed proposal.** Make the strongest case that ONE killed proposal
   (decomposition-engine / async-worker / fine-tune / NL→script-compiler) was wrongly dismissed under
   the hard realities — or confirm the kill with a sharper argument.

## Hard realities (unchanged facts)
One model hot on 16 GB; calls serialize; ~60 s wall/call; grammar-constrained JSON available;
plugin auto-ships MCP+hooks; trigger must fire with no deliberate invocation; async write-back risks
clobbering newer edits; measure-first.

## Produce
Each voice: verdict on 1–4; does the judge-primitive SURVIVE unmodified / survive MODIFIED (state how)
/ DIE (state the replacement); the SINGLE biggest risk; and the cheapest experiment that would KILL it.
End with a 2–3 line bottom-line.

---

## SYNTHESIS — full-power stress (6 clean: cohere, llama-4-scout, llama-3.3-70b, gemma-3n, deepseek-v4-pro, agy_pro; gem dropped). UNANIMOUS — punctured the prior over-claim.
**Q1 — unanimous: "deterministic verification" is HOLLOW for semantic judgments.** It verifies output SHAPE (valid JSON, enum value, cited token exists), NOT semantic CORRECTNESS. nv_code: "the judge hallucinates a classification, the grammar makes it well-formatted, the verifier greenlights it — the semantic middle is 100% unverified LLM judgment wearing a safety costume." agy_pro: a confident misclassification gets rubber-stamped because the JSON was perfect.

**Verdict — unanimous: DIES as-framed / SURVIVES MODIFIED.** Modifications:
1. HONESTY: it is "structured extraction/judgment with FORMAT + SAFETY guarantees", NOT a "verified judgment system". Drop the implication that deterministic verification reaches semantic correctness.
2. Semantic correctness is BOUNDED-not-guaranteed → manage with safe-default (uncertain → FLAG human, never silent) + reversibility + narrow scope; escalate higher-stakes calls to cross-check / multi-judge / human / frontier.
3. Prove GENERALITY on ≥3 diverse tasks before calling it a "primitive" (else it's date-cleanup re-narrowed).

**#1 risk (most-cited): SEMANTIC OVERTRUST** — downstream treats format-verified output as correctness-verified; "well-formatted wrong answers pass without friction = worse than a visibly-unreliable system (silent, clean failures)."

**Cheapest kill experiment (nv_code):** run the judge on date-cleanup, then adversarially construct WELL-FORMED, grammar-compliant, deterministically-"verified" WRONG answers (unusual/idiomatic/non-English/context-dependent dates — "昭和56年"). If it confidently rubber-stamps misclassifications, the "deterministic verification" claim is exposed as hollow — kills the premise cheaply.

**Matured honest answer (orchestrator):** the general capability is a scaffolded, grammar-locked local-JUDGE primitive whose guarantees are FORM + SAFETY/REVERSIBILITY, NOT semantic correctness. The local layer reliably does form + safety + bounded-reversible-flaggable semantic judgments; it CANNOT guarantee semantic correctness, and labeling it "verified" is the dangerous over-claim. Date-cleanup is a good FIRST instance precisely because wrong judgments are bounded (prefilter protects filenames) + reversible + uncertain→flag; tasks where a well-formed wrong judgment causes real harm need human/cross-check/frontier. Supersedes the prior "deterministically-verified judge-primitive" framing on the verification-honesty point. (Process: bridge dogfood — the now-reconnected fixed bridge digested this 27 KB output, grep cross-check confirmed it didn't overstate.)
