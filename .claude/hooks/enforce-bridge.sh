#!/usr/bin/env bash
# enforce-bridge.sh — PreToolUse hook that blocks direct reads of large
# files, forcing the host (Claude Code, etc.) to route through the
# local-mcp-toolbelt bridge instead.
#
# Why: the soft rule "use bridge for >1KB content" was repeatedly ignored
# in real sessions. This is the hard-enforcement layer.
#
# Scope (2026-05-29): this hook intercepts the Read tool ONLY. The Bash
# command-scanning branch was REMOVED (S5) — regex-parsing shell command
# strings is structurally unsound (heredocs, command substitution,
# quoting, chaining all defeat it) and produced frequent false-blocks.
# Per the confirmed threat model — self-discipline / token economy, NOT
# security (.claude/brainstorm/bridge-hook-threat-model-2026-05-29.md) —
# false-positives are the real cost and an honest agent rarely raw-cats
# huge files, so the Bash branch was net-negative. The Read tool has a
# clean structured `file_path` signature with no parsing ambiguity.
# Shipped to users via the local-mcp-toolbelt plugin (hooks/hooks.json).
# Knobs stay generic (env vars; no project-specific paths hard-coded).
#
# Reads hook input JSON from stdin. Exits 0 to allow, exits 2 to block
# (the host shows stderr to the model and forces it to adapt).
#
# Three enforcement bands:
#
#   1. External files (outside $CLAUDE_PROJECT_DIR + allow-listed prefixes)
#      Threshold: OMCP_HOOK_THRESHOLD_BYTES (default 4096).
#      Above the threshold → block.
#      Empirical basis for 4096 (raised from 1024 on 2026-05-28):
#      Qwen3-4B summarize on prose files yields saved~= tokens of
#      +82 at 1KB (poor trade vs ~6.5s latency), +859 at 4KB (clear
#      win, ~8s), +1885 at 8KB (large win, ~12s). Raising 1024→4096
#      stops false-blocking small external reads (~/.claude.json
#      ≈1.1KB, single-page briefs ≈2KB, agent task scratch <4KB)
#      while keeping the bridge enforced where it actually pays off.
#
#   2. Project-internal "analysis paths" (research artifacts, diagnostics,
#      design memos in non-edit phases)
#      Default paths: .claude/brainstorm .claude/diagnostics
#                     docs/notes docs/scope-memos docs/prior-art
#      Threshold: OMCP_HOOK_ANALYSIS_THRESHOLD_BYTES (default 4096).
#      Bridge-edit-mode override: when
#      `$CLAUDE_PROJECT_DIR/.claude/.bridge-edit-mode` exists AND its
#      mtime is within OMCP_HOOK_MARKER_EXPIRE_SEC (default 3600s = 60min),
#      ALL analysis prefixes are lifted for the duration of the marker.
#      Touch the marker to enter edit mode; rm to exit; or just wait
#      for auto-expiry. Renamed 2026-05-22 from `.scope-memo-edit-mode`
#      (which only stripped docs/scope-memos) after adversarial review
#      caught the partial coverage as a recurring frustration source —
#      editing brainstorm/notes/diagnostics post-compaction was blocked
#      with no in-band remediation path.
#      The marker mechanism exists because Edit's `old_string`
#      prerequisite needs byte-perfect context that bridge `extract`
#      can't always deliver from a 4B model.
#
#   3. Project-internal data files by extension
#      Default extensions: log diff jsonl ips ndjson csv
#      Threshold: same as band 2.
#
# Agent task-output exemption: paths matching the agent's own task-scratch
# pattern are exempt from all bands. These are working scratch I/O for the
# running session, not "external content to avoid" — blocking them forces
# the agent to bridge-extract its own outputs (lossy 4B paraphrase). The
# pattern is ANCHORED to the macOS scratch root (`/private/tmp/claude-…` or
# `/tmp/claude-…`): an earlier front-unanchored pattern exempted ANY path
# whose suffix merely matched `…/tasks/*.output` anywhere on disk (a bypass).
# macOS-focused — Linux/Docker are not a current target. Override or disable
# via OMCP_HOOK_TASK_OUTPUT_RE (empty string disables the exemption entirely).
#
# Source code and config inside the project (not matching bands 2 or 3)
# stay allow-listed — surgical edits still need raw bytes.
#
# Env-var configuration (all optional):
#   OMCP_HOOK_THRESHOLD_BYTES           external-file byte threshold
#   OMCP_HOOK_ANALYSIS_THRESHOLD_BYTES  internal-analysis byte threshold
#   OMCP_HOOK_ANALYSIS_PATHS            colon-separated project-relative paths
#   OMCP_HOOK_DATA_EXTENSIONS           space-separated extensions (no dot)
#   OMCP_HOOK_EXTRA_ALLOWED_PREFIXES    colon-separated absolute prefixes
#   OMCP_HOOK_TASK_OUTPUT_RE            ERE matching agent task-output paths
#                                       (empty string disables; default
#                                       matches /claude-<uid>/.../tasks/*.output)

set -euo pipefail

# ---------- configuration --------------------------------------------------
# Default raised 1024 -> 4096 on 2026-05-28 with empirical justification:
# Qwen3-4B summarize saved~= +82 tokens at 1KB (poor trade) vs +859 at
# 4KB and +1885 at 8KB. See top-of-file comment for fuller detail.
EXTERNAL_THRESHOLD="${OMCP_HOOK_THRESHOLD_BYTES:-4096}"
ANALYSIS_THRESHOLD="${OMCP_HOOK_ANALYSIS_THRESHOLD_BYTES:-4096}"

DEFAULT_ANALYSIS_PATHS=".claude/brainstorm:.claude/diagnostics:docs/notes:docs/scope-memos:docs/prior-art"
ANALYSIS_PATHS_RAW="${OMCP_HOOK_ANALYSIS_PATHS:-$DEFAULT_ANALYSIS_PATHS}"

DEFAULT_DATA_EXTS="log diff jsonl ips ndjson csv"
DATA_EXTS_RAW="${OMCP_HOOK_DATA_EXTENSIONS:-$DEFAULT_DATA_EXTS}"

EXTRA_ALLOWED_RAW="${OMCP_HOOK_EXTRA_ALLOWED_PREFIXES:-}"

# Agent task-output scratch (background-task `.output` files). Exempted from
# all bands. ANCHORED to the macOS scratch root, flexible on uid name + depth:
#   ^(/private)?/tmp/claude-<uid>/<…one or more segments…>/tasks/<id>.output
# The leading anchor closes a bypass (the old front-unanchored pattern matched
# any suffix-shaped path anywhere on disk); `claude-[^/]+` allows non-numeric
# roots (e.g. claude-mcp-browser-bridge-…); `(/[^/]+)+` lets the layout deepen.
# Disable with OMCP_HOOK_TASK_OUTPUT_RE="".
DEFAULT_TASK_OUTPUT_RE='^(/private)?/tmp/claude-[^/]+(/[^/]+)+/tasks/[^/]+\.output$'
TASK_OUTPUT_RE="${OMCP_HOOK_TASK_OUTPUT_RE-$DEFAULT_TASK_OUTPUT_RE}"

# Without a project root we can't tell internal vs external. Under-enforce
# rather than block all reads in a misconfigured shell.
if [ -z "${CLAUDE_PROJECT_DIR:-}" ]; then
  cat >/dev/null
  exit 0
fi

ALLOWED_PREFIXES=(
  "$CLAUDE_PROJECT_DIR"
  "${HOME}/.claude"
  "${HOME}/.omlx"
  "${HOME}/.config/llm-orchestration"
  "${HOME}/.local/bin"
)
if [ -n "$EXTRA_ALLOWED_RAW" ]; then
  IFS=':' read -r -a _extras <<<"$EXTRA_ALLOWED_RAW"
  for p in "${_extras[@]}"; do
    [ -n "$p" ] && ALLOWED_PREFIXES+=("$p")
  done
fi

ANALYSIS_PREFIXES=()
IFS=':' read -r -a _ap <<<"$ANALYSIS_PATHS_RAW"
for rel in "${_ap[@]}"; do
  [ -n "$rel" ] && ANALYSIS_PREFIXES+=("${CLAUDE_PROJECT_DIR}/${rel}")
done

# Marker-file override: when `.claude/.bridge-edit-mode` exists AND
# its mtime is within OMCP_HOOK_MARKER_EXPIRE_SEC (default 3600s),
# ALL analysis prefixes are stripped for the duration of the marker.
# Lets a user enter Edit-prerequisite mode for any analysis path
# (brainstorm, notes, scope-memos, diagnostics, prior-art) without
# restarting Claude Code. Touch to enter; rm to exit; or wait for
# auto-expiry. Stale markers (forgotten across sessions) self-disarm
# after the expiry window. See top-of-file comment for renaming history.
BRIDGE_EDIT_MARKER="${CLAUDE_PROJECT_DIR}/.claude/.bridge-edit-mode"
MARKER_EXPIRE_SEC="${OMCP_HOOK_MARKER_EXPIRE_SEC:-3600}"
if [ -f "$BRIDGE_EDIT_MARKER" ] && [ "${#ANALYSIS_PREFIXES[@]}" -gt 0 ]; then
  _mtime="$(stat -f%m "$BRIDGE_EDIT_MARKER" 2>/dev/null || stat -c%Y "$BRIDGE_EDIT_MARKER" 2>/dev/null || echo 0)"
  _now="$(date +%s)"
  _age=$((_now - _mtime))
  if [ "$_age" -le "$MARKER_EXPIRE_SEC" ]; then
    ANALYSIS_PREFIXES=()
    # Refresh mtime on active bypass — continuous editing keeps the marker
    # alive without re-touch, while idle markers still auto-disarm on
    # schedule (no activity → no refresh → ages out). EOD review caught
    # this as a UX cliff: a 70-min edit session would silently re-block
    # mid-flow under the original "static-mtime" design. (Claude voice,
    # 2026-05-22 EOD review Q1 — verified solid by 2-of-3 voices.)
    touch "$BRIDGE_EDIT_MARKER" 2>/dev/null || true
  fi
fi

DATA_EXT_RE=""
for ext in $DATA_EXTS_RAW; do
  [ -z "$ext" ] && continue
  if [ -z "$DATA_EXT_RE" ]; then
    DATA_EXT_RE="\\.($ext"
  else
    DATA_EXT_RE="${DATA_EXT_RE}|${ext}"
  fi
done
[ -n "$DATA_EXT_RE" ] && DATA_EXT_RE="${DATA_EXT_RE})$"

# ---------- input ----------------------------------------------------------
INPUT="$(cat)"
TOOL_NAME="$(jq -r '.tool_name // ""' <<<"$INPUT")"

# ---------- helpers --------------------------------------------------------
resolve_path() {
  local p="${1:-}"
  [ -z "$p" ] && { echo ""; return; }
  case "$p" in
    "~/"*) p="${HOME}/${p:2}" ;;
    "~"*)  p="${HOME}${p:1}" ;;
  esac
  if [ -f "$p" ]; then
    if command -v greadlink >/dev/null 2>&1; then
      greadlink -f "$p"
    else
      printf '%s\n' "$p"
    fi
  else
    echo ""
  fi
}

is_allowed_path() {
  local p="$1"
  for prefix in "${ALLOWED_PREFIXES[@]}"; do
    case "$p" in
      "${prefix}/"*|"$prefix") return 0 ;;
    esac
  done
  return 1
}

is_analysis_path() {
  local p="$1"
  [ "${#ANALYSIS_PREFIXES[@]}" -eq 0 ] && return 1
  for prefix in "${ANALYSIS_PREFIXES[@]}"; do
    case "$p" in
      "${prefix}/"*|"$prefix") return 0 ;;
    esac
  done
  return 1
}

is_data_file() {
  local p="$1"
  [ -z "$DATA_EXT_RE" ] && return 1
  printf '%s\n' "$p" | grep -qE "$DATA_EXT_RE"
}

is_agent_task_output() {
  local p="$1"
  [ -z "$TASK_OUTPUT_RE" ] && return 1
  printf '%s' "$p" | grep -qE "$TASK_OUTPUT_RE"
}

file_size() {
  stat -f%z "$1" 2>/dev/null || stat -c%s "$1" 2>/dev/null || echo 0
}

bigger_than() {
  local p="$1" threshold="$2" size
  [ -f "$p" ] || return 1
  size="$(file_size "$p")"
  [ "$size" -gt "$threshold" ]
}

emit_external_block() {
  local p="$1" size; size="$(file_size "$p")"
  cat >&2 <<EOF
[bridge enforcement — external file]
File: $p ($size bytes)
Outside the project + larger than ${EXTERNAL_THRESHOLD} bytes.

Direct read brings raw bytes into your context — defeats the bridge.
Route through the local-mcp-toolbelt bridge instead. Tool suffixes
(prepend with the current MCP namespace — see below):

  *__summarize-long   source_uri="file://$p"
  *__extract          source_uri="file://$p"  schema={...}
  *__classify         text="..."  categories=[...]

Local Qwen3 on oMLX — no frontier tokens spent on prefill of this file.

The namespace prefix varies by install mode. Use ToolSearch to find
the current one — e.g. query "select:*local-mcp-toolbelt*__extract"
or keyword "local-mcp-toolbelt". Known prefixes:
  legacy:  mcp__local-mcp-toolbelt__*
  plugin:  mcp__plugin_local-mcp-toolbelt_local-mcp-toolbelt__*

If you genuinely need raw bytes (precise edit, code surgery): the file
must be inside the project tree OR <= ${EXTERNAL_THRESHOLD} bytes.
EOF
}

emit_analysis_block() {
  local p="$1" reason="$2" size; size="$(file_size "$p")"
  cat >&2 <<EOF
[bridge enforcement — project analysis path]
File: $p ($size bytes)
Reason: $reason — larger than ${ANALYSIS_THRESHOLD} bytes.

This is research / diagnostic / bulk data content. Reading it whole
burns the same tokens whether the file lives inside or outside the
project. Use the bridge — tool suffixes (prepend with the current MCP
namespace — see below):

  *__summarize-long   source_uri="file://$p"
  *__extract          source_uri="file://$p"  schema={...}
  *__classify         text="..."  categories=[...]

The namespace prefix varies by install mode. Use ToolSearch to find
the current one — query "select:*local-mcp-toolbelt*__extract" or
keyword "local-mcp-toolbelt". Known prefixes:
  legacy:  mcp__local-mcp-toolbelt__*
  plugin:  mcp__plugin_local-mcp-toolbelt_local-mcp-toolbelt__*

Source code, configs, and small notes inside the project stay
allow-listed — only analysis-path / data-file content is enforced
here. Override per-project via OMCP_HOOK_ANALYSIS_PATHS and
OMCP_HOOK_DATA_EXTENSIONS if these defaults don't fit.

For Edit-prerequisite reads (when bridge extract's schema is too
brittle for old_string matching), lift this gate for ALL analysis
paths during an active editing session:
  touch ${CLAUDE_PROJECT_DIR}/.claude/.bridge-edit-mode
Run that as its OWN command first: this hook fires before any
&&-chained reader runs, so "touch <marker> && <reader> <file>" stays
blocked (the marker doesn't exist yet when the scan happens).
Auto-expires after ${MARKER_EXPIRE_SEC}s (override via
OMCP_HOOK_MARKER_EXPIRE_SEC). \`rm\` the marker when done — but a
forgotten marker self-disarms on schedule. (Git-ignored.)
EOF
}

# Check a fully-resolved path. Exit 2 if blocked.
check_path() {
  local p="$1"
  # A4: agent's own task-output scratch is exempt from all bands.
  # (Otherwise the agent has to bridge-extract its own outputs — lossy
  # via the 4B summarizer.)
  if is_agent_task_output "$p"; then
    return 0
  fi
  if ! is_allowed_path "$p"; then
    if bigger_than "$p" "$EXTERNAL_THRESHOLD"; then
      emit_external_block "$p"
      exit 2
    fi
    return 0
  fi
  if is_analysis_path "$p" && bigger_than "$p" "$ANALYSIS_THRESHOLD"; then
    emit_analysis_block "$p" "matches analysis-path pattern"
    exit 2
  fi
  if is_data_file "$p" && bigger_than "$p" "$ANALYSIS_THRESHOLD"; then
    emit_analysis_block "$p" "matches data-file extension"
    exit 2
  fi
  return 0
}

# ---------- dispatch -------------------------------------------------------
case "$TOOL_NAME" in
  Read)
    PATH_RAW="$(jq -r '.tool_input.file_path // ""' <<<"$INPUT")"
    PATH_ABS="$(resolve_path "$PATH_RAW")"
    [ -z "$PATH_ABS" ] && exit 0
    check_path "$PATH_ABS"
    exit 0
    ;;

  *)
    exit 0
    ;;
esac
