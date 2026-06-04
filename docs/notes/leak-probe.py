#!/usr/bin/env python3
# leak-probe.py — read-only baseline of "what bulk content reaches the frontier".
#
# Born from the C6 measure-first conclusion (docs/scope-memos/c6-composed-bridge-
# tools-2026-06-01.md): before building any offload tooling, MEASURE what actually
# leaks. Scans existing Claude Code session transcripts (.jsonl) and tallies, per
# tool-result, the chars that entered context, classified by tool + a content
# type-guess. Pure observation (no intervention) -> a non-confounded baseline.
#
# Usage:  python3 docs/notes/leak-probe.py [transcript-dir]
#   default dir = ~/.claude/projects/<cwd with "/" replaced by "-">
import json, glob, os, sys, collections, re

cwd = os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
default_tdir = os.path.expanduser("~/.claude/projects/" + cwd.replace("/", "-"))
TDIR = sys.argv[1] if len(sys.argv) > 1 else default_tdir
files = sorted(set(glob.glob(os.path.join(TDIR, "*.jsonl")) +
                   glob.glob(os.path.join(TDIR, "**/*.jsonl"), recursive=True)))

def classify(name, inp):
    inp = inp or {}
    if name == "Read":
        ext = os.path.splitext(inp.get("file_path", ""))[1].lower().lstrip(".") or "noext"
        return f"Read:{ext}"
    if name == "Bash":
        c = (inp.get("command", "") or "").strip()
        if re.search(r'\bgit\s+(--\S+\s+)*diff\b', c): return "Bash:git-diff"
        if re.search(r'\bgit\s+log\b', c): return "Bash:git-log"
        if re.search(r'\b(npm\s+(run\s+)?test|vitest|pytest|jest|go\s+test|cargo\s+test)\b', c): return "Bash:test"
        if re.search(r'\b(eslint|tsc|ruff|flake8|mypy|\bmake\b|cargo\s+build|npm\s+run\s+build)\b', c): return "Bash:lint-build"
        if re.search(r'\b(cat|head|tail|sed|awk|less)\b', c): return "Bash:file-read"
        if re.search(r'\b(grep|rg|find|fd|ls)\b', c): return "Bash:search"
        if 'fanout' in c or 'helpers.sh' in c: return "Bash:fanout"
        return "Bash:other"
    if isinstance(name, str) and "local-mcp-toolbelt" in name: return "BRIDGE(offloaded)"
    if name in ("WebFetch", "WebSearch"): return "Web"
    if name in ("Task", "Agent"): return "Subagent-result"
    if name in ("Grep", "Glob"): return "Search"
    if name in ("Edit", "Write", "MultiEdit", "NotebookEdit"): return "Edit/Write"
    if isinstance(name, str) and name.startswith("mcp__"): return "mcp-other"
    return name or "unknown"

def rlen(content):
    if isinstance(content, str): return len(content)
    if isinstance(content, list):
        t = 0
        for it in content:
            if isinstance(it, dict):
                if isinstance(it.get("text"), str): t += len(it["text"])
                else: t += len(json.dumps(it.get("content", it)))
            else: t += len(str(it))
        return t
    return len(json.dumps(content)) if content is not None else 0

bytes_by = collections.Counter(); cnt_by = collections.Counter(); big_by = collections.Counter()
biggest = []; BIG = 4096
for f in files:
    id2use = {}
    try:
        with open(f, errors="replace") as fh:
            for line in fh:
                if not line.strip(): continue
                try: e = json.loads(line)
                except Exception: continue
                msg = e.get("message") or {}; content = msg.get("content")
                if e.get("type") == "assistant" and isinstance(content, list):
                    for it in content:
                        if isinstance(it, dict) and it.get("type") == "tool_use":
                            id2use[it.get("id")] = (it.get("name"), it.get("input"))
                elif e.get("type") == "user" and isinstance(content, list):
                    for it in content:
                        if isinstance(it, dict) and it.get("type") == "tool_result":
                            name, inp = id2use.get(it.get("tool_use_id"), (None, None))
                            ln = rlen(it.get("content")); typ = classify(name, inp)
                            bytes_by[typ] += ln; cnt_by[typ] += 1
                            if ln > BIG:
                                big_by[typ] += 1
                                src = (inp or {}).get("file_path") or ((inp or {}).get("command", "")[:70] if name == "Bash" else (name or "?"))
                                biggest.append((ln, typ, src))
    except Exception: pass

total = sum(bytes_by.values()) or 1
biggest.sort(reverse=True)
print(f"dir={TDIR}\nfiles={len(files)}  total tool-result chars into frontier ~= {total:,}\n")
print("=== chars into frontier by type (sorted) ===")
for typ, b in bytes_by.most_common():
    print(f"{b:>12,} {100*b/total:5.1f}%  n={cnt_by[typ]:<5} big>4K={big_by[typ]:<5} {typ}")
print("\n=== top 18 single largest results (the concrete biggest 'leaks') ===")
for ln, typ, src in biggest[:18]:
    print(f"{ln:>10,}  {typ:<16} {src}")
