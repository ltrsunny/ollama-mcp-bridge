# G4 brief: improvement directions for the [B] bridge-hook batch — tactical vs structural

You are ONE adversarial reviewer of several. The [B] batch (A4/B1/B3/B2,
commits 9bc514b → 26b5c5a) shipped, passed 12/12 tests, and passed a
G3 adversarial fan-out. G3 raised BOTH tactical refinements AND a META
question (is the entire pattern-matching hook approach right at all?).
This G4 round decides what to do next.

Per #21 mark every load-bearing claim EMPIRICAL or CITED-UNVERIFIED.
Per #22 challenge the brief's own framing. Per anti-woozle: argue
independently — do not assume other voices' conclusions.

## Why this G4 round exists

Each [B] fix's IMPLEMENTATION DETAILS (regex shape, allowlist content,
threshold number, error wording) were chosen single-voice (the
synthesizer's) — explicitly violating iron rule #14. G3 corrected this
post-hoc and found real holes. Now: should we patch the holes
(tactical) or restructure (the hook architecture itself)?

## What G3 found (EMPIRICAL, in
`.claude/brainstorm/b-batch-g3-review-brief-2026-05-28.md` and its
captured voice output)

Consensus across 3+ voices:
- A4 regex too permissive — `/claude-N/x/y/tasks/z.output$` unanchored
  to any scratch root; symlink-PoC bypass possible
  (`mkdir -p /tmp/claude-1/a/b/tasks && ln -s /etc/passwd
  /tmp/claude-1/a/b/tasks/leak.output`).
- B1 chain bypass worse than documented — `;` AND `&&` chained reads
  after an allowlisted prefix get exempted entirely.
- B2 narrow methodology — only prose tested; code/JSON/log token
  density not measured.
- B3 model-confusion risk — listing both legacy + plugin prefixes may
  cause LLM hallucination of hybrid namespaces.
- Iron rule #14 violation — implementation details unilateral.

Single-voice but with merit:
- B1 missing `git revert -m / stash push -m / cherry-pick -m`.
- A4 / B3 lack causal reverse tests (env-disable + verify fails-closed).
- B2 boundary at exactly `=4096` untested.
- Marker-bootstrap memo: ship the 1-line caveat now, don't defer.
- Test fixtures hardcode `/Users/rd/.claude.json` — not portable.

## Session-level signal: hook keeps misfiring during normal use

Empirical patterns observed across this session:
- `git commit` with heredoc → false-block (B1's case)
- `grep` / `awk` / `head` appended to a Bash command tail → scans the
  WHOLE command's path tokens, false-blocks unrelated source paths
  (hit three times in this session by the synthesizer alone)
- 6KB brief → analysis-path threshold catches research material the
  agent legitimately needs to read whole
- marker self-bootstrap (`touch <marker> && <reader> <file>`) silently
  fails because PreToolUse runs before `&&`

This pattern suggests the issue may be structural: regex-scanning
shell commands is impedance-mismatched against the shell's actual
syntax (heredoc, command substitution, quoting, indirection).

## The two axes

### Axis 1 — TACTICAL refinements within current hook architecture

- **T1 A4 root anchor** — positive list (`$TMPDIR/claude-*`,
  `/private/tmp/claude-*`, `/tmp/claude-*`); narrows the false-accept
  surface
- **T2 B1 allowlist extend** — add `git revert / stash push /
  cherry-pick`
- **T3 B1 chain bypass** — within current first-word-allowlist model,
  can `; cat /big` after an allowlisted prefix be tightened? Or is it
  fundamentally leaky as a stop-gap that motivates restructure?
- **T4 B2 methodology expansion** — measure code, JSON, logs; re-justify
  or adjust the 4096 threshold
- **T5 B3 simplify** — drop dual-prefix listing (avoid hybrid
  hallucination); keep ToolSearch guidance only
- **T6 Causal reverse tests** — add env-disable verification for A4
  and B3 (matches B1.4 / B2.3 pattern)
- **T7 Marker bootstrap caveat** — 1-line note in
  `emit_analysis_block` documenting that `touch <marker> && <reader>`
  needs to be two separate commands
- **T8 Test portability** — replace hardcoded fixture paths with
  generated fixtures or `$HOME`-relative

### Axis 2 — STRUCTURAL redesigns of the hook itself

The hook does pattern-matching on raw Bash command strings. Shell
syntax has features (heredoc, `$(...)`, quoting, variables,
indirection) that regex can't reliably parse. Every fix has been
patching this leak. Alternatives:

- **S1 smart-read MCP tool** — replace PreToolUse hook with a new
  bridge tool `mcp__local-mcp-toolbelt__smart-read` that stats the
  file and returns raw OR summary based on size. Agent uses smart-read
  instead of native Read. No command-string parsing. Requires a
  CLAUDE.md instruction or a Read-tool intercept to route agents to
  smart-read.
- **S2 soft signal** — hook still detects, but exits 0 + writes a
  notice to stderr that flows into the model's context. Coaching, not
  enforcement. EMPIRICAL caveat: the hook's top-of-file comment says
  "the soft rule was repeatedly ignored" — historical failure mode.
- **S3 narrow scope** — only block Read tool on files > 32 KB
  external; drop Bash command scanning entirely. Eliminates whole B1
  class of leaks. Cost: 5-32 KB Bash-cat slop is unenforced.
- **S4 cost monitoring** — track cumulative frontier-token spend per
  session; intervene only on aggregate excess, not individual reads.
  Doesn't prevent, only surfaces.
- **S5 hybrid** — strict Read enforcement (clean tool signature, no
  string parsing); drop Bash command scanning. Best of S3 + retains
  Read's enforcement value.

### Possibly more (S6+)

Voices: propose any structural option not above if you see one.

## Decide (≤500 words per voice)

1. **Position on the axes**: stay-and-patch (Axis 1 only)? Restructure
   (Axis 2)? Or hybrid (some structural change + remaining tactical)?
2. **If tactical (Axis 1)**: priority ordering of T1-T8. Anything to
   skip? Anything to hybridize?
3. **If structural (Axis 2)**: which alternative (S1-S5 or your S6+)?
   Migration path from current code?
4. **B1 chain bypass specifically**: is the first-word-allowlist model
   fundamentally leaky (motivating restructure), or can it be tightened
   acceptably within the current architecture?
5. **One empirical test** that would confirm or kill your chosen
   direction.
6. Anything else not surfaced above.

## Output (≤500 words)

Per item, give verdict + top risk + the empirical test. Mark EMPIRICAL
vs CITED-UNVERIFIED. Flag when you're echoing this brief's framing.
