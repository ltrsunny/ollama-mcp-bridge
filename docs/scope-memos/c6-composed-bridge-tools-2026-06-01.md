# Scope Memo (DRAFT) — C6: composed bridge tools (auto-trigger follow-on)

**Status: MEASURED (2026-06-04) — the data REFUTES the composed tools.** The baseline probe
(see "Baseline probe RESULT") shows `git diff` is **0.9%** of what leaks to the frontier (the
motivating code-review incident was an OUTLIER); the real leaks are **bash file-reads (27%,
the S5 hole)** + large doc reads. **Composed tools DROPPED; measure-first did its job —
stopped a build that would have fixed <2% of the problem.** Feature-intake steps 1-2 complete.
PA = `docs/prior-art/bridge-auto-trigger-coverage-2026-06-01.md`.

**Headline — verdict after the full auditor cycle (independent → rebut → synthesize).**
PA said "C6 primary"; a 5-platform fanout "converged" on *trigger-first* (but that was
largely brief-SEEDED — a woozle, not evidence); a collective rebuttal round then attacked
the synthesis and forced two corrections. **Final: ship a NARROW pair of composed tools for
the ephemeral-output class `source_uri` can't reach — `analyze-diff` + `run-and-analyze-
command-output` — plus a narrow redirect-hook, plus a NON-confounded telemetry signal.**
Neither hook nor composed-tool is "primary" — they hedge a genuinely-unresolved question
(does friction-reduction reduce forgetting? the rebuttal split 2-2). Scope is
evidence-bounded, not speculative. See "Recommendation (REVISED ×2 — post-rebuttal)".

## Adversarial fanout (2026-06-01)

3 rounds; voices across 5 platforms (gem / ghm_pro / nv_pro / agy_pro / copilot_pro;
gem-pro dropped = upstream-dead + OAuth sunsets 6/18). Routed through the bridge's own
`summarize-long`/`extract` (dogfood — ~13K frontier tokens saved; never raw-read). The
"full firepower" runs surfaced 3 fanout-reliability bugs, all fixed sister-side
(gem-503 `ca86c5e`; copilot-picker `029406d`/`8a26a9f`/`68f01c0`).

Convergent findings:
1. **C6 ≠ forget-fix.** Unanimous: composed tools don't stop the agent CHOOSING to skip
   the bridge; only a system-enforced trigger/hook does (gem called it a "category error").
2. **Worth-shipping composed ops** (beyond `source_uri`): the recurring winner is
   **`analyze-diff`** (git diff → classify/summarize in ONE call — the exact gap that bit
   `/code-review`). Also **`run-and-analyze-command-output`** (test/lint failures) and a
   project-directory-skeleton. The gap `source_uri` can't cover = **EPHEMERAL / dynamic
   output** (uncommitted diffs, command output) that has no file/URL.
3. **Constraint.** Multi-oMLX-call composition risks the 60 s wall / 16 GB → bound to ≤3
   internal steps, ≤45 s total, token-capped inputs, fail-fast on overflow; else it kills
   multi-step composition.
4. **Granularity.** A FEW bespoke hardened tools >> a general pipeline/recipe primitive
   (which re-introduces the very orchestration failure C6 targets — anti-pattern). Minimal
   C6 = ONE hardened bespoke tool.
5. **Sharpest sequencing (copilot):** ship the **hook FIRST + MEASURE**; build a composed
   tool ONLY IF forgetting persists.

## Adversarial discussion (2026-06-01) — the recommendation below was REVISED

The first-pass recommendation was "trigger-first → measure → C6 only if forgetting
persists." Adversarial scrutiny knocked it down:

1. **Brief-seeded woozle (load-bearing).** The fanout brief's Q1 literally asked *"is C6
   even the right fix — or is the real fix a trigger and C6 a distraction?"* — handing all
   5 voices the "trigger-first" frame. Their "convergence" is partly my own framing echoed
   back, NOT 5 independent confirmations. → discount the convergence to a lead.
2. **"C6 doesn't fix forgetting" is overstated.** "The agent must still choose it" applies
   to ANY tool (a hook can be bypassed too). C6 lowers FRICTION (one `analyze-diff` call vs
   bash-diff→pipe→classify→read) and lower friction genuinely reduces forgetting.
3. **The hook is not "the real fix" either.** A narrow hook matches only `git diff` /
   `git log -p` — it closes the git-diff SLIVER, not "the forget-gap"; and it reopens a
   sliver of S5 (deliberately removed).
4. **The measurement gate is confounded (circular).** A hook that BLOCKS the measured event
   (bypassed-bridge large reads) drives the counter to ~0 → "forgetting fixed!" → C6 never
   built — regardless of whether C6 would help. The gate is near-vacuous.

## Rebuttal round (collective mutual-challenge, 2026-06-01)

4 voices (gem / nv_pro / agy_pro / copilot_pro) were fed the competing positions P1-P4 and
told to ATTACK + adjudicate (the auditor "反驳" round). Routed through the bridge.
- **2-2 split on the weakest position:** gem+nv_pro judged P2 weakest ("friction↓ doesn't
  reduce LLM forgetting"); agy_pro+copilot judged P1 weakest ("conflates 'C6 doesn't
  enforce' with 'C6 doesn't help'"). → genuine disagreement: whether C6-via-friction helps
  is UNRESOLVED → don't bet on either; hedge.
- **All 4 attacked P4.** Two hits stuck: (a) **diff-only is too narrow** — copilot: "~⅔ of
  named leak classes unsolved"; the missed higher-value case (2 voices) = **ephemeral
  command / test / lint output** (genuinely `source_uri`-unreachable). (b) **dropping the
  telemetry gate = flying blind** (nv_pro/agy) — vs my "the gate is confounded" (a hook
  that blocks the measured event zeros its own counter). Both true → resolved below.
- gem's "large-doc / web ingestion" missed-case: REJECTED on independent review —
  `source_uri` + `summarize-long` already cover static content; no composed tool needed.

## Recommendation (REVISED ×2 — post-rebuttal, for Auditor pass)

The principled core of P4 survives; the rebuttal forced two changes (scope + telemetry):

- **Scope = the EPHEMERAL / dynamic-output class `source_uri` CANNOT reach** (not diff-only,
  not "everything"). Two bespoke composed tools:
  - **`analyze-diff`** — git diff (tree/ref) → classify/summarize, one call.
  - **`run-and-analyze-command-output`** — wrap a command (test/lint/build) → analyze its
    output locally. The higher-value case diff-only missed; genuinely ephemeral (no file/URL).
  - *Boundary (principled):* STATIC content (large docs, web) stays OUT — `source_uri` +
    `summarize-long` cover it.
- **Each tool hardened:** ≤3 internal oMLX steps, ≤45 s, token-capped input, fail-fast.
- **Narrow redirect-hook** (unambiguous patterns only — `git diff`, the wrapped commands). S5-narrow.
- **Keep telemetry, NON-confounded metric:** measure the OUTCOME — residual frontier-token
  spend on diff / command-output-shaped content — NOT the hook-intercepted event count
  (which the hook zeros). Resolves the drop-gate dispute (telemetry yes, confounded counter no).
- **Impl hazards to mitigate (gem/agy):** brittle hardcoded regex + a "magic" abstraction
  layer → keep redirect patterns minimal, tool contracts explicit.
- **Reject:** general pipeline primitive; composed-tool-as-primary; static-content composed
  tools; zero-telemetry.

## Final adversarial check (2026-06-01) — design SURVIVED (verdict adjudicated, not rubber-stamped)

The recommendation above was ITSELF put up for attack (a 4-voice round — the synthesis must
be challenged, not just the inputs). The round voted "does not survive"; that verdict is
**rejected on adjudication** (a fanout verdict gets the same skepticism as any other source):
- **Most attacks mis-applied a SECURITY threat model** (agent evades via encoding /
  obfuscating / redirecting output to files; the metric is "gameable"). This tool's model is
  **self-discipline — a COOPERATIVE agent that FORGETS, not an adversary that evades**
  (the established enforce-bridge threat model). An honest agent does not obfuscate to beat
  its own metric → those attacks don't apply.
- **Two valid grains, folded in as caveats (not design-killers):**
  1. **Escape hatch** — when raw bytes are genuinely needed (precise edit), the guard must
     not trap the agent. ALREADY handled by the hook's edit-mode marker + small-file /
     in-project allowances; the composed-tool guard inherits the same.
  2. **Don't blind-trust the local model** — the composed tools use a 4B/8B model that can
     mis-summarize. Inherent to the bridge's premise (not C6-specific); keep raw-access for
     precision-critical reads — the tool output must not be the agent's ONLY view for a
     critical decision.
- **Net: survives.** The "fail" vote stacked on an inapplicable security frame; the real
  points are caveats, mostly pre-handled. (Aside: gem hit a 503 mid-round and RECOVERED via
  the sister's new Retry-After fix `ca86c5e` — fix validated live.)

## CONVERGED CONCLUSION (iterated debate ran to dry, 2026-06-01) — supersedes the above

The recommendation was put through repeated *judge-my-rebuttal* rounds — the synthesis
itself must be challenged, not just the inputs (Auditor instruction: don't be sole judge of
your own rebuttals; debate until dry). The last round went **DRY**: "no new substantive
objection — converged on known issues." Every remaining critique is ONE nerve: **the design
rests on UNMEASURED assumptions about agent behavior** — even the diff incident is N=1
(proves *possible*, not *frequent*), and building anything first contaminates the baseline
for measuring the rest.

**So the cycle INVERTED the original "build C6" into: measure first, build on evidence.**
- **Build NOTHING composed yet** — not even `analyze-diff`.
- **Step 1 = a cheap, NON-confounded baseline probe:** a PostToolUse logger of what bulk
  content actually reaches the frontier, by source / type / size. Pure observation, BEFORE
  any intervention → not contaminated (the confounding I feared only happens post-build).
- **The data decides what (if anything) to build:** diffs dominate → `analyze-diff`;
  command/test output dominates → `run-and-analyze-command-output`; neither → build neither.
- **Reject:** building ANY composed tool before the baseline data (the debate's verdict on
  speculative over-building).

Humbling but correct: the adversarial cycle talked the design OUT of speculative
tool-building and INTO measuring first. **That inversion is the deliverable.** (Everything
above — the two-tool scope, the trigger-first cut, the PA's "C6 primary" — is the trail that
led here; this section is the conclusion.)

## Baseline probe RESULT (2026-06-04) — the data REFUTES the composed tools

Ran the read-only probe over 170 transcript files (~9.5M chars of tool-results that reached
the frontier). What actually leaks, by share of bytes:
- **Bash file-reads (`cat`/`tail`/`sed`) — 27% (the LARGEST).** These BYPASS enforce-bridge
  (post-S5 the hook scans only the Read tool, not bash).
- **Large doc/source reads — Read:md 15%, Read:ts 11%, Read:sh 6%, Read:txt 5%** (the .txt are
  saved tool-output files Read back raw — 40-57K each).
- Web 8%; **bridge-offloaded 4.6%** (n=289 — what we DID correctly offload).
- **`git diff` — 0.9%, exactly ONE result >4K.** test 0.9%, lint/build 0.4%.

**Verdict: the composed tools are REFUTED by the data.**
- `analyze-diff` ≈ 0.9% of leaks; `run-and-analyze-command-output` ≈ 1%. The code-review
  incident that motivated `analyze-diff` was an OUTLIER, not representative.
- The real leak is **(a) bash file-reads (27%, the S5 gap)** and **(b) large doc / saved-output
  reads** — neither is a composed tool; both are TRIGGER / bridge-discipline issues, now
  EVIDENCE-BASED rather than speculative.

**This is the payoff of measure-first:** it stopped ~10 debate-rounds' worth of composed-tool
design from shipping a fix for <2% of the actual problem.

*Caveat:* this history is skewed by recent meta-work (the C6 debate itself involved heavy
doc/log/transcript reading), so the doc-read share is partly inflated — but "git-diff is a
tiny fraction" is robust regardless.

**New, evidence-based direction (separate decision):** the data points at the **bash-file-read
gap (the S5 hole)** + **bridging large doc / saved-output reads** — NOT composed tools.
Pursuing the bash-read gap re-opens the S5 false-positive question and needs its own design
pass. **Composed tools (C6) = DROPPED, data-refuted.**

## In / out of scope

- **IN:** Phase-1 trigger design (narrow); the `analyze-diff` spec as a *conditional* Phase 2.
- **OUT (this memo):** building Phase 2 before Phase-1 measurement; a pipeline DSL;
  multi-step chunking inside composed tools; Linux (not a current target).

## Open questions (Auditor) — now a measure-first decision

1. Accept the CONVERGED conclusion — **build nothing composed yet; ship a cheap baseline
   probe first** (a PostToolUse logger of bulk content reaching the frontier, by
   source/type/size), and let the data decide what (if anything) to build?
2. Or override toward action: just **build `analyze-diff` now** on the strength of the one
   proven incident (it's cheap + low-risk), and skip/parallel the measurement? (The N=1
   tension: proven *possible*, not proven *frequent*.)
3. Agree to **defer** the two composed tools + redirect-hook until the baseline data exists?

## Cross-references

- PA: `docs/prior-art/bridge-auto-trigger-coverage-2026-06-01.md`
- Trigger severity ruling + checklist: `bridge-trigger-checklist` memory (2026-06-01)
- S5 Bash-scan removal precedent: commit `426aafe`
- Fanout reliability fixes that unblocked this: sister `ca86c5e` / `029406d` / `8a26a9f` / `68f01c0`
