# Prior Art Review: Map-Reduce Chunked Document Summarization

**Status:** Research only, no code committed
**Date:** 2026-04-24
**Host project:** `ollama-mcp-bridge` (Node ≥ 22, TypeScript strict, Apache-2.0, local Ollama backend, 16 GB Mac, < 50 s per Ollama call, ~5 runtime deps budget)
**Target tool:** an MCP `summarize-long` (or equivalent) that ingests inputs larger than the model's effective context and returns a single coherent summary

## Why this review exists

Per the project's Feature Intake Rule, no build work begins until at least three concrete prior-art candidates are documented. This review surveys MCP-native servers, npm framework primitives, and standalone OSS implementations to decide whether to depend, port, or design clean-room.

---

## Candidates

### 1. LangChain.js — `MapReduceDocumentsChain` (via `@langchain/classic`)

| Field | Value |
|---|---|
| Repo / pkg | `@langchain/classic` on npm; source at `langchain-ai/langchainjs` |
| License | MIT |
| Last release | 1.0.31, published ~1 week ago (active) |
| Stars / signal | LangChain.js org has tens of thousands of stars; the `MapReduceDocumentsChain` itself was moved to the `classic` legacy package in the v1.0 split |
| Core deps | `@langchain/openai`, `@langchain/textsplitters`, `handlebars`, `js-yaml`, `jsonpointer`, `openapi-types`, `uuid`, `yaml`, `zod` (9 direct). Unpacked size: **5.9 MB**. Pulls `@langchain/core` (7.0 MB) transitively, plus `langsmith`, `langgraph`, `js-tiktoken` |
| Strategy | Canonical map-reduce: `combineDocsChain` runs per chunk, then a `ReduceDocumentsChain` collapses results, optionally recursively until under `tokenMax` |
| Ollama-compatible? | With adapter — needs `@langchain/ollama` (164 KB, 2 deps, MIT, active) plus `@langchain/core` |
| Chunking | Via `@langchain/textsplitters` (104 KB, MIT, depends only on `js-tiktoken`): `RecursiveCharacterTextSplitter`, `TokenTextSplitter`, language-aware variants |
| Pros | Battle-tested algorithm; well-documented; clean separation of map / reduce / collapse; recursive collapse handles arbitrarily long inputs |
| Cons | Moved out of `langchain` v1.0 into `@langchain/classic` for **backward compatibility** — actively published, not abandoned, but the v1.0 forward path is LangGraph, not chains. For a project wanting stability `classic` is acceptable; for a project likely to track new LangChain ecosystem features it's a dead-end branch. Pulling it in roughly triples our install footprint. Hard `@langchain/openai` peer dep even when only Ollama is used. **Tree-shaking caveat:** this project ships `dist/` via raw `tsc` (no bundler), so unpacked size is closer to runtime cost than in a bundled web app — tree-shaking would help a consuming app, not us |
| Verdict | **port-key-ideas** (use the algorithm; do not depend) |

### 2. LlamaIndex.TS — `SummaryIndex` + `TreeSummarize` response synthesizer

| Field | Value |
|---|---|
| Repo / pkg | `llamaindex` on npm; source at `run-llama/LlamaIndexTS` |
| License | MIT (core) |
| Last release | 0.12.1, published ~4 months ago |
| Core deps | `@llamaindex/core` 0.6.x, `@llamaindex/env`, `@llamaindex/node-parser`, `@llamaindex/workflow`, `lodash`, `magic-bytes.js` (8 direct). Unpacked size: 974 kB but transitive footprint via `@llamaindex/core` is significantly larger |
| Strategy | `TreeSummarize` is a **hierarchical / tree-style reducer**: pack chunks into LLM-context-sized batches, summarize each batch, then recursively summarize the summaries until one node remains. Closer to true tree-reduction than LangChain's flat map-reduce |
| Ollama-compatible? | **No — adapter is explicitly deprecated.** `@llamaindex/ollama` 0.1.24 package.json carries `"deprecated": "This package is deprecated and no longer maintained."` (verified by direct source fetch, not just npm UI). The missing `"license"` field is why npm renders "Proprietary" — that is an npm default for unspecified licenses, not a deliberate restriction, but the deprecation is explicit and dealbreaking on its own |
| Chunking | `SentenceSplitter`, `SentenceWindowNodeParser`, `MarkdownNodeParser`, `SemanticSplitterNodeParser` in `@llamaindex/node-parser` |
| Pros | The tree-summarize design is conceptually the cleanest fit for our use case (handles arbitrary depth, naturally parallelizable per level, predictable token budget per call) |
| Cons | Ollama adapter officially abandoned → we'd write and own the adapter; once we're writing the adapter, pulling `@llamaindex/core` + `@llamaindex/workflow` for three loops is not justified |
| Verdict | **port-key-ideas** (the tree-summarize topology) |

### 3. `mcp-long-context-reader` (yuplin2333)

| Field | Value |
|---|---|
| Repo | `github.com/yuplin2333/mcp-long-context-reader` |
| License | MIT |
| Last commit | Recent (2025), low activity |
| Stars | ~4 |
| Language | **Python** (FastMCP-based), not Node |
| Strategy | Exposes `summarize_with_map_reduce` MCP tool — divide-and-conquer parallel chunk summarization, then combine. Also offers a sequential "notes" mode for order-sensitive content, plus regex search and RAG retrieval over the same workspace |
| Ollama-compatible? | **No.** Hard-coded to OpenAI / DashScope APIs |
| Chunking | Filesystem-backed cache of chunks; details not surfaced in README — likely token-based |
| Pros | Direct evidence that the `summarize_with_map_reduce` shape *as an MCP tool* is a sensible API surface. The auxiliary "glance" tool (cheap preview before committing to full summarize) is a UX idea worth stealing |
| Cons | Wrong language (Python — cannot consume directly from a Node monorepo without an out-of-process call). Tiny star count → no community signal. Cloud-only LLM hard-coding violates our local-Ollama requirement |
| Verdict | **port-key-ideas** (MCP tool shape, "glance" preview, sequential-notes fallback for ordered docs) |

### 4. `cognitivetech/ollama-ebook-summary`

| Field | Value |
|---|---|
| Repo | `github.com/cognitivetech/ollama-ebook-summary` |
| License | Not stated in the README header (treat as **unknown / unsafe** until verified — flag to legal before any code reuse) |
| Last commit | Active, 412 commits |
| Stars | ~620 (highest community signal in this set) |
| Language | Python (88.9 %) + notebooks + shell |
| Strategy | "Ask the same questions of every part of the document" — closer to per-chunk extraction with later concatenation than true map-reduce. Targets bulleted-notes output specifically |
| Ollama-compatible? | **Yes, native.** Built around Ollama; ships fine-tuned models (`cognitivetech/obook_summary:q6_k`, `obook_title`) |
| Chunking | ~2000-token chunks (cites research on reasoning sweet spot at this size); uses ToC metadata when present for semantic boundaries; manual fallback otherwise |
| Pros | Strong empirical guidance: the **2000-token chunk size as the reasoning sweet spot** for small local models is a directly actionable design constant. Demonstrates ToC-aware chunking for structured documents |
| Cons | Wrong language. Quality depends on the specific fine-tuned models — stripping those out loses most of the value. License unclear. Output is opinionated (bulleted notes), not generic summary |
| Verdict | **port-key-ideas** (chunk-size constant, ToC-aware boundaries) |

### 5. `@langchain/textsplitters` (chunking primitive only)

| Field | Value |
|---|---|
| Pkg | `@langchain/textsplitters` |
| License | MIT |
| Last release | 1.0.1, ~5 months ago |
| Deps | 1 (`js-tiktoken`). Unpacked: **104 kB** |
| Strategy | Not a summarizer — provides `RecursiveCharacterTextSplitter`, `TokenTextSplitter`, language-aware splitters |
| Ollama-compatible? | N/A (chunker only) |
| Pros | Tiny, focused, MIT, maintained by a major org. `RecursiveCharacterTextSplitter` is the de facto standard recursive boundary-aware chunker |
| Cons | Tokenizer is OpenAI's BPE (`js-tiktoken`) — a token-count *proxy* for Ollama models, not exact. Acceptable for budgeting; not for tight bounds |
| Verdict | **integrate-as-dep** (chunking only) |

### 6. `semantic-chunking` (jparkerweb)

| Field | Value |
|---|---|
| Pkg | `semantic-chunking` |
| License | ISC (permissive — OK) |
| Last release | 2.6.0, ~2 weeks ago (very active) |
| Deps | 4 — but includes **`@huggingface/transformers`**, which pulls ONNX runtime and tokenizers (tens to hundreds of MB on disk + a model download) |
| Strategy | Embedding-based semantic chunking (Greg Kamradt method): cosine-similarity breakpoints between sentences |
| Pros | Higher-quality chunk boundaries than fixed-token windows; can improve summary coherence |
| Cons | **Violates the dependency budget** — `@huggingface/transformers` alone exceeds 100 MB transitive concern. Adds a second model-loading subsystem alongside Ollama, with cold-start cost. Embedding step also competes with Ollama for the 50 s call budget |
| Verdict | **reject** for this iteration; revisit only if summary quality from recursive-character chunking proves inadequate |

### 7. `p-limit` / `p-map` (sindresorhus) — **accepted as second new dep**

| Field | Value |
|---|---|
| Pkg | `p-limit` (with optional `p-map`) |
| License | MIT |
| Last release | p-limit 7.x; actively maintained by sindresorhus |
| Deps | Zero runtime deps (p-limit); `p-map` adds one |
| Strategy | Generic concurrency primitive — not a summarizer. Limits in-flight async calls to N |
| Pros | De facto Node standard for bounded parallelism; tiny (~50 LOC implementation); used by tens of thousands of packages — maximum community signal |
| Cons | None that matter at this scope |
| Verdict | **integrate-as-dep** — the fan-out step during the map phase needs bounded concurrency (Ollama serializes on a single Metal context, so 1–2 in flight is the limit). Writing this from scratch was a blind spot in the original review |

### 8. `@unstructured-io/client` — verified and rejected

Raised by the adversarial review as the "industry standard for ToC-aware chunking." Direct verification shows it is not in the same category as our need.

| Field | Value |
|---|---|
| Pkg | `@unstructured-io/unstructured-js-client` |
| Shape | **Cloud SDK** for the hosted Unstructured Platform API — requires an API key |
| License | MIT (for the client code) |
| Functionality | Document **parsing** only (PDF / DOCX / HTML → structured elements). Does **not** chunk, does **not** summarize |
| Verdict | **reject** — different product category (cloud document parser, not local text-splitter). Also violates "no cloud dependency" constraint. Adversarial review conflated document parsing with chunking |

### 9. `ai-jsx` (fixie-ai) — verified and rejected

Raised by the adversarial review as a "component-based third path" between clean-room and LangChain.

| Field | Value |
|---|---|
| Repo | `github.com/fixie-ai/ai-jsx` |
| License | MIT |
| Stars | ~1.1 k |
| Language | TypeScript (81 %) |
| Shape | **Full LLM application framework** using JSX components (`<Map>{chunks.map(c => <Summarize chunk={c}/>)}</Map>` style) |
| Ollama-compatible? | **Not out of the box** — the LLM adapter list mentions OpenAI / Anthropic / Llama2 / "BYOM"; Ollama is not a first-class provider. Custom adapter work required |
| Verdict | **reject** — wrong scale. We are building ONE MCP tool, not an AI application. Adopting a JSX component system to orchestrate three loops is over-architecture; and once we're writing the Ollama adapter ourselves we've already taken on most of the new-code cost while inheriting a heavy runtime |

### 10. `pi-lcm` (codexstar69) — cross-model check, rejected

Surfaced by an independent Prior Art Review run through Copilot CLI (GPT-class model, GitHub MCP built in); not surfaced by the primary review above. Verified by direct repo fetch 2026-04-24 to avoid a hallucinated recommendation.

| Field | Value |
|---|---|
| Repo | `github.com/codexstar69/pi-lcm` |
| License | MIT |
| Language | TypeScript (100 %) |
| Stars | ~7 (very low) |
| Stated purpose | "Lossless context management for Pi. Never lose a message again." — a compression layer for live conversation context, not a one-shot long-document summarizer |
| Shape | **End-user extension for the Pi platform** (`pi install npm:pi-lcm`), not an importable library |
| LLM backend | Hard-coded priority: Cerebras Zai-GLM 4.7 → Claude Haiku 4.5 → session model. **No Ollama path.** |
| Strategy | DAG-based hierarchical compaction (D0 → D1 → D2), SQLite-backed for recovery |
| Verdict | **reject** — wrong product category (live context compression, not one-shot summarization), wrong backend (cloud LLMs only), not a library, not a community-validated project |

**Why this matters for this review:** the cross-model check produced one new-seeming candidate that on verification turned out to be mis-categorized (live-context compaction vs. one-shot long-doc summarization). No signal to revise the recommendation below.

---

## Comparison and recommendation

The candidates split cleanly into three groups.

**Frameworks (LangChain.js, LlamaIndex.TS)** offer the algorithm we need, but each costs us our entire dependency budget for what is fundamentally a 200-line problem: split, fan-out summarize, reduce, optionally recurse. LangChain's `MapReduceDocumentsChain` lives in `@langchain/classic` — explicitly the **legacy** v0.x bucket — and the upstream pivot to LangGraph means a depend-now choice locks us to a deprecating API. LlamaIndex's `TreeSummarize` is conceptually superior (true hierarchical reduction beats flat map-reduce for very long inputs) but its Ollama adapter `@llamaindex/ollama` is **deprecated and proprietary-licensed**, which is a hard stop. Neither framework justifies the install footprint when we already have the `ollama` SDK as a direct dep.

**MCP-native prior art (`mcp-long-context-reader`, `mcp-summarizer`)** confirms the API shape but offers no reusable code — both are Python, and `mcp-summarizer` doesn't actually chunk (it leans on Gemini's 1M-token window). They validate the user-facing tool design, nothing more.

**Ollama-native prior art (`ollama-ebook-summary`)** is the strongest source of empirical defaults — particularly the 2000-token chunk sweet spot for small local models, which we should adopt unless our own benchmarking contradicts it.

**Recommendation: build clean-room, with `@langchain/textsplitters` + `p-limit` as new dependencies.** Implement a small in-house pipeline (chunk → parallel-with-cap map → recursive reduce) using the existing `ollama` client. Borrow the **tree-reduce topology from LlamaIndex**, the **2000-token chunk size from cognitivetech**, the **map-reduce algorithm from LangChain**, and the **`glance` preview tool from `mcp-long-context-reader`**. Total new transitive footprint: ~100 kB (`@langchain/textsplitters` + `js-tiktoken`) plus trivial `p-limit`.

> **Adversarial-review note:** an independent critique (Gemini 2.5 Pro) challenged three claims: (a) the "Proprietary license" on `@llamaindex/ollama` is an npm default for packages missing a `license` field, not a deliberate restriction — correct observation, but the package-level `deprecated` field stands as the real reason (verified against the GitHub source `package.json`); (b) "legacy" does not mean "avoid" for `@langchain/classic` — fair, and re-framed above; (c) tree-shaking may reduce LangChain's effective runtime cost — fair in a bundled deployment, but this project ships raw `tsc` output without a bundler, so unpacked size remains a close proxy for installed cost. Two further candidates raised (`ai-jsx`, `@unstructured-io/client`) were verified against source and both failed a fit check (see candidates 8, 9). The critique's best catch was `p-limit` / `p-map`, now promoted to candidate 7 and accepted as the second new dep.

**Implementation scope (revised upward, per adversarial review):** ~250–500 LOC of orchestration including explicit timeout-budget accounting, partial-result return-on-timeout, reduce-prompt deduplication, provenance propagation, and error-path handling. The naïve "~150–250 LOC" estimate in an earlier draft under-counted the edge cases. Still a straightforward project, still inside the project's complexity budget, but not a weekend script.

---

## Gaps not covered by any candidate

1. **MCP-client request-timeout discipline.** None of the surveyed projects model the constraint that *each individual* model call must finish in < 50 s. Map-reduce frameworks assume the orchestrator can run indefinitely. We need explicit per-call token budgets sized so a 16 GB Mac running a quantized model finishes inside the window — and a fan-out concurrency cap (likely 1–2) because Ollama serializes requests on a single GPU/Metal context anyway.

2. **Progressive output / partial results on timeout.** No candidate exposes a "return what you have so far" path. For an MCP tool, returning a degraded but useful summary on partial timeout beats a hard error.

3. **Tokenizer fidelity for Ollama models.** Every TS chunker we found uses `js-tiktoken` (OpenAI BPE) as a proxy. For Llama / Qwen / Gemma tokenizers the count drifts. We will need a safety margin (suggest reserving 15–20 % of the model's `num_ctx`) rather than chasing an exact tokenizer per model.

4. **Coherence / dedup at the reduce step.** Map-reduce naively concatenates chunk summaries; the reduce LLM call must be prompted to deduplicate and order. None of the surveyed implementations document a strong reduce prompt — this is a prompt-engineering task we own.

5. **Source-URI / provenance pass-through.** The bridge already supports `source_uri` (per recent v0.1.2 work). The summarize tool should preserve and carry through any chunk-level provenance — no candidate handles this.

6. **Eviction / streaming for inputs that exceed even the reduce step.** True hierarchical reduction (LlamaIndex topology) handles this; flat map-reduce (LangChain) requires recursive collapse. Our implementation should default to recursive collapse to avoid a hard upper bound on input size.

**Implementation scope implied:** 1 chunker integration (`@langchain/textsplitters`) + 1 concurrency primitive (`p-limit`) + ~250–500 LOC of orchestration covering map / reduce / recursive-collapse / timeout budget / partial-result-on-timeout / provenance pass-through + 3 prompts (map, reduce, optional final-polish) + tests. No new heavy deps. Aligns with existing tier-C tool conventions in this repo.

---

## Provenance

This review was produced by two independent passes:

1. **Primary pass** — general-purpose research agent (Claude / sonnet class), scanning npm / GitHub / MCP directories / awesome-mcp-servers.
2. **Cross-model check** — GitHub Copilot CLI (`copilot -p …`, v1.0.36, GPT-class model with GitHub MCP built in) run in parallel with an equivalent prompt.
3. **Adversarial review** — Gemini 2.5 Pro (`gemini -m gemini-2.5-pro -p …`) fed the draft document and asked to tear it apart: missing candidates, factual challenges, framing holes, plus a single confidence number on the clean-room recommendation.

Passes 1 and 2 produced overlapping recommendations on the major frameworks and disagreed on one candidate: Copilot surfaced `pi-lcm`, which on manual verification proved to be mis-categorized (live-context compaction, not one-shot summarization) and was rejected — see candidate #10. Pass 3 raised three factual challenges (verified against source — two affirmed the document's conclusion with corrected reasoning, one promoted `p-limit` to an accepted second dep) and two candidate additions (`ai-jsx`, `@unstructured-io/client`) which both failed a fit check on verification. Pass-3 confidence on the clean-room recommendation: 0.65 ("likely correct, but for better reasons than the original draft gave"). The corrections above raise that number but cannot be independently re-scored without another critique round.
