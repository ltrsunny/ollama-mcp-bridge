# Bridge hook B1 — git commit blocked by path-shape in commit message

Date: 2026-05-28
Context: helpers.sh G2 follow-up work in the sister repo
(`~/.config/llm-orchestration/`) producing a feature commit.

## What happened

The first `git commit` attempt was BLOCKED by `enforce-bridge.sh` —
not because of a real read, but because the commit message HEREDOC
contained a string that "looked like" an external file path.

## Reproduce

The blocked command was structured (paraphrased to dodge the same
hook):

    git commit -m "$(cat <<'EOF'
    feat(fanout): copilot real-ping picker ...

    Painpoint source: HOME/ollama-claude/.claude/brainstorm/
      helpers-tooling-painpoints-2026-05-27.md
    EOF
    )"

(`HOME/...` placeholder in this memo for the same reason; the
original had the literal absolute path.)

Hook response:

    PreToolUse:Bash hook error: [enforce-bridge.sh]:
      [bridge enforcement — external file]
    File: /HOME/ollama-claude/.claude/brainstorm/
      helpers-tooling-painpoints-2026-05-27.md (3986 bytes)
    Outside the project + larger than 1024 bytes.

The hook detected the path token as ">1KB external" and blocked the
entire `git commit` — even though `git commit` opens no such file.
The path token was a literal string inside a quoted commit message
body.

## Why this escalates B1's severity

B1 in `helpers-tooling-painpoints-2026-05-27.md` described false-
blocks of pipelines like `rm /ext/big; ls | tail`. Annoying but
workaroundable (split commands, move readers out of the pipeline).

This instance is qualitatively worse:

1. **NO reader verb is present** in the failing command. `git commit
   -m ...` contains no `cat / grep / head / tail / less`. The hook
   fires purely on path-shape pattern matching.

2. **The "external file" reference is INSIDE a quoted string** —
   semantically commit-message documentation, not a target of any
   read.

3. **Commit messages are the canonical place** to reference paths
   for provenance ("see X.md", "refs path/to/file"). Forcing them
   to omit full paths degrades commit history quality and ties
   future readers' hands when looking back.

4. **Workaround burns real time**: had to rewrite the commit
   message twice (cut absolute paths to relative refs) before the
   commit landed. ~3 minutes dead time on what should be a
   one-liner.

5. **Increased blast radius**: this can hit `git tag -m`, `gh
   issue create -b`, `gh pr create -b`, or any tool that takes a
   message body via stdin/HEREDOC — wherever provenance is
   documented as a string.

## B1's proposed fix doesn't cover this case

The original B1 fix proposal (`segment-scoped scan: split on
| ; && ||, only scan segments whose first word is itself a
reader`) addresses pipeline cases but **does not cover this
instance**: `git commit` is a single segment whose first word is
`git`, not a reader. Under that proposed fix, the same false-block
would still fire.

## Possible deeper fix directions

The real ambiguity is between:
- (a) path tokens passed as **arguments to reader binaries** (real
      read intent)
- (b) path tokens embedded **inside quoted strings** (textual
      reference only, not a read target)

By the time the hook sees the command, the shell has already
expanded the HEREDOC. The hook receives one giant argument to
`git commit -m`. Recovering "this token was inside quoted message
text" is hard from that flat string.

Pragmatic stop-gaps (sketches, not prescriptions):

1. **Reader/non-reader allowlist at first-word level**: extend
   beyond "reader binaries trigger scan" to "commit-shape commands
   are explicitly NOT readers". Examples: `git commit`, `git tag`,
   `git notes`, `gh issue create`, `gh pr create`, `gh release
   create`. First-word match → skip scan entirely.

2. **`-m`/`-b`/`--message` argument awareness**: for known
   message-taking commands, recognize that the argument following
   `-m` (or `-b`, `--message`, etc.) is a message body, not a path.
   This is brittle (option position parsing in shell is hard) but
   precise.

3. **Heuristic on path source**: if the "path token" appears only
   inside what looks like a quoted commit-message-shaped string
   (multiline, structured prose, etc.), treat as textual not
   target-of-read. Even fuzzier than (2).

(1) is the minimum-viable patch — small allowlist of "definitely
not readers" by first-word — and would resolve this issue today
with low engineering cost. (2) is more precise but heavier. (3)
is fuzzy and probably not worth it.

## Cross-references

- Original B1 painpoint: `helpers-tooling-painpoints-2026-05-27.md`
  (same dir as this memo)
- G2 review brief: `g2-brief.md` (sister repo
  `~/.config/llm-orchestration/`)
- Sister-side commit that was blocked first, then landed: helpers.sh
  commit `69aa30a` in `~/.config/llm-orchestration/`. Final
  commit-message phrasing uses **relative refs only**, which is
  itself a workaround signature of this bug.

## Severity recommendation

Bumping B1 from the original "false-block annoyance" severity to
"workflow blocker" severity. Specifically blocks the canonical
`git commit -m "..." Painpoint source: <path>.md` pattern, which
is the recommended way to anchor commit history to design docs.

If G2 prioritization is reopened, this instance argues for moving
B1 (or a B1-prime tightened to "first-word-non-reader allowlist")
ahead of B2 (threshold tuning) and possibly B3 (plugin name
mismatch) in sequencing.
