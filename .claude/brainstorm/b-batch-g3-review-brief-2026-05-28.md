# G3 brief: adversarial review of [B] hook-fix batch (post-commit)

You are ONE adversarial reviewer of several. The [B] (`enforce-bridge.sh`)
fix batch is COMMITTED to `~/ollama-claude/` (5 commits below). Find
bugs, design holes, missed cases, methodology weaknesses, regression
risks. Don't limit yourself to the questions surfaced below — go after
anything that smells wrong.

Per #21: mark each load-bearing claim EMPIRICAL (you verified) or
CITED-UNVERIFIED (asserted from the brief / your memory). Per #22:
challenge this brief's own framing if it's biased. Per anti-woozle:
review on your own merits — don't assume other voices' conclusions.

## Commits

```
9bc514b  fix(hook): A4 — exempt agent task-output paths from external block
ca51bb8  fix(hook): B1 — first-word non-reader allowlist (stop-gap) + test suite
3e210d7  fix(hook): B3 — dynamic bridge tool namespace in error text
26b5c5a  fix(hook): B2 — raise external threshold 1024 -> 4096 (empirical)
3e7b4e4  meta(brainstorm): follow-up evidence memo on marker self-bootstrap UX cliff
```

Agentic voices can `git -C ~/ollama-claude show <sha>` for full diffs.
Non-agentic voices: this brief's per-fix snippets are what you have.

## A4 — task-output exemption

Added `is_agent_task_output()` + new env `OMCP_HOOK_TASK_OUTPUT_RE`.
Fires at top of `check_path()` (before all bands).

Default regex: `/claude-[0-9]+/[^/]+/[^/]+/tasks/[^/]+\.output$`

Unilateral choices:
- Path-shape regex (not a hard-coded `/private/tmp` prefix)
- Three `[^/]+` mid-segments (uid / encoded-cwd / session-uuid)
- Default-on, empty-string disables
- Exempts ALL bands (external + analysis + data extension), not just external

Open: portable to Linux/Docker layouts? Risk of false-positive on
unrelated paths that happen to match the shape? Should it be a positive
LIST of known root prefixes instead of a free-form regex?

## B1 — first-word non-reader allowlist (stop-gap)

Added at top of Bash dispatch (before READER_RE):

```
NON_READER_FIRST_RE='^[[:space:]]*(git[[:space:]]+(commit|tag|notes)|gh[[:space:]]+(issue|pr|release)[[:space:]]+create|hub[[:space:]]+(issue|pull-request|release)[[:space:]]+create)([[:space:]]|$)'
if [ -n "$NON_READER_FIRST_RE" ] && printf '%s' "$CMD" | grep -qE "$NON_READER_FIRST_RE"; then
    exit 0
fi
```

Unilateral choices:
- WHICH subcommands made the allowlist (above — too narrow? too broad?)
- ACCEPTED the chain-bypass hole: `<allowlisted>; cat /sensitive` still
  passes the exemption. Documented as a known limitation in the code.
- First-word allowlist over alternatives (G2 voices rejected
  "split-on-pipe-semicolon" as structurally fragile; shfmt-AST too heavy
  for stop-gap)

Open: missing common message-takers (`git revert -m`? `git stash push
-m`? wrapper scripts like `make commit`?)? Is the bypass acceptable for
honest agents? What's the adversarial threat model — agent typos vs
malicious commands? `git tag <name>` (no `-m`) — also exempted by the
regex's word-boundary; intentional or accident?

## B3 — dynamic bridge tool namespace in error text

Both `emit_external_block` and `emit_analysis_block` now use
`*__extract`-style suffix-only notation + ToolSearch guidance + list
both known prefixes as concrete examples (legacy
`mcp__local-mcp-toolbelt__*`, plugin
`mcp__plugin_local-mcp-toolbelt_local-mcp-toolbelt__*`).

Unilateral choices:
- LIST both known prefixes vs. fully generic
- ToolSearch as discovery mechanism (assumes the agent has it)
- Wording / order

Open: install modes I missed (custom MCP server names, alternate plugin
marketplaces, project-scope MCP)? Does listing both prefixes steer
agents toward the wrong one? Should there be an env override (e.g.
`OMCP_HOOK_BRIDGE_TOOL_PREFIX`) for sites that pin a known prefix?

## B2 — empirical threshold raise (1024 -> 4096)

Empirical data (Qwen3-4B summarize, prose, 2026-05-28):
- 1 KB → saved~=+82 tokens, ~6.5 s latency
- 4 KB → saved~=+859 tokens, ~8.3 s latency
- 8 KB → saved~=+1885 tokens, ~12 s latency

Unilateral methodology choices:
- 3 data points across one order of magnitude
- ONE content type (workplace-report-style filler prose)
- Implicit latency cost model (~50 tok/s opportunity cost)
- Picked 4096 specifically (vs 5120 / 6144 / 8192)

Open: 3 data points + one prose representative enough? Would code /
logs / JSON / structured data show a different inflection? Should the
analysis-path threshold (still 4096) also be re-examined? Is the
opportunity-cost framing right — or does latency hurt differently in
workflow than in raw tokens (e.g. user wait time, model context budget)?

## Test methodology

`.claude/hooks/test-enforce-bridge.sh` ships 12 tests. B1.4 and B2.3
use env-overrides to PROVE causality (the fix is what makes the
positive case pass — not coincidence). A4 and B3 lack such causal
reverse tests.

Open: A4 / B3 should also get causal reverse tests? Should fixtures
live in-repo (currently /tmp/b2-test scratch + reliance on
`~/.claude.json` existing > threshold)? Worth pulling in `bats` or
`shellcheck` vs bare-bash?

## Follow-up evidence memo (commit 3e7b4e4)

`bridge-hook-marker-bootstrap-evidence-2026-05-28.md` documents that
the natural `touch <marker> && <reader> <file>` one-liner fails because
PreToolUse runs before the touch can create the marker. Proposes a
1-line caveat in `emit_analysis_block`.

Open: should this batch ALSO ship the 1-line caveat (zero behavior
risk), or is the separate-memo-and-defer cadence right? Are there OTHER
similar self-bootstrap traps I haven't surfaced?

## Batch-level

- Iron rule #14: ≥2 distinct platforms for selection/scope decisions.
  Each fix's IMPLEMENTATION DETAILS were chosen single-voice (mine).
  G2 reviewed DIRECTIONS, not details. Is this acceptable here, or
  warrant rollback + redo per item with proper fan-out?
- Commit ordering (A4 → B1 → B3 → B2) — any sequencing risk?
- 4 separate `fix(hook):` commits + 1 `meta(brainstorm):` — right
  granularity?

## Output (≤500 words)

For sections you have something to say on, give: verdict + top risk +
ONE empirical test to confirm/kill it. Mark EMPIRICAL vs
CITED-UNVERIFIED. Flag where you're merely echoing this brief's
framing. Anything not listed here that you'd flag — say it.
