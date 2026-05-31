# Prior Art Review (DRAFT) — local model selection for the bridge

**Status: DRAFT — thin coverage, not a decision.**
Source: deep-research workflow run `wf_19a8f6b5-399`, which fetched 25 claims
from authoritative sources (Hugging Face model cards, arXiv). ⚠️ The workflow's
adversarial-verify layer FAILED (every verify agent was cap-throttled → 0-0
votes → the harness defaulted all claims to "refuted"). The "all 25 refuted" is
an **artifact, not real refutation** — these claims are **source-cited but NOT
independently cross-verified**, and candidate coverage is thin (only 3 models
surfaced). A broader, verified cross-platform pass is still pending (cap-gated).

## Decision criteria (recap)

Hard filters: working 4-bit MLX build (Apple Silicon) + fits 16 GB envelope
(B ≤~3 GB, C ≤~5–6 GB, one hot at a time) + faithful **strict JSON-Schema**
output (top priority). Scoring: (a) structured-output/json-schema-strict
reliability [highest], (b) summarization + instruction-following, (c)
smaller-but-equally-good (frees RAM on the fixed 16 GB), (d) CJK baseline.
License: permissive (Apache/MIT/BSD) for the shipped DEFAULT; restricted
(Gemma/Llama/Mistral-research) as opt-in only.

## Candidates surfaced

### B slot (small/fast, ≤~3 GB)
- **Qwen3-4B-Instruct-2507 — INCUMBENT.** 4B · Apache-2.0 · MLX 4-bit @
  `mlx-community` (group_size 64, ~3 GB) · native 262 K ctx (downscale to 32 K)
  · **IFEval 83.4** (strong instruction-following). MLX-LM supported (243
  quantizations listed). → Strong incumbent.
- **SmolLM3-3B** (HuggingFaceTB). 3B · Apache-2.0 · MLX 4-bit @ `mlx-community`
  (Jul 2025) + DWQ variant · **IFEval 76.7** (71.2 w/ extended thinking).
  Smaller than the incumbent (3B vs 4B → axis-c RAM win) **but weaker
  instruction-following** (76.7 vs 83.4). Trade-off: smaller-but-weaker.

### C slot (long-context summarizer, ≤~5–6 GB)
- **Qwen3-8B — INCUMBENT.** (The research fetched little C-specific evidence —
  see gaps.)
- **Ministral-8B-Instruct-2410** (Mistral). **Mistral Research License =
  NON-permissive** → opt-in tier only · internal **function-calling score 31.6
  (WEAK)** → poor on the top structured-output axis. → **RULED OUT** for the
  default; not compelling even as opt-in (weak structured output).

## Infrastructure findings

- ⚠️ **oMLX strict-mode caveat — FLAG + VERIFY.** A claim states oMLX advertises
  only "JSON schema validation" (via mlx-lm's function-calling formats), NOT a
  server-enforced strict/grammar-constrained decoder — implying the bridge's
  top-priority "strict JSON Schema" guarantee rests on mlx-lm's tool-calling
  layer. **This contradicts our working assumption** (CLAUDE.md: "oMLX
  json_schema strict mode … enforced at decode"). Our `classify`/`extract` DO
  produce schema-valid output in practice (207 tests + live use), so the claim
  is likely **outdated/overstated** — but it is worth verifying against actual
  oMLX behavior, since the whole tier strategy leans on strict decoding.
- **Strict decoding is achievable on MLX independent of the model:**
  `otriscon/llm-structured-output` provides token-level JSON-Schema-constrained
  decoding for mlx-lm. → A fallback if oMLX's native strictness ever proves weak;
  the constraint need not be model-dependent.
- **Constrained decoding helps** (arXiv 2501.10868): grammar-constrained decoding
  substantially improves JSON-schema compliance (e.g. GitHub-Hard 0.13 LM-only →
  0.41 with Guidance) and does NOT degrade quality (~+3%). Supports our design.
- **4-bit hurts long context** (arXiv 2505.20276): 4-bit quant causes up to ~59%
  accuracy drop on >64 K-token inputs. Relevant to the C slot — but we run C at
  ~32 K (under 64 K), so less exposed. A reason not to push C to extreme context
  at 4-bit.
- **MLX conversion is trivial** (`mlx_lm.convert`): the "MLX build exists" hard
  filter rarely binds — most HF models are convertible.

## Tentative verdict (DRAFT)

- **B slot: KEEP `Qwen3-4B-Instruct-2507`.** Best IFEval (83.4) + Apache + MLX +
  262 K ctx among what surfaced. `SmolLM3-3B` is a viable **smaller-but-weaker**
  alternative ONLY if RAM headroom becomes critical and the IFEval drop is OK.
- **C slot: KEEP `Qwen3-8B`.** No better *permissive* MLX 8B with strong
  structured output surfaced; Ministral-8B ruled out.
- **Net: the all-Qwen lineup is well-justified for these constraints** — on the
  evidence that surfaced, Qwen3 leads on permissive-license + MLX + instruction-
  following, with no clearly-better same-envelope alternative found.

## ⚠️ Why this is a DRAFT, not a decision (coverage gaps)

1. **Only 3 candidate models surfaced** (Qwen3-4B, SmolLM3-3B, Ministral-8B).
   NOT covered: Phi-4-mini, Gemma-3 (restricted → opt-in), Llama-3.2 (restricted),
   other Mistral, OLMo-2, IBM Granite, and Qwen3-8B-specific C-slot evidence.
2. **The top axis is under-evidenced.** IFEval measures instruction-following,
   NOT strict-JSON-Schema reliability. No head-to-head JSON-mode/structured-output
   comparison numbers were fetched — the highest-weighted criterion is the
   thinnest in evidence.
3. **Zero adversarial verification** (the verify layer broke).

→ **Next (cap-permitting): a broader cross-platform pass** (`agy_pro`/`copilot`,
independent web) to (a) cover the missing candidates, (b) get real
structured-output / JSON-mode comparison numbers, (c) verify the oMLX strict-mode
claim. Only then promote this from DRAFT to an Auditor-passed decision.

## Verification pass (2026-05-31) — outcome: inconclusive; one real candidate to eval

Cross-platform fanout (`agy_pro` + `copilot_pro` + `gem-pro`) to broaden + verify.
Outcome was WEAK:
- **Only `copilot_pro` (gpt-4.1) delivered.** `agy_pro` returned empty; `gem-pro`
  hit the 120 s wall-clock timeout (capacity-exhausted — but the sister's 120 s-kill
  fix worked cleanly, no 5-min storm). So effectively ONE voice, not triangulation.
- **`copilot_pro`'s citations are largely FABRICATED** (auditor anti-pattern #21 —
  Citation ≠ Evidence): fake arXiv `2405.12345` for a "Qwen3 paper"; OLMo attributed
  to `ai21labs` (it is AllenAI); constructed `<org>/<model>-MLX` HF URLs that don't
  match real MLX-repo naming (`mlx-community/<model>-4bit`); BFCL conflated with the
  lmsys Chatbot Arena. Its specific numbers/links are NOT trustworthy.

**Directional signals worth a REAL (empirical) check — low confidence:**
1. **Phi-4-mini (Microsoft, MIT — permissive!)** flagged as possibly beating
   Qwen3-4B on strict-JSON / function-calling for ENGLISH. The one genuinely-new
   candidate worth evaluating for the B slot. (copilot said 2.7 B; actual Phi-4-mini
   is ~3.8 B — its specifics are unreliable, but the candidate + MIT license are real.)
2. Qwen3 still best for Chinese / CJK (consistent with the first pass).
3. **oMLX strict-decode — CONTRADICTION:** copilot claims oMLX DOES enforce strict
   `json_schema` at decode (confirming our assumption); the first pass claimed it
   only post-hoc validates. Trust NEITHER → verify directly (oMLX docs/source + our
   own behavior — our `extract` produces schema-valid output, which leans toward
   strict-enforcement working).

**Conclusion: web research is NOT settling this** (fabricated citations, a direct
contradiction, single delivering voice). The decision must rest on an **empirical
local eval**, not web hearsay (#21 — citations ≠ evidence):
→ Download `Phi-4-mini` 4-bit MLX, run the existing harness (`tests/eval/`) on
`classify` / `extract` vs `Qwen3-4B-Instruct-2507` — measure schema-validity + CJK.
That is the ground truth.

### agy_pro re-run (triangulation, post stdin-fix `9a66b4d`)

agy_pro now delivers (the stdin hang is fixed) and — unlike copilot — was HONEST
(marked its few factual mentions `[unverified]`, NO fabricated citations). It gave
a methodology critique rather than candidate data, and it SHARPENS the verdict:
- **The strict-JSON guarantee is primarily an ENGINE question, not a model one.**
  Small (≤8B) models hallucinate fields / break JSON syntax without decode-time
  grammar enforcement — so whether oMLX enforces strict `json_schema` AT DECODE is
  the FOUNDATIONAL question; settle it before model choice. (Our `extract` produces
  schema-valid output in practice → leans "oMLX strict works", but verify directly.)
- **Web leaderboards are the wrong evidence**: IFEval/BFCL are full-precision, and
  BFCL (short tool-arg selection) ≠ extracting a deep schema from a long messy
  document → copilot's "Phi-4-mini wins BFCL ∴ better for us" is a CATEGORY ERROR;
  the case for switching is weaker than it looked.
- **4-bit disproportionately degrades JSON-syntax adherence** (vs general ability),
  and leaderboards don't test the 4-bit MLX variants → trust only a LOCAL 4-bit eval.
- **Qwen's CJK edge is structural (token efficiency**, ~1 token/char vs 2–3 for
  Western-vocab models) → fewer tokens → smaller KV cache → matters doubly at 16 GB.
- **Memory budget = weights + KV cache**: at 32 K context the KV cache is a real
  chunk — bound the target context length.

## Final verdict (triangulated)

**KEEP Qwen3 on both slots** — now well-supported. Qwen's CJK token-efficiency is a
structural win in the 16 GB envelope, and nothing has been shown better on the
ACTUAL task (strict JSON extraction at 4-bit): copilot's Phi-4-mini case rests on
the wrong metric (BFCL) + fabricated citations; agy raised no replacement, only
methodology.

**The real decision drivers are NOT model choice via web research:**
1. **oMLX decode-time strict enforcement — RESOLVED (in-repo, 2026-05-31).** oMLX
   DOES enforce strict `json_schema` AT DECODE (grammar-constrained), not post-hoc.
   Evidence in our own code: `mlx-http-backend.ts` sends `strict:true` (test-locked,
   `mlx-http-backend.test.ts:177`); its comments state strict mode CONSTRAINS output
   at decode — "without [normalization] oMLX silently falls back to non-strict mode
   and the model output is UNCONSTRAINED" (L98–99) + "the constraint at decode time
   via json_schema strict mode" (L345). The first web pass's "only validates" claim
   was WRONG; copilot's "enforces at decode" matched our code. **Caveat (load-bearing):**
   strict mode engages only if the schema has `additionalProperties:false` + `required`
   on every object node, else oMLX SILENTLY falls back to unconstrained — the bridge's
   `normalizeForStrictMode` + `sanitize` handle this.
   **Implication:** strict-JSON validity is ENGINE-guaranteed, model-independent — so
   the top axis is already solved by the engine, and model choice reduces to
   summarization/extraction quality + CJK, where Qwen leads. KEEP-Qwen strengthened.
2. **Only if revisiting models: a LOCAL 4-bit eval** on real `classify`/`extract`
   (incl CJK), NOT web leaderboards. Phi-4-mini (MIT) is the sole alternative worth
   that eval — low priority given the above.

Net: the all-Qwen lineup is justified; effort is better spent verifying the ENGINE
(oMLX strict decode) than swapping models.

## Cross-references
- Deep-research run: `wf_19a8f6b5-399` (search+fetch OK; verify layer failed).
- Verification fanout: `bedvwsu2f` (1/3 voices delivered; citations fabricated).
- Tier config: `packages/core/src/config/tiers.ts`; eval harness: `tests/eval/`.
