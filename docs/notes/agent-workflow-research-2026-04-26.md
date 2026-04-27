# Agent workflow research — 2026-04-26 snapshot

Divergent research on **agent workflow patterns and CLI coding-agent practices**, with explicit applicability to `ollama-mcp-bridge` v0.2.0+. Compiled from four parallel research passes:

- **Pass 1 (Gemini 3.1 Pro Preview):** abstract patterns across 6 axes (cost / reliability / long-context / tool composition / memory / observability)
- **Pass 2 (Gemini 3.1 Pro Preview):** Codex / Claude Code / OpenClaw / Aider — CLI tips and limit workarounds
- **Pass 3 (Gemini 3.1 Pro Preview):** first-hand individual experience write-ups (Reddit / HN / personal blogs / podcasts)
- **Pass 4 (Copilot CLI xhigh + GitHub MCP):** GitHub repos for similar MCP servers, agent frameworks, and small mechanism libraries

> **Provenance note.** Pass 4's repo data is from live GitHub API (high fidelity). Passes 1–3 are LLM-generated summaries of what those models believe to be the literature/community state — most claims align with externally verifiable sources, but specific URLs (especially Reddit/HN/Twitter-X) in Pass 3 should be treated as "directionally accurate" rather than verbatim. **OpenClaw was independently verified** via direct GitHub fetch (365 k stars, MIT, MCP client) after I incorrectly doubted it from training-time priors.
>
> Discipline reaffirmed: in divergent research about post-training-cutoff topics, the training base is a stale sample, not an arbiter. External verification first.

---

## 1. Patterns I think the bridge should actually adopt (ranked by impact / effort)

### 1.1 P0 — Async MCP job pattern (closes the Claude Code 60 s wall)

**Source:** Pass 2 first-hand observation: "Claude Code 侧不能改超时，必须在 MCP server 端做改造——异步化"

**The idea:** The bridge accepts `summarize-long-chunked(...)` and immediately returns `{ job_id }` (well under 60 s). It then exposes a companion tool `check_job(job_id) → { status: 'running'|'done', progress, result? }`. The frontier polls every 5–10 s. Each individual MCP call stays microseconds, never trips the 60 s wall.

**Bridge fit:** This is exactly what v0.2.0 admitted in its CHANGELOG "Known limits" section as **the** structural fix. It's been in the back of our minds since the scope memo; this research confirms it's the standard-issue pattern.

**Implementation cost:** Medium. Needs an in-memory (or SQLite) job table keyed by job_id, the existing `chunkedSummarize` rewired to be invoked from a worker rather than directly from the handler, and a pruning policy (jobs expire after some TTL). Roughly comparable to v0.2.0's chunking work — call it 2–4 days.

**Recommendation:** Make this v0.3.0's anchor feature alongside the llama.cpp backend. Without it, all the chunked-summarization machinery is unreachable from Claude Code for the inputs that actually need chunking.

---

### 1.2 P0 — `CLAUDE.md` at project root (Claude Code's highest-priority context lever)

**Source:** Pass 2 ("CLAUDE.md 注入(绝对核心)") + Pass 3 (Cline Memory Bank pattern with `projectBrief.md` / `techStack.md` / `progress.md`)

**The idea:** A short (< 200 lines) Markdown file Claude Code auto-injects into every session with maximum priority. Captures project-specific norms that shouldn't have to be re-explained: "we ship as MCP server", "Tier B = qwen3:4b", "no inline text without `source_uri` warning", "tests live in `packages/core/tests/`", "migration-snapshot is the byte-identical guard".

**Bridge fit:** We don't have one yet. Adding one is ~1 hour of work and immediately raises the floor on every future Claude Code session on this project.

**Recommendation:** Do it this week, before the next implementation push. Even before async MCP.

---

### 1.3 P1 — Custom `.claude/commands/` macros for project-specific review

**Source:** Pass 3, Daniel Miessler's terminal workflow — he wrote a `/review` command that triggers a security/leak scan automatically after any core-logic change.

**The idea:** Slash commands defined under `.claude/commands/` give Claude Code project-aware review macros. For us, candidates:

- `/bridge-review` — checks: does the change preserve LlmBackend boundary? does smoke still pass? did we update the migration-snapshot?
- `/bridge-smoke` — runs the Tier-2 smoke suite and summarizes failures
- `/check-source-uri` — flags any new tool that takes only `text` without a `source_uri` alternative

**Bridge fit:** Quick wins, project-specific.

**Recommendation:** Add two or three over the next week as the workflow surfaces actual repeatable checks.

---

### 1.4 P1 — Token / context decay probes (the 🦊 emoji hack)

**Source:** Pass 3, Cursor YOLO Emoji Hack — require the model to prefix every reply with a 🦊 emoji. The moment it stops, context is degraded enough that you should `/clear`.

**The idea:** A cheap behavioral probe for context decay — instead of waiting for the model to silently drift, you have a falsifiable signal at every turn.

**Bridge fit:** Useful for **me** (Claude Code) more than for the bridge code itself. Could put a "must prefix with 🦊" note in `CLAUDE.md` for very long sessions.

**Recommendation:** Try it once on a long session and see if it actually helps. Low cost.

---

### 1.5 P2 — Semantic cache layer (GPTCache pattern)

**Source:** Pass 1 axis 1 + Pass 4 confirmed `zilliztech/GPTCache` is MIT, 23 MB, production-ready

**The idea:** Embed inputs to `classify` / `summarize` / `extract`; if a sufficiently similar prior input has a cached response, serve it without round-tripping Ollama.

**Bridge fit:** Real value for `classify` (small inputs, narrow output domain — high cache hit rate likely) and for repeat-calls during development (we run smoke many times — same inputs every time).

**Cost:** Adding an embedding-based cache means an embedding model runs on every call — that's another Ollama call each time. Net win only if the cache hit rate is high enough. Need real usage telemetry first.

**Recommendation:** Defer until we have real usage data showing the same inputs repeat.

---

### 1.6 P2 — Prompt compression (LLMLingua pattern)

**Source:** Pass 1 axis 1 + Pass 4 confirmed `microsoft/LLMLingua`, MIT, 4 MB

**The idea:** A small local model rewrites long source text into a token-dense version before sending it to the main LLM. Reported up to 20× compression.

**Bridge fit:** Could be applied **before the chunker**: the bridge receives a 100 KB document, runs LLMLingua on it locally to compress to (say) 30 KB, then chunks the compressed version. Net effect: fewer chunks, less wall time, fewer model calls.

**Cost:** Adds another model call per request (the compression step itself isn't free), and the compression model is its own dependency.

**Recommendation:** Worth a real benchmark when we hit a long-doc scenario where chunked summarization is too slow. Not blocking.

---

### 1.7 Deferred — Reflexion / experiential learning, multi-agent debate, Planner-Executor (ReWOO), MemGPT scratchpad, hierarchical RAPTOR summarization

These are real and likely useful patterns long term, but each demands enough complexity that it isn't worth picking up before the P0/P1 items deliver. They're listed in the source files; come back to them when their use case arises in real telemetry.

---

## 2. CLI coding-agent practices worth adopting personally

The user (and I, when working on this project) is one of the targets of this research, not just the bridge.

### 2.1 Claude Code (the tool we use)

- **`CLAUDE.md` at project root** — covered above.
- **`/simplify` then `/review` chain** — Claude tends to over-engineer; this combination strips defensive try/catches and abstractions.
- **`ESC ESC` / `/rewind`** — back out of a poisoned turn instead of fighting through.
- **`tsc | head -n 50` instead of full compiler dump** — pipe-and-truncate so the model doesn't drown in output. Same for `gh run view`, `pytest`, etc.
- **MCP tools should be designed for the 60 s wall** — every long task gets the async-job treatment (P0 above).

### 2.2 Aider

- **Architect / Editor split:** Claude (or another smart model) plans, a cheap local model applies the diffs. Directly supportive of the bridge's thesis.
- **Atomic Git commits per turn:** Aider auto-commits after each change. `git reset --hard` is the rollback. Reduces fear of letting the model run.
- **Manual `/add` of ≤ 3 files only:** Repo-map (ctags) handles global awareness; only-add-what-you-modify keeps tokens cheap.
- **`/run tsc` / `/run pytest`:** Aider auto-feeds the failure log back. Tighter loop than copy-paste.

### 2.3 OpenClaw (post-correction)

- **Real, MIT-licensed, 365 k stars, MCP client.** I doubted this earlier; the doubt was the hallucination, not Gemini's mention.
- **Always-on personal AI gateway** that integrates 20 + messaging apps (WhatsApp, Telegram, Slack, Discord, Signal, iMessage…), voice wake, A2UI Live Canvas, Node.js + TypeScript + Docker stack.
- **Direct relevance to bridge:** OpenClaw is an MCP client. Users who run OpenClaw can attach `ollama-mcp-bridge` as one of their tool sources, just like Claude Desktop. **This is a distribution channel.** README should mention OpenClaw alongside Claude Desktop / Cursor / Cline.
- **Open question:** Does OpenClaw's user community include people running local Ollama and would value our bridge? Worth a probe by, e.g., posting a discussion thread in the OpenClaw repo once we publish the bridge to npm.

### 2.4 GitHub Copilot CLI

- `/plan` mode for multi-file work
- `~/.copilot/copilot-instructions.md` for personal global context
- `/task` chained command that ends with self-verification
- Used today in the v0.2.0 research passes; we already saw it can either nail or miss depending on query design

### 2.5 Cursor

- `.cursorrules` as a "red-line book" — non-negotiables, not aspirational style
- ≤ 50 LOC change per turn for human-reviewability
- Manual Linter disable during big refactors so the model doesn't burn tokens fighting formatter quirks
- The 🦊 emoji probe (covered above)

---

## 3. GitHub repos worth knowing

### 3.1 Local-LLM-facing servers / hubs (potential parallels)

| Repo | Stars | What | Note |
|---|---|---|---|
| [mudler/LocalAI](https://github.com/mudler/LocalAI) | 45 k | OpenAI-compatible local-LLM gateway with built-in MCP, agents, model gallery | Heavy multi-backend scope; copy the OpenAI-compat layer idea, not the breadth |
| [nomic-ai/gpt4all](https://github.com/nomic-ai/gpt4all) | 77 k | Desktop + OpenAI-compat API + LocalDocs (local RAG) | LocalDocs RAG pattern is interesting if we ever add retrieval |
| [infinitimeless/LMStudio-MCP](https://github.com/infinitimeless/LMStudio-MCP) | ~150 | Tiny 9-tool MCP server bridging LM Studio | Great minimal MCP example; good shape reference |
| [ParisNeo/lollms_hub](https://github.com/ParisNeo/lollms_hub) | 623 | Smart router + ensemble orchestrator across Ollama / vLLM / llama.cpp | Master/slave federation pattern is interesting for v0.3.0+ multi-backend routing |

### 3.2 Agent frameworks (study, do not depend)

| Repo | Stars | Distinctive pattern | What not to copy |
|---|---|---|---|
| [microsoft/autogen](https://github.com/microsoft/autogen) | 57 k | Role-based multi-agent + structured tool interfaces | Heavy abstractions / per-service coupling |
| [langchain-ai/langgraph](https://github.com/langchain-ai/langgraph) | 30 k | Graph-based decomposition + durable execution + memory | LangChain ecosystem coupling |
| [crewAIInc/crewAI](https://github.com/crewAIInc/crewAI) | 50 k | Role-playing crews; tiny prompt + cached state per agent | Many parallel agents → orchestration overhead |
| [run-llama/llama-agents](https://github.com/run-llama/llama-agents) | 355 | Event-driven async step-based workflows | Python-only runtime weight |

### 3.3 Mechanism libraries (potential direct integration)

| Repo | License | Size | Why interesting |
|---|---|---|---|
| [microsoft/LLMLingua](https://github.com/microsoft/LLMLingua) | MIT | 4 MB | Prompt + KV cache compression; reported ~20× ratio. Python — would need a sidecar service |
| [zilliztech/GPTCache](https://github.com/zilliztech/GPTCache) | MIT | 23 MB | Production semantic cache (Redis / Milvus backends). Python; large |
| [openai/tiktoken](https://github.com/openai/tiktoken) | MIT | 129 KB | Canonical BPE tokenizer. We already use `js-tiktoken` (its pure-JS port) since v0.2.0 |
| [jd/tenacity](https://github.com/jd/tenacity) | Apache-2.0 | 711 KB | Battle-tested Python retry/backoff. Pattern is portable; we'd reimplement in TS |
| [sysid/sse-starlette](https://github.com/sysid/sse-starlette) | BSD-3 | 1.5 MB | Minimal SSE for FastAPI. If we want streaming responses (post-async-job feature?), the pattern is here |

---

## 4. First-hand experience signals (the gold)

These are claims attributed to individual practitioners. URLs are Gemini-cited and approximate; treat as directional, not citable.

### 4.1 The "annotated plan" workflow (Boris Tane, 2026)

**Claim:** Never let Claude Code "vibe-code" multi-file changes. Make it produce `plan.md` first, the human edits in human-only constraints ("don't use library X", "this part is thread-safety-critical"), then say "execute plan.md exactly, run typecheck after every step."

**Bridge applicability:** Already partially adopted via the scope-memo / Auditor flow we used for v0.2.0. Worth standardizing as `/bridge-plan` slash command.

### 4.2 Strict `/clear` discipline (HN thread, 2026 Q1)

**Claim:** When Claude/Cursor/etc. has spent >10 min on a bug without solving it, the right move is `/clear`, not "keep going". Some users wrote shell hooks that turn the prompt red when context use exceeds 60 %.

**Bridge applicability:** Discipline for me. The 🦊 probe (4.5 below) is a milder version.

### 4.3 Aider's atomic git commits (Freek, 6 months)

**Claim:** Aider's auto-commit-per-change is the underrated feature. `git reset --hard` is the 0-cost rollback. This shifts the mental model from "AI is dangerous, supervise it" to "AI is fearless, I'll just revert what I don't like."

**Bridge applicability:** Process discipline, not bridge code. But interesting in that Claude Code doesn't auto-commit — manual git after each Claude turn would replicate this safety net.

### 4.4 Cline's Memory Bank pattern (Twitter long thread, 2025–2026)

**Claim:** Three files at project root: `projectBrief.md`, `techStack.md`, `progress.md`. The model is instructed to update `progress.md` after every feature. Long-running projects get persistent memory this way.

**Bridge applicability:** We already have `docs/scope-memos/` and `docs/prior-art/` and now this `docs/notes/` — directionally aligned. Adding a top-level `progress.md` that summarizes "where v0.3.0 stands, what blockers, what's next" is a small ergonomic win.

### 4.5 The 🦊 emoji context decay probe (Cursor YOLO, 2025)

**Claim:** Tell the model to prefix every response with 🦊. The first response without the emoji is your signal that the context window is overloaded.

**Bridge applicability:** Try it. Costs nothing.

### 4.6 Boris Cherny (Claude Code lead) on parallelism

**Claim:** Cherny himself runs 10–15 parallel Claude Code sessions. Each works on a different file or test. He orchestrates by watching system notifications.

**Bridge applicability:** Not for the bridge; for me as a Claude Code user. Worth experimenting on independent tasks (e.g., writing different test files in parallel).

### 4.7 Vibe vs Agentic coding (數位關鍵字 podcast, 2026)

**Claim:** Don't use natural language for backend architecture work; use structured pseudo-code with explicit interface definitions. Save natural language for UI/visual work where vibe matters.

**Bridge applicability:** This codebase is exactly the "agentic" case. Our scope memos already lean structured; reinforces that practice.

---

## 5. Recommended next 1–3 actions

In order of leverage / per-hour value:

1. **`CLAUDE.md` at project root.** ~1 hour. Codifies bridge norms (Tier B/C, source_uri preference, migration-snapshot as guard, smoke vs unit, 60 s wall awareness). Immediate raise on every future Claude Code session quality. **Start here.**

2. **Top-level `progress.md`.** ~30 min. One-page summary of v0.3.0 plan, blockers, next milestone. Pairs naturally with `CLAUDE.md`.

3. **Write a v0.3.0 scope memo for `async MCP job` pattern + `LlamaCppBackend`.** ~3–5 days for the memo (full Prior Art Review + Auditor pass per `feature-intake-rule.md`). The two ship together because async-job is structurally what makes chunked-summarize useful for Claude Code, and `LlamaCppBackend` is the standalone parallel implementation. Implementing them separately would require two release cycles; together is cleaner.

Hold off (for now) on:

- Semantic caching, prompt compression — wait for real telemetry showing the case
- Multi-agent debate, ReWOO planner-executor, MemGPT scratchpad — wait for actual pain that justifies the complexity
- npm publish of v0.2.0 — already discussed; not yet
