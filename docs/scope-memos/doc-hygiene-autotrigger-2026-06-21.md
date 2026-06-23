# Scope memo — doc-hygiene de-clutter, plug-and-play + auto-triggered

Status: DRAFT — **SUPERSEDED (engine) by the find-judge-apply conclusion.** A later full-power
deep-stress (`.claude/brainstorm/general-local-tier-capability-deepstress-2026-06-21.md`; memory
`local-tier-find-judge-apply`) converged unanimously: for find+judge+apply tasks the JUDGE belongs
on the FRONTIER (small local models are confidently-wrong on the inputs they err on + can't
self-flag), with local/deterministic doing only FIND + APPLY. So a doc-hygiene auto-tool, IF built,
= deterministic regex FIND + FRONTIER judgment + deterministic APPLY — there is little local
"engine" to productize (it's the grep + frontier-judgment + Edit this session did by hand). The
trigger / plug-and-play / detector design (§4, V1–V3) may still apply; the LOCAL-judge engine this
memo + its PA assumed does NOT. Kept as the historical intake record.

Status (original): DRAFT — awaiting Auditor (user) pass. No code lands before the pass (feature-intake rule).
Prior art: `docs/prior-art/auto-doc-hygiene-2026-06-21.md`.
Engine (validated): `.claude/brainstorm/local-declutter-SOLVE-r3-brief-2026-06-21.md` §VALIDATED PIPELINE.
Auto-trigger design fanout: `.claude/brainstorm/declutter-autotrigger-design-r4-brief-2026-06-21.md`.

## 1. Problem & goal
Durable agent-authored docs (CLAUDE.md, memory files, docs/) accrete decorative dates and
diary-style noise that disperse attention every session (they auto-load). Manual cleanup works
but relies on the agent/user remembering. Goal: a de-clutter capability that ships **plug-and-play**
(via the existing plugin, like the MCP server + enforce-bridge hook) and **auto-triggers** —
the **user never deliberately invokes it** — while never silently corrupting a high-stakes file.
This also discharges the [[bridge-trigger-checklist]] iron rule: "self-discipline is unreliable →
the real fix is widening auto-trigger coverage, not remembering harder."

## 2. Prior art → conclusion (grounded)
No off-the-shelf tool does "decorative-vs-load-bearing DATE" semantic judgment (linters cover
prose/style/spelling/md-structure). So BUILD the judge, but ADOPT the industry delivery pattern:
DETECT/flag by default, autofix opt-in/explicit, never silent (textlint/markdownlint/pre-commit
norm). Zero new dependency (pipeline = regex + the local LLM we already run); MIT tools are
pattern refs only; codespell (GPL) excluded.

## 3. Engine — the validated pipeline (empirical)
Tier-B 4B scored 10/12 → effectively 12/12 with the prefilter, stable across warm re-runs, 6–10 s:
1. **FIND** = `grep -nE '[0-9]{4}-[0-9]{2}-[0-9]{2}'` (deterministic).
2. **Prefilter** = filenames/paths (`\S+\.(md|json)`, `/`) and markdown table rows (`^\s*\|`) →
   KEEP deterministically, never sent to the LLM (eliminates the one dangerous error class).
3. **JUDGE** = ONE batched local `extract` over the residue: index-paired schema (anti-drift) +
   cue rubric + 4–6 few-shot + `[DATA START/END]` delimiters (anti prompt-injection), thinking off,
   chunk K≈10, validate count, retry once on mismatch.
4. **uncertain → keep** (safe no-op).
5. **EDIT** = deterministic strip of the date token on `strip`-verdict lines.

## 4. Auto-trigger design (fanout-converged)
- **Detector** (cheap, deterministic regex, <100 ms, NO oMLX) fires on a **throttled/debounced
  PostToolUse(Write|Edit)** limited to in-scope durable docs; it appends touched files to a queue.
  It does NOT run the LLM in-hook.
- **Judge** runs **batched + asynchronous at Stop** (end of turn) over the queue — never blocks a
  hook, never inside the 60 s wall, serialized so it never fires N concurrent oMLX calls (respects
  one-hot). Produces a ready-to-apply **diff** of `strip` edits.
- **Surface + apply**: the result is surfaced as an **enforced, non-dismissible actionable item**
  (to the human or the agent — see decision F; e.g. "CLAUDE.md: N decorative dates — proposed diff ready") that requires a
  **deliberate one-tap apply**. This is the tension resolution: surfacing is unavoidable (so it
  isn't ignored — the enforce-bridge philosophy), but the mutation stays **explicit + reviewable**
  (so nothing silently corrupts a durable file). **No silent auto-apply** — per gem's point that
  even an opt-in "apply-then-report" is silent at the point of change.
- **Separate hook** (own file in hooks.json) to avoid coupling/cache-conflict with enforce-bridge.

## 5. Scope
IN: durable docs — project `CLAUDE.md`, the memory dir, `docs/` (notes/scope-memos/prior-art),
user-level `~/.claude/CLAUDE.md`.
OUT: `.claude/brainstorm/` + all historical archive (never retcon, #22); `CHANGELOG.md` (dated by
format); code/tests; README (user WIP). Filenames/version ids/table-data rows are prefiltered KEEP.

## 6. Risks / caveats (from the design fanout — fold into implementation)
1. **Validation scope**: the 10/12 validates the JUDGE's classification, NOT the safety of an
   auto-applied EDIT on live docs. Before the apply path ships, run a dedicated **safety benchmark**
   (precision on a labelled corpus; target near-zero false-strip on load-bearing dates).
2. **Detector precision** (cry-wolf): must fire only on cue-adjacent dates; filenames/tables/deadlines
   are prefiltered out. Measure false-positive rate; if high, the surfaced count is noise.
3. **`uncertain → keep` vs goal**: safe, but if too many dates land "uncertain" the tool does no
   harm AND little good. Track the uncertain rate.
4. **Rollback**: git-tracked docs roll back via git; the **memory dir is NOT git-tracked** → an
   auto/one-tap edit there has no git safety net. Consider a backup-before-edit for the memory dir.
5. **Cache-refresh + restart friction**: plugin hooks run a version-frozen cache copy → logic
   updates need cache refresh + restart (known [[restart-reminder]] gotcha).
6. **Fanout coverage — RESOLVED.** After the sister's picker-hygiene + truth-in-labeling fix, a
   clean re-run gave a proper **3 clean voices** (rc=0, no phi-4 garbage; gem/nv_pro/ghm) that
   confirmed AND hardened this design (refinements in risks 7–12 + decision F below). The earlier
   "3 ok" that was really 2-effective is fixed at the mechanism level — `fanout` now reports
   "N clean" (transport/refusal hygiene, NOT quality), and a real under-cover trips rc=5.

7. **Judge must NOT block the Stop hook.** A synchronous 6–10 s judge at Stop hangs the terminal →
   user Ctrl+C → partial/corrupt files. The judge runs background, memory-polite, consent-gated —
   never inline in a hook.
8. **Agent-context pollution / derail.** Injecting a proposed diff into the agent's context derails
   it from its primary task and burns frontier tokens → favor surfacing to the HUMAN (a Stop-time
   CLI "declutter? y/N") over agent-context injection (decision F).
9. **Infinite edit-revert loop.** If a stripped date is re-introduced by a template/system-prompt on
   the next write, the hook re-fires forever → need an idempotency/loop guard (don't re-flag a line
   a prior run already decided; detect template-sourced re-introduction).
10. **oMLX swap-death / model eviction.** An on-demand judge can swap-evict the user's other local
   model (10–30 s reload) → judge must be memory-polite (`nice`, yield under pressure), not assume
   it owns the GPU.
11. **Detector precision on legitimately-dated .md.** `CHANGELOG.md` / `RELEASE_NOTES.md` / version
   lines ("v1.2.0 - 2023-10-24") require their dates; many .md legitimately carry dates. The detector
   must exclude code-blocks/URLs/changelog-style and stay high-precision, or it floods the judge with
   no-op "keep" work + alert fatigue. (CHANGELOG/RELEASE_NOTES already out of scope; this generalizes.)
12. **Frozen-cache lock-in if buggy.** A regex bug that corrupts CLAUDE.md can't be hot-patched
   (version-frozen plugin cache) → strong argument for flag/propose + a trivial kill-switch, and
   extra caution on ANY auto-apply path.

## 7. Open decisions for the Auditor
A. **Aggressiveness default** — confirm: *enforced-surface + explicit one-tap apply* (recommended),
   vs flag-only, vs an opt-in silent-safe-apply (NOT recommended — violates "never silent").
B. **Trigger event** — **Stop-only detector** (now recommended — the clean fanout flagged
   PostToolUse-per-write as perceptible micro-stutter even at <100 ms) vs PostToolUse(throttled)+queue
   vs SessionStart. (Latency/coverage/intrusiveness tradeoff.)
C. **Scope of `~/.claude/CLAUDE.md`** (cross-project) — include in auto-detect, or leave it manual?
D. **Memory-dir backup** — add a backup-before-edit for the non-git-tracked memory dir, yes/no?
E. **Build trigger** — is this a v0.9 line of its own, or folded into a later release? (Affects
   whether we implement now or after v0.8.0 multimodal merges.)

F. **Surfacing target** — surface to the HUMAN (Stop-time CLI y/N prompt; gem's rec — avoids agent
   derail, token waste, and edit-revert loops) vs inject into the AGENT's context (enforced but
   derailing). Recommend human-CLI as default; agent-context only if a clean non-derailing signal exists.

## 8. Non-goals
Not a general prose/style linter (no Vale/textlint overlap). Not silent auto-mutation. Not for code
or historical archives. Not a new dependency.
