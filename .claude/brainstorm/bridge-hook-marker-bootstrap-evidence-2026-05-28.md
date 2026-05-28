# Bridge hook marker self-bootstrap fails (touch + reader in one command)

Date: 2026-05-28
Context: surfaced during the [B] hook-fix batch (A4/B1/B3/B2 commits
9bc514b → 26b5c5a) when the agent needed to read a >4KB analysis-path
file (`bridge-hook-git-commit-evidence-2026-05-28.md`, 5471 bytes).

## What happened

To enter Edit-prerequisite mode on an analysis path, the hook's own
`emit_analysis_block` error message recommends:

    touch ${CLAUDE_PROJECT_DIR}/.claude/.bridge-edit-mode

The agent issued the natural one-liner that combines the marker set
with the actual read:

    touch /HOME/ollama-claude/.claude/.bridge-edit-mode \
      && cat /HOME/ollama-claude/.claude/brainstorm/bridge-hook-git-commit-evidence-2026-05-28.md

(`/HOME/...` placeholder in this memo for the same path-shape false-
block reason that motivated B1; the original used the literal absolute
path.)

Hook response:

    PreToolUse:Bash hook error: [bridge enforcement — project analysis path]
    File: .../bridge-hook-git-commit-evidence-2026-05-28.md (5471 bytes)
    Reason: matches analysis-path pattern — larger than 4096 bytes.

The marker was NOT yet set when the hook fired: PreToolUse runs on
command submission, scans the entire CMD before any of it executes,
and finds the `cat <path>` substring at command position before the
`&&`-chained `touch` has a chance to create the marker. The hook
checks for marker file existence at that moment and finds none.

## Why this is a painpoint

The bypass mechanism is documented in the same error message it's
meant to resolve, but new users will naturally chain it with the
intended read — and that pattern silently fails. The first time a
user hits an analysis-path block, they read the suggestion, try the
obvious one-liner, get re-blocked, then have to figure out the issue
is "marker must be a separate prior command". That's an avoidable
~30s detour per occurrence, hitting every new user once and recurring
across compactions for the same user.

The `emit_analysis_block` message documents the marker mechanism but
does NOT warn about the chained-command pitfall.

## Reproduce

Empirical, this session (post all [B] fixes applied):

1. Ensure `${CLAUDE_PROJECT_DIR}/.claude/.bridge-edit-mode` does NOT exist
   (or is older than `OMCP_HOOK_MARKER_EXPIRE_SEC`, default 3600s).
2. Issue: `touch <marker> && cat <analysis-path>` where `<analysis-path>`
   is a file under one of `OMCP_HOOK_ANALYSIS_PATHS` and is bigger than
   `OMCP_HOOK_ANALYSIS_THRESHOLD_BYTES` (default 4096).
3. Observe: hook blocks. The touch never runs. The marker is still
   absent after the failed command.

## Possible deeper fix directions

1. **Doc tweak in `emit_analysis_block`** — minimum-viable: add one
   sentence noting that the marker must be set in a SEPARATE prior
   command, e.g.:

       Note: this hook fires before any `&&`-chained `touch` can run,
       so `touch <marker> && <reader> <file>` will still be blocked.
       Issue `touch <marker>` as its own command first.

   Zero behavior risk. Addresses the discovery gap.

2. **Atomic self-bootstrap detection** — surgical: if the FIRST segment
   of the command is exactly `touch <marker-path>`, set the marker
   in-hook (via a side-effect `touch`) before continuing the scan, so
   `touch <marker> && <reader>` works as users naturally expect. Adds
   side-effect logic to a PreToolUse hook, which the rest of the
   script avoids — needs care.

3. **Pre-flight bypass env var** — heavier: `OMCP_HOOK_SUSPEND=1 cmd`
   makes the hook exit 0 unconditionally for that one invocation. The
   agent uses this when it knows it's doing bulk analysis editing.
   More infrastructure, but more general than (2).

(1) is the minimum-viable patch with zero risk and would resolve the
issue today.

## Severity

UX cliff, not workflow blocker. Costs ~30s per first-occurrence per
user. Recurs across compactions because the lesson doesn't transfer.
Lower priority than the original A4/B1 (which were active workflow
blockers), but a steady papercut for every onboarder.

## Cross-references

- Original painpoint list: `.claude/brainstorm/helpers-tooling-painpoints-2026-05-27.md`
- Sibling evidence memo (B1 escalation): `.claude/brainstorm/bridge-hook-git-commit-evidence-2026-05-28.md`
- Hook script (the `emit_analysis_block` function is where the doc
  tweak would land): `.claude/hooks/enforce-bridge.sh`
- [B] batch commits this session: 9bc514b (A4), ca51bb8 (B1),
  3e210d7 (B3), 26b5c5a (B2). None addresses this painpoint directly —
  this memo is the follow-up surfaced during that work.
