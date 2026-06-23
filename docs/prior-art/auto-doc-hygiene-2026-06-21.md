# Prior Art — auto doc-hygiene (decorative-date de-clutter, plug-and-play / auto-trigger)

> ⚠️ **SUPERSEDED (engine):** the local-LLM declutter pipeline this PA inventoried is superseded by
> the find-judge-apply conclusion (the JUDGE belongs on the FRONTIER; local does deterministic
> find+apply only) — see `.claude/brainstorm/general-local-tier-capability-deepstress-2026-06-21.md`
> + memory `local-tier-find-judge-apply`. Kept as the prior-art record.

Feeds the scope memo for the "de-clutter pipeline, delivered plug-and-play + auto-triggered"
feature. Grounded inventory via sister `research` (gemini google-search grounding + gpt-4o
synthesis). Licenses flagged "verify before trust" (auditor #21 — confirm from each LICENSE
before the memo locks a license claim).

## Candidate inventory (markdown/prose linters + auto-trigger delivery patterns)

| Tool | Auto-trigger | Auto-fix vs flag | License | Relevance |
|---|---|---|---|---|
| Vale | editor-on-save / CI | flag-only | MIT | prose-style; pattern ref |
| textlint | VS Code `autoFixOnSave`, `--fix` | **auto-fix** | MIT | closest "auto-fix on save" pattern |
| markdownlint(-cli2) | CLI / git-hook / Action / VS Code | `--fix` (partial) | MIT | md-structure; pattern ref |
| remark-lint | remark CLI / CI / MegaLinter | mostly flag; fix via formatter | MIT | AST-based; pattern ref |
| write-good | VS Code on-save | flag-only | MIT | prose |
| alex | CLI / pre-commit | flag-only | unverified | insensitive-writing |
| codespell | git pre-commit | `-w` auto-fix | **GPL-2.0/3.0 ✗** | typo; GPL = incompatible w/ our Apache-2.0 → pattern ref only, NOT adoptable as a dep |
| pre-commit framework | runs hooks on `git commit`, re-stages | hook-dependent (some auto-fix + re-stage) | MIT | the canonical auto-trigger + opt-in-autofix delivery pattern |
| LLM doc linters | pre-commit / CI / PR bot | AI-generated patches | varies | nearest semantic analog |

## Findings
1. **No off-the-shelf tool does "decorative-vs-load-bearing DATE" semantic judgment.** The
   linters cover prose/style/spelling/md-structure, not stale-date semantics → BUILD-fresh is
   justified for the JUDGE step (a real gap, not convenient blindness).
2. **Industry auto-trigger norm = flag-by-default; autofix is OPT-IN / explicit.** textlint
   defaults to flag (`--fix` opt-in); markdownlint `--fix` opt-in; pre-commit "auto-fix" only
   happens because the user installed the hook and it re-stages — never a silent mutation. →
   grounds the design lean: **auto-DETECT + surface, never silently mutate durable files.**
3. **Delivery pattern to ADOPT (not invent):** hook-based (our plug-and-play channel = Claude
   Code PostToolUse/Stop, same as enforce-bridge), and high-PRECISION to avoid alert-fatigue
   (the [[bridge-trigger-checklist]] cry-wolf warning).
4. **License:** we adopt NOTHING as a dependency (our pipeline = regex + local LLM, zero new
   dep); MIT tools are pattern references only; codespell (GPL) excluded.

## Decision (forming → into the scope memo)
BUILD the empirically-validated pipeline (`.claude/brainstorm/local-declutter-SOLVE-r3-brief-2026-06-21.md`
§VALIDATED PIPELINE) as the engine; DELIVER it plug-and-play via a hook that auto-DETECTS
(deterministic regex, no oMLX) and surfaces to the agent; the LLM judge + any edit stay
on-demand / opt-in / safe. Open design fork = the exact auto-trigger mechanism → design fanout.
