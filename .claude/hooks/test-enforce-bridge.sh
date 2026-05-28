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
echo "[A4 -- agent task-output exemption]"

TASK_OUT="$(ls /private/tmp/claude-*/-Users-*-ollama-claude/*/tasks/*.output 2>/dev/null | awk 'NR==1')"
if [ -z "$TASK_OUT" ] || [ ! -f "$TASK_OUT" ]; then
    printf '  SKIP  A4 tests -- no task-output fixture present on this machine\n'
else
    bash "$HOOK" 2>/dev/null <<JSONEOF
{"tool_name":"Read","tool_input":{"file_path":"$TASK_OUT"}}
JSONEOF
    assert_exit "A4.1 Read task-output exits 0 (A4 exempts)" 0 "$?"

    bash "$HOOK" 2>/dev/null <<'JSONEOF'
{"tool_name":"Read","tool_input":{"file_path":"/Users/rd/.claude.json"}}
JSONEOF
    assert_exit "A4.2 Read external still exits 2 (reverse)" 2 "$?"
fi

# ----------- B1: first-word non-reader allowlist --------------------------
echo "[B1 -- first-word non-reader allowlist]"

# Positive: git commit with heredoc-cat + external path token in message body.
# Pre-fix: `(cat` triggered READER_RE -> path /Users/rd/.claude.json scanned
# -> external+>1KB -> blocked. With B1: first-word `git commit` allowlisted
# -> scan skipped entirely.
bash "$HOOK" 2>/dev/null <<'JSONEOF'
{"tool_name":"Bash","tool_input":{"command":"git commit -m \"$(cat <<EOF /Users/rd/.claude.json EOF)\""}}
JSONEOF
assert_exit "B1.1 git commit heredoc-cat with external path body exits 0 (B1 exempts)" 0 "$?"

# Reverse: pure reader call still blocks.
bash "$HOOK" 2>/dev/null <<'JSONEOF'
{"tool_name":"Bash","tool_input":{"command":"cat /Users/rd/.claude.json"}}
JSONEOF
assert_exit "B1.2 cat external still exits 2 (reverse: real reads still blocked)" 2 "$?"

# Reverse: git status (not in allowlist, no reader at command position) allowed.
bash "$HOOK" 2>/dev/null <<'JSONEOF'
{"tool_name":"Bash","tool_input":{"command":"git status -s"}}
JSONEOF
assert_exit "B1.3 git status (not allowlist, no reader) exits 0 (normal allow)" 0 "$?"

# Reverse: disable exemption via env -> verify pre-B1 behavior reproduces
# (i.e. with the exemption off, B1.1 must block again).
OMCP_HOOK_NON_READER_FIRST_RE='' bash "$HOOK" 2>/dev/null <<'JSONEOF'
{"tool_name":"Bash","tool_input":{"command":"git commit -m \"$(cat <<EOF /Users/rd/.claude.json EOF)\""}}
JSONEOF
assert_exit "B1.4 same case with exemption disabled exits 2 (pre-B1 reproduced)" 2 "$?"

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

if printf '%s' "$OUT" | grep -qE '\*__extract|\*__summarize-long'; then
    PASS=$((PASS+1)); printf '  PASS  B3.2 block message uses suffix-only tool syntax\n'
else
    FAIL=$((FAIL+1)); printf '  FAIL  B3.2 block message lacks suffix-only syntax\n'
fi

if printf '%s' "$OUT" | grep -q 'plugin_local-mcp-toolbelt'; then
    PASS=$((PASS+1)); printf '  PASS  B3.3 block message includes plugin-install namespace example\n'
else
    FAIL=$((FAIL+1)); printf '  FAIL  B3.3 block message missing plugin namespace example\n'
fi

# ----------- B2 -- placeholder, populated when fix lands ------------------

echo
echo "----- summary -----"
printf 'pass=%d fail=%d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
