#!/usr/bin/env bash
# test-enforce-bridge.sh — regression tests for enforce-bridge.sh hook.
#
# Invokes the hook directly with synthesized PreToolUse JSON inputs and
# asserts exit codes. Tests live in this script (not inline at the
# agent's Bash tool) so that test commands containing reader-shape
# substrings (e.g. `$(cat <<EOF ...)`) don't trip the same hook on the
# outer invocation.
#
# Run: bash .claude/hooks/test-enforce-bridge.sh
#
# Tests are grouped by painpoint item — see
# .claude/brainstorm/helpers-tooling-painpoints-2026-05-27.md

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="${HOOK:-$SCRIPT_DIR/enforce-bridge.sh}"
export CLAUDE_PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$SCRIPT_DIR/../.." && pwd)}"

PASS=0
FAIL=0

assert_exit() {
    local name="$1" expected="$2" actual="$3"
    if [ "$actual" -eq "$expected" ]; then
        printf '  PASS  %s\n' "$name"
        PASS=$((PASS+1))
    else
        printf '  FAIL  %s -- expected exit=%d, got exit=%d\n' "$name" "$expected" "$actual"
        FAIL=$((FAIL+1))
    fi
}

# ----------- A4: agent task-output exemption ------------------------------
# Synthetic, hermetic fixtures (no machine-dependent SKIP, no tautology): both
# files are >4KB so the assertions genuinely exercise the exemption — a <4KB
# file would pass via the small-external allow-path regardless of whether A4
# fired. Sizes are verified so a failed write FAILs loudly, not passes blank.
echo "[A4 -- agent task-output exemption]"

A4_DIR="$(mktemp -d /tmp/claude-enforcetest-XXXXXX)"
A4_TASK="$A4_DIR/-Users-x-proj/sess-uuid/tasks/job1.output"
A4_CTRL_DIR="$(mktemp -d /tmp/notclaude-enforcetest-XXXXXX)"
A4_CTRL="$A4_CTRL_DIR/a/b/tasks/job1.output"
mkdir -p "$(dirname "$A4_TASK")" "$(dirname "$A4_CTRL")" 2>/dev/null
yes "task output payload line." | head -c 6000 > "$A4_TASK" 2>/dev/null
yes "task output payload line." | head -c 6000 > "$A4_CTRL" 2>/dev/null
if [ -s "$A4_TASK" ] && [ -s "$A4_CTRL" ] && [ "$(wc -c < "$A4_TASK" | tr -d '[:space:]')" -gt 4096 ]; then
    # Exempt: >4KB file under a scratch-shaped path anchored at /tmp/claude-.
    bash "$HOOK" 2>/dev/null <<JSONEOF
{"tool_name":"Read","tool_input":{"file_path":"$A4_TASK"}}
JSONEOF
    assert_exit "A4.1 >4KB task-output under /tmp/claude- is EXEMPTED (exits 0 despite >threshold)" 0 "$?"

    # Control: same size + `…/tasks/*.output` suffix but a NON-scratch root —
    # the shape the OLD front-unanchored pattern wrongly exempted (the bypass).
    bash "$HOOK" 2>/dev/null <<JSONEOF
{"tool_name":"Read","tool_input":{"file_path":"$A4_CTRL"}}
JSONEOF
    assert_exit "A4.2 >4KB task-suffix at NON-scratch root is BLOCKED (anchor closes the bypass)" 2 "$?"
else
    FAIL=$((FAIL+1)); printf '  FAIL  A4 setup -- fixtures not created >4KB\n'
fi
rm -rf "$A4_DIR" "$A4_CTRL_DIR"

# ----------- S5: Bash command scanning removed ----------------------------
# Replaces the former B1 first-word-allowlist tests. S5 (2026-05-29) dropped
# the Bash branch entirely — enforcement now lives ONLY at the structured
# Read boundary. Per the confirmed self-discipline threat model, an honest
# agent rarely raw-cats huge files, and command-string parsing was the
# dominant false-positive source (heredoc, reader-verb-tail, chaining).
echo "[S5 -- Bash command scanning removed]"

# Bash cat of an external file is NO LONGER scanned -> exits 0.
bash "$HOOK" 2>/dev/null <<'JSONEOF'
{"tool_name":"Bash","tool_input":{"command":"cat /Users/rd/.claude.json"}}
JSONEOF
assert_exit "S5.1 Bash cat external exits 0 (Bash branch removed)" 0 "$?"

# The whole git-commit-heredoc false-block class is gone by construction.
bash "$HOOK" 2>/dev/null <<'JSONEOF'
{"tool_name":"Bash","tool_input":{"command":"git commit -m \"$(cat <<EOF /Users/rd/.claude.json EOF)\""}}
JSONEOF
assert_exit "S5.2 git commit heredoc exits 0 (no Bash scanning, no false-block)" 0 "$?"

# Enforcement preserved where it's structured: Read of the SAME external
# file STILL blocks. That is the point of S5 — move enforcement off the
# leaky Bash string-scan onto the clean Read signature.
bash "$HOOK" 2>/dev/null <<'JSONEOF'
{"tool_name":"Read","tool_input":{"file_path":"/Users/rd/.claude.json"}}
JSONEOF
assert_exit "S5.3 Read same external still exits 2 (enforcement preserved on Read)" 2 "$?"

# ----------- B3: dynamic error text ---------------------------------------
echo "[B3 -- dynamic error text]"

OUT="$(bash "$HOOK" 2>&1 <<'JSONEOF'
{"tool_name":"Read","tool_input":{"file_path":"/Users/rd/.claude.json"}}
JSONEOF
)"

if printf '%s' "$OUT" | grep -q 'ToolSearch'; then
    PASS=$((PASS+1)); printf '  PASS  B3.1 block message mentions ToolSearch\n'
else
    FAIL=$((FAIL+1)); printf '  FAIL  B3.1 block message lacks ToolSearch\n'
fi

# Tightened: match a GUIDANCE line (tool-suffix followed by an arg assignment),
# not the bare substring `*__extract`, which also appears in the unrelated
# ToolSearch example line (`select:*…__extract`) and made this a weak assertion.
if printf '%s' "$OUT" | grep -qE '\*__(summarize-long|extract|classify)[[:space:]]+(source_uri|text)='; then
    PASS=$((PASS+1)); printf '  PASS  B3.2 block message shows suffix tool syntax with args\n'
else
    FAIL=$((FAIL+1)); printf '  FAIL  B3.2 block message lacks suffix tool-with-args syntax\n'
fi

if printf '%s' "$OUT" | grep -q 'plugin_local-mcp-toolbelt'; then
    PASS=$((PASS+1)); printf '  PASS  B3.3 block message includes plugin-install namespace example\n'
else
    FAIL=$((FAIL+1)); printf '  FAIL  B3.3 block message missing plugin namespace example\n'
fi

# ----------- B2: empirical threshold raise (1KB -> 4KB) -------------------
echo "[B2 -- empirical threshold raise]"

# Empirical basis (Qwen3-4B summarize on prose, measured 2026-05-28):
# saved~= tokens of +82 (1KB), +859 (4KB), +1885 (8KB). The 4KB inflection
# point makes 1KB a poor trade (high latency, low savings) and 4KB+ a clear
# win. New default external threshold is 4096 bytes (was 1024).

# Hermetic per-run fixtures (cleaned on exit); sizes verified portably with
# `wc -c` (not BSD-only `stat -f%z`), so a failed write surfaces as a loud FAIL
# rather than a fixture-missing/0-byte pass that never exercised the threshold.
B2_DIR="$(mktemp -d /tmp/b2-enforcetest-XXXXXX)"
B2_SMALL="$B2_DIR/2kb.txt"   # under 4KB
B2_BIG="$B2_DIR/8kb.txt"     # over 4KB
yes "the quick brown fox jumps over the lazy dog. " | tr -d '\n' | head -c 2048 > "$B2_SMALL" 2>/dev/null
yes "the quick brown fox jumps over the lazy dog. " | tr -d '\n' | head -c 8192 > "$B2_BIG" 2>/dev/null
B2_SMALL_SZ="$(wc -c < "$B2_SMALL" 2>/dev/null | tr -d '[:space:]')"
B2_BIG_SZ="$(wc -c < "$B2_BIG" 2>/dev/null | tr -d '[:space:]')"
if [ "${B2_SMALL_SZ:-0}" != "2048" ] || [ "${B2_BIG_SZ:-0}" != "8192" ]; then
    FAIL=$((FAIL+1))
    printf '  FAIL  B2 setup -- fixtures wrong size (small=%s want 2048, big=%s want 8192)\n' "${B2_SMALL_SZ:-0}" "${B2_BIG_SZ:-0}"
else
    # Positive: 2KB external is UNDER the 4KB threshold -> allowed.
    bash "$HOOK" 2>/dev/null <<JSONEOF
{"tool_name":"Read","tool_input":{"file_path":"$B2_SMALL"}}
JSONEOF
    assert_exit "B2.1 Read 2KB external (under 4KB threshold) exits 0" 0 "$?"

    # Reverse: 8KB external is OVER the new threshold -> blocked.
    bash "$HOOK" 2>/dev/null <<JSONEOF
{"tool_name":"Read","tool_input":{"file_path":"$B2_BIG"}}
JSONEOF
    assert_exit "B2.2 Read 8KB external (over 4KB threshold) exits 2 (still blocks)" 2 "$?"

    # Reverse: restore old 1024 threshold via env -> 2KB blocks again (pre-B2).
    OMCP_HOOK_THRESHOLD_BYTES=1024 bash "$HOOK" 2>/dev/null <<JSONEOF
{"tool_name":"Read","tool_input":{"file_path":"$B2_SMALL"}}
JSONEOF
    assert_exit "B2.3 2KB external with old 1024 threshold exits 2 (pre-B2 reproduced)" 2 "$?"
fi
rm -rf "$B2_DIR"

# ----------- T7: marker bootstrap caveat in analysis block ---------------
echo "[T7 -- marker bootstrap caveat]"

# Trigger emit_analysis_block via a project-internal data-extension (.log)
# file over the analysis threshold. The data-file band is NOT lifted by the
# edit-mode marker, so this assertion is independent of marker state.
T7_FIX="$CLAUDE_PROJECT_DIR/.t7-fixture.log"
yes "padding line to push the fixture over the analysis threshold" | head -c 5000 > "$T7_FIX"
T7_OUT="$(bash "$HOOK" 2>&1 <<JSONEOF
{"tool_name":"Read","tool_input":{"file_path":"$T7_FIX"}}
JSONEOF
)"
rm -f "$T7_FIX"
if printf '%s' "$T7_OUT" | grep -q 'OWN command first'; then
    PASS=$((PASS+1)); printf '  PASS  T7.1 analysis block documents marker-must-be-its-own-command\n'
else
    FAIL=$((FAIL+1)); printf '  FAIL  T7.1 analysis block missing marker bootstrap caveat\n'
fi

echo
echo "----- summary -----"
printf 'pass=%d fail=%d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
