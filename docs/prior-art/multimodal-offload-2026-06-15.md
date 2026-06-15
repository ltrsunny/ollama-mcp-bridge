# Prior Art / Intake — multimodal offload (local VLM tier)

**Status: Draft 0 (intake OPENED 2026-06-15). Not yet scope-memo'd / Auditor-passed.**

Triggered by the Auditor's question (2026-06-15): "本工具的最初目标里没有多模态的应用场景吗" — which
surfaced that the model-selection eval had **text-tunnel-vision**: it dismissed Qwen3.5's VLM nature
as "dead weight" when a VLM is actually the *enabler* of a mission-aligned NEW capability.

## 1. Problem / opportunity
The bridge's core value = keep expensive raw bytes OUT of frontier context to save tokens. **IMAGES
are the most token-expensive bytes in frontier** (one image ≈ hundreds–thousands of tokens; a
multi-page PDF / screenshot far more). The current bridge is text-only → it CANNOT offload image /
PDF / screenshot work, so those bytes hit the frontier at full cost. A local VLM tier would let the
bridge offload `extract` / `classify` / `summarize` over images/PDFs/screenshots — **the single
highest-value extension of the mission** (bigger per-call token saving than any text case).

NOT in the original goals (text-only; `docs/v0.1.2-scope.md` envisioned "summarize this PDF" but
framed it as PDF→TEXT extraction + DEFERRED; no image/vision-understanding scenario anywhere). So
this is a deliberate, mission-aligned EXPANSION — not a documented original requirement.

## 2. Engine is NOT a constraint (grounded 2026-06-15)
oMLX 0.4.3's bundled `mlx-vlm` supports ~50 VLM architectures: `qwen3_vl`, `qwen2_vl`, `glm4v`,
`minicpmv4_6`, `minicpmo`, `internvl_chat`, `gemma3`/`gemma4`, `llava`/`llava_next`, `idefics3`,
`molmo`, plus OCR-specialized (`dots_ocr`, `glm_ocr`, `deepseekocr`, `falcon_ocr`). `mlx_lm` adds
`qwen3_5` / `qwen3_vl` / `qwen2_vl`. The pinned engine can already serve VLMs — no engine change.

## 3. Model candidates (grounded HF — permissive small VLMs, ≤16 GB, CJK-capable)
- **Qwen3.5-4B-4bit** — apache, 2.9 GB, `qwen3_5`, CJK-strong. Already downloaded + smoke-confirmed
  (loads; strict-JSON binds incl. CJK with `enable_thinking=false`). **Lead candidate.**
- **MiniCPM-V-4.6-4bit** — apache, **2.0 GB** (smallest), `minicpmv4_6`; OpenBMB's renowned efficient
  CJK VLM. Strong small candidate. (NB: DISTINCT from MiniCPM3-4B, which lost the *text* CJK-classify
  bakeoff — MiniCPM-V is the separate vision line; needs its own IMAGE eval.)
- **Qwen2.5-VL-7B-Instruct-4bit** — apache, 5.3 GB, established strong VLM.
- **InternVL3-9B-4bit** — apache, 4.6 GB (1B/2B variants = license `other`); MUST verify
  `trust_remote_code` (sibling InternLM3 required it → failed to load in oMLX).
≥3 permissive candidates → model dimension satisfied. Pick by an **IMAGE-task A/B** (NOT text).

## 4. Candidate feature shape (→ scope memo)
- New multimodal capability: `extract` / `classify` / `summarize` over an image/PDF via `source_uri`
  (`file://` or `http(s)://` → image/PDF). Image flows as a base64 image-content block to oMLX's
  OpenAI-compatible chat API; **raw image bytes never enter frontier** (the whole point).
- A **VLM tier** routes image-bearing calls to the chosen VLM; text tiers stay Qwen3 (KEEP, unchanged).
- PDF: render-to-image → VLM (handles SCANNED / image PDFs the deferred text-extraction couldn't);
  or hybrid (text-extract digital PDFs, VLM for scanned/visual).

## 5. Open questions (for the scope memo + a design fanout)
- **Which VLM** (Qwen3.5-4B vs MiniCPM-V-4.6 — IMAGE-task A/B: receipt/screenshot/diagram extract +
  OCR + CJK fidelity + latency/RAM)?
- New dedicated multimodal tools vs extend existing tools to accept an image `source_uri`?
- Memory: VLM tier hot alongside text tiers on 16 GB (oMLX one-hot serialization + eviction)?
- enforce-bridge hook: gate large IMAGE reads too (route to bridge — keep image bytes out of frontier)?
- Security: image `source_uri` (SSRF for `http` — `_fetch_url`'s SSRF guard helps); image size caps;
  base64 bloat in the request to oMLX.
- Token-saving quantification (image→struct saving vs VLM load/latency cost; the 60 s MCP wall).

## 6. Process
This PA (grounded foundation) → scope memo (design + design-fanout + Auditor pass) → code. Per the
feature-intake rule. The text-tier **KEEP-Qwen3** decision (`local-model-selection-2026-05-31.md`)
is UNAFFECTED — this is purely additive (a new tier/capability, not a replacement).
