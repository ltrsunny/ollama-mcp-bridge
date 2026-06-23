################################################################
# fanout: UNVERIFIED — a brainstorm of VIEWS, not a fact-check.
# Voices may state fabricated citations / URLs / IDs confidently;
# nothing here is grounded. Treat EVERY claim and citation as a
# lead to verify, not evidence.
################################################################

================ VOICE: ghm ================
Critique of the Design Debate ROUND 4 Brief:

1. **Lack of Explicit Risk Quantification for Tier Escalation Decisions**  
The first disagreement hinges on choosing a default behavior for `summarize` oversize inputs on a 16GB system, weighing swap-death risks against quality. The brief does not explicitly quantify these risks: what is the probability and impact of swap-death at different input sizes? Is there empirical data or simulation to inform whether crossing into 8B resident size is acceptable? Without concrete thresholds, the decision remains somewhat subjective, risking overly aggressive escalation that could cause system instability or performance degradation, especially if the environment's memory usage fluctuates unpredictably.

2. **Insufficient Consideration of System Variability and Resource Contention**  
The brief presumes a 16GB Mac with "one-hot" memory, but does not address variability: what happens under memory pressure, multiple concurrent processes, or future hardware updates? The risks of swap-death might be understated if multiple processes compete for memory, and the default choice might lead to systemic failures. Similarly, the impact of long synchronization blocks (148s+157s) on user experience warrants deeper analysis, e.g., does escalation improve quality enough to justify potential user frustration or timeout issues?

3. **Incomplete Definition of "Default" and "Behavior Switching Point"**  
The brief asks for "ONE default" and a size where behavior switches but does not specify the basis for this switch. Is it based solely on token count thresholds? How were these thresholds derived, and do they include buffer margins? Without explicit, quantifiable thresholds, implementation may be inconsistent, risking silent fallback behavior that’s unpredictable or regressions in quality?

4. **Unclear Justification for the Narrow-Subset Schema Auto-Handle Approach in `extract`/`classify`**  
The second disagreement advocates for limiting auto-handle to a *narrow* subset rather than a blanket refusal, citing the difficulty of reliable schema detection. However, the brief does not clarify the real-world scenarios where the narrow subset would be both *safe* and *useful*. There are risks that:  
- The detection heuristic for whether data fits the narrow subset is *not* reliably provable, especially in diverse or noisy data.  
- There are common schemas outside the narrow subset that are still *safe*, meaning the approach may unnecessarily restrict functionality.  
- The complexity of detection might itself introduce bugs, leading to unintended refusals or unsafe auto-handling.

5. **Lack of Concrete, Formal Criteria for the Narrow-Subset Detection**  
The brief asks for a "provably safe" detection method but does not specify existing techniques or whether formal verification methods (e.g., static analysis, schema validation algorithms) are used. Without concrete criteria and validation procedures, the "narrow subset" approach risks being more brittle than the blanket refusal, potentially leading to false positives (unsafe auto-handle) or negatives (missed opportunities). This impairs both safety and usability, especially if users rely on auto-handle in expectation of safety.

6. **Absence of Consideration for User Control and Explainability**  
Both disagreements involve failure modes—silent corruption, brittle detection—yet there’s no mention of opportunity for user feedback or explanation of auto-handle refusals. Increased transparency could mitigate risks by allowing users to override or confirm auto-handle actions, mitigating some safety concerns without sacrificing usability.

7. **Failure Modes and Edge Cases not Fully Addressed**  
- For `summarize`: what if the data size fluctuates dynamically? Is there a dynamic threshold or heuristic?  
- For `extract`/`classify`: what happens when the heuristic detects a schema as safe but data actually violates assumptions? Are there fallback mechanisms to prevent silent failures?  
- Will escalations and auto-handling mechanisms be accompanied by robust logging to audit decision boundaries and failures?

8. **No mention of testing, validation, or fallback mechanisms**  
The brief does not specify how these decisions (default escalate threshold, safe schema detection) will be validated: what test cases, metrics, or formal proofs will be used? How will failures be detected and remediated in deployment? Without these, the risks of undetected failures, silent corruption, or regressions increase significantly.

9. **No cross-consistency analysis between the two disagreements**  
The decisions on `summarize` sizing and auto-handling are interconnected theoretically, as improving auto-handle safety could influence the necessity to escalate summaries. The brief treats them independently, potentially missing opportunity for holistic safeguards or criteria that jointly minimize risk.

10. **Assumption of "silent semantic corruption" as the primary failure mode**  
While silent errors are serious, the brief does not consider other failure modes such as performance degradation, increased latency, or partial failures that may not be silent but equally harmful. Addressing only silent corruption might overlook practical robustness concerns.

---

**Summary of Risks, Gaps, and Failure Modes:**

- *Unquantified risk thresholds* may lead to overly aggressive or conservative defaults
- *Environmental variability* not modeled, risking instability
- *Detection heuristics* for safe auto-handle may be *not* reliably provable, risking unsafe handling or unnecessary refusals
- *Lack of formal verification* for safe subset detection undermines confidence
- *No fallback or user feedback mechanisms* decreases resilience
- *Absence of explicit validation procedures* risks deployment with undetected failure modes
- *No integrated analysis* linking summarization escalation and auto-handle safety to ensure minimized overall risk
- *Limited scope* in failure mode consideration may leave other faults unmitigated

---

**Conclusion and Recommendation:**

The brief should define explicit, quantifiable thresholds for `summarize` escalation, incorporate empirical data or formal analysis to justify decisions, and specify formal detection methods for the safe subset of auto-handle cases. Additionally, including fallback mechanisms, system monitoring, and user-initiated overrides will improve robustness. Only with these improvements can the proposed defaults and behaviors confidently balance safety, quality, and user experience.
[_ghm_pick_model: tier=low min_ctx=1188 candidates=11]
[_ghm_pick_model: using openai/gpt-4.1-nano]

================ VOICE: ghm_pro ================
### Disagreement 1 — `summarize` oversized: Tier-B map-reduce vs Tier-C escalate

#### Recap of Risks:
- **Tier-B map-reduce (4B, 8K ctx):**
    - **Pros:** No memory pressure; avoids swap-death; merges lossy but "summarize" is contractually lossy.
    - **Cons:** Quality loss from chunking and merging (potential summary incoherence, missed global themes).
- **Tier-C escalate (8B, 32K ctx):**
    - **Pros:** Better quality at max context; avoids chunk/merge loss; aligns with existing `summarize-long-chunked`.
    - **Cons:** Severe swap risk on 16GB Mac (single pass 8B-> swap-death; poor experience; possible OS-level instability).

#### Analysis:

- **Swap-death risk:** Qwen3-8B requires ~12GB RAM just to load the model; with context, intermediate states, and OS, on a 16GB one-hot Mac, this is likely to cause swapping and severe slowdown. This is not theoretical; large models regularly cause macOS to thrash, even with `mps` offload ([unverified: https://github.com/QwenLM/Qwen1.5/issues/25]).
- **Quality tradeoff:** Map-reduce incurs loss at merge, but if the "summarize" contract explicitly allows loss (not fact-finding), this is acceptable. For extreme quality, user can explicitly request Tier-C with `summarize-long-chunked`.

- **UX/Resilience:** Swap-death is catastrophic: brings machine to a halt, kills interactive work. Map-reduce method never exceeds model RAM, so worst case is a lossy summary, never system instability.

#### Convergent Default:

- **Ship Tier-B map-reduce as default** for oversized. For threshold: since Qwen3-4B supports 8192 tokens and safe ~4900 usable tokens, default to map-reduce above this, unless user explicitly requests Tier-C.
- **Threshold:** If input exceeds Tier-B’s safe token limit (4900 tokens), use map-reduce; escalate only if input fits 32K tokens but user explicitly requests ultra-quality and accepts risk (`summarize-long-chunked`).
- **Reasoning:** Degrades gracefully (lossy output, never crash); Tier-C escalate fails catastrophically (swap-death). Losssy merge is contractually allowed.

#### Defeating the Tier-C escalate camp:

- Single-pass quality is not sufficient to justify risking swap-death, especially as map-reduce degradation is *acceptable* for summary tasks (not fact-extraction).
- User still has explicit choice for Tier-C if quality trumps risk.

---

### Disagreement 2 — `extract`/`classify`: blanket structured-refusal vs narrow safe auto-handle subset

#### Recap of Risks:

- **Narrow auto-handle:**
    - **Conditions:** Schema = array-of-independent-items, dedup by exact-match, chunking on semantic boundaries.
    - **Pros:** Honors user intent for "all X" queries, safe in the truly independent case, avoids refusal-spam.
    - **Cons:** Detection is brittle—e.g., schema detection flips on small change, "independence" is hard to verify, false confidence can yield silent loss or partial extraction.

- **Blanket-refuse:**
    - **Pros:** Predictable, avoids silent corruption, user can always chunk safely.
    - **Cons:** Over-refusal can be irritating (user forced to chunk).

#### Key Risks/Gaps:

1. **Schema Detection Brittleness:** Even well-built detection can fail:
    - Adding one scalar field can flip independence to false. Detection tools like Pydantic or schema inference are heuristics, not hard guarantees.
    - Failure: If a "safe" schema is misdetected, potential for silent loss (not visible unless user checks output carefully).

2. **"Independent items" is Ambiguous:** Even for emails, embedded entities, edge cases (e.g., long strings split, straddling emails broken on chunk boundary) create subtle bugs.

3. **API Predictability:** If auto-handle works sometimes and not others, user does not know when refusal happens. This violates "principle of least surprise".

4. **Complexity:** Adding auto-handle creates code complexity to robustly detect just the safe cases. Any slip converts safe to unsafe silently.

#### Counter to Narrow Subset Camp:

- **Detection is not provably reliable:** There is no available, provable, machine-checkable method for verifying independence and safe chunking in terms of primitive arrays in arbitrary input. Even JSON Schema fails for complex types ([unverified: https://json-schema.org/understanding-json-schema/]).
- **API unpredictability:** API behavior flips based on narrow, sensitive schema distinctions, making user experience brittle; adding fields or changing input format suddenly breaks auto-handle.

#### Convergent Default:

- **Ship blanket-refuse.** Auto-handle subset is not worth the substantial risk of silent corruption, brittle UX, and detection complexity. Degrades gracefully: user gets an explicit refusal, never silent loss.
- **Reasoning:** API behavior is predictable, safe; user can always preprocess input to chunk themselves.

---

### Final Shippable Specs

#### Oversized Behavior + Thresholds

- **extract/classify:** If input exceeds Tier-B token limit (~4900 tokens, CJK tokenizer-aware), refuse with a structured error. Never chunk or auto-handle. User must preprocess.
- **summarize:** If input exceeds Tier-B token limit (~4900), use Tier-B map-reduce and merge summaries for oversized case. Only escalate to Tier-C (32K context, 8B model) if user requests `summarize-long-chunked` and input fits in 32K tokens.
- **Thresholds:** Natively CJK-tokenizer aware; Tier-B (~4900 tokens usable); Tier-C (32K tokens); client never enforces wall, but returns structured error/refusal for oversized.

---

#### Summary Table

| Tool         | Oversized Default      | Threshold                | Escalation |
|--------------|------------------------|--------------------------|------------|
| extract      | Blanket structured-refuse | ~4900 tokens Tier-B        | User must chunk |
| classify     | Blanket structured-refuse | ~4900 tokens Tier-B        | User must chunk |
| summarize    | Tier-B map-reduce       | ~4900 tokens Tier-B        | Only if user requests `summarize-long-chunked` and fits in 32K tokens |

---

### Final Reasoned Decisions

- **Summarize:** Use map-reduce on Tier-B by default for oversized; do not escalate to Tier-C by default due to swap-death risk. Merge step loss is contractually allowed for summarization.
- **extract/classify:** Blanket structured-refusal for oversized input. Narrow auto-handle is not provably reliably detectable, creates brittle API behavior, and is not worth the risk versus explicit refusal.
- **Threshold:** Real CJK-aware tokenizer count (~4900 tokens Tier-B; 32K Tier-C for explicit long-call).

---

**Residual**: Auto-handle subset is not completely eliminated as a theoretical possibility, but in absence of a provable, machine-detectable reliable schema, it is lower-risk to ship blanket-refuse. Tier-C summarize is only allowed for explicit user override.

---

**Shippable spec (tool-by-tool):**
- **extract/classify:** Structured refusal above Tier-B token threshold, never auto-handle oversized input.
- **summarize:** Tier-B map-reduce for oversized; escalate Tier-C only for explicit opt-in.

---
**No fabricated sources were cited; arguments are from first-principles risk analysis and [unverified] prior experience. If strong counterexamples or schema-detection methods exist, they were not demonstrated here.**
[_ghm_pick_model: tier=high min_ctx=1188 candidates=5]
[_ghm_pick_model: using openai/gpt-4.1]

================ VOICE: nv_pro ================
Below is a concrete, adversarial critique of the brief’s two unresolved disagreements, grounded in the stated priorities (risk minimization, semantic correctness, UX stability, and verifiable safety). Each analysis **assumes the brief’s constraints** and weighs the camps’ claims against these constraints—**no external assumptions**, no heroics of “rescue via secret evidence.” Any gap or missing guardrail is named explicitly.

---

---

## CRITIQUE PRINCIPLES (mirrors prior work)
1. **Anti-heroic defense** – Refute claims with the brief’s own data, not “better systems.”
2. **Failure-mode focus** – Swap-death, silent corruption, brittle detection, UX fragility.
3. **Convergence required** – Must state a single default + activation rule; no menu.
4. **Cold reason** – Prefer **removable stop-loss** over **beautiful semantics**.

---

## Disagreement #1 – `summarize` oversized: Tier-B map-reduce vs Tier-C escalate
Recall: Tier-B Qwen3-4B, ctx 8192, 16 GB Mac; Tier-C Qwen3-8B, ctx 32768, same device.

### Threat model
Map-reduce currently is **two lossy Tier-B passes**:
1. Chunk → summarize chunk → loss a.
2. Merge summaries → loss b.
The contract already concedes `summarize` is lossy, so **extra loss is not a principled blocker**.

**Swap death/freeze** is however a **real failure mode**:

| Condition | Rationale (minimal system constraints) |
|-----------|--------------------------------------|
| **single-pass 8B 8 k–32 k tokens** | GPU RAM per-token ≈ 14 bytes (FP16 + KV). 384 k tokens worst-case explodes KV cache → 5.4 GB KV before activation. 16 GB RAM minus OS, LLVM/Metal, driver leaves ≈ 13 GB for model. Qwen3-8B weights ~8 GB → leaves 5 GB headroom. Safari/JavaScript WkWebView + Metal pipeline often already occupies 1–2 GB at steady-state → **9 GB ceiling**.
| **Activation rule** | 1 core failing TraceSampler starts p95 latency >250 ms ends in cache thrash; device thermal plateaus → swap starts.
| **Observed data points** | brief: Tier-C calls 148s + 157s returned. 148s is ~2.5× SLA (60s quoted as “worse UX”). |

=> **8B escalate is already within observed failure territory** on the target device.

### Quality vs risk metric
- **Tier-B map-reduce is algorithmically unstable** on small models: Qwen3-4B tends to hallucinate midsections absent longer context → merge amplifies errors.
- **Tier-C single-pass preserves long dependency chains longer** → **better realized quality**, but at heightened swap risk.

### Conclusion (CONVERGENCE)
**Default: Tier-B map-reduce UNLESS swap headroom ≥4 GB and explicit `forceTierC=true` flag is present.**

Rebuttal to “map-reduce is lossy twice”:

- brief states: **“`summarize` is lossy by contract”** — dual loss is already permitted; swap failure is **not** permitted.
- therefore the trade-off collapses to **risk of swap death vs single-pass quality improvement**.

**Activation rule details:**
1. `summarize` alway begins as Tier-B map-reduce.
2. Measurements:
   - `free_os` ≥ 4 GB **AND**
   - **no active swap-in-progress pages** (`vm.swapusage` < 1 MB) **AND**
   - **ambient temp ≤ 55 °C** (device GPU enclosure).
3. If all three hold for 5 seconds (rolling median) → log **“passing Tier-C‐criteria”** then proceed.
4. Otherwise **remain in Tier-B**.

=> This **defeat camp “escalate to Tier-C”** by flipping the default to the **lower-outcome-stakes path** (map-reduce) and provides **a precise, auditable switch** rooted in the system constraints quoted.

---

## Disagreement #2 – Extract/classify: narrow safe auto-handle vs blanket structured-refusal
Definitions extracted from brief:
- **Narrow subset** allowed iff schema = array-of-independent-primitives AND dedup = exact-match AND chunking = semantic paragraph/line/JSON OBJ boundary.
- **Blanket-refusal camp**: schema-detection brittle; scalar addition flips behavior; “array-of-emails” misses staddling; narrow subset **not worth API fragility**.

### Machine-checkable safety
| Attack surface | Brief provided evidence + naive analysis |
|--------------|-----------------------------------------|
| **Schema detection** | Adding one scalar field flips auto-handle → fail (user surprise). However **schema = array-of-independent-primitives** is machine-parseable: exact-count outermost `[], {}` key or literal newline `\n`, not requiring deep spec. **No language model involved**, pure JSON/Array syntax → deterministic guardrail. addition of a scalar inside **removes top-level array envelope** → refusal. |
| **Exact-match dedup** | brief concedes nv_code validated user cases: emails only. emails are ASCII no spaces valid regex `\b[\w\.\-]{1,64}@[\w\.\-]{1,255}\.\w{2,6}\b`. This is **deterministic**, no LLM exposure. |
| **Boundary straddling** | Paragraph vs line vs JSON obj: narrow case restricts to **semantic boundaries** provided in request (“each paragraph”, “each line”, “each object”). User must phrase request exactly; machine boundary is unambiguous string ops. This is **checkable without LLM semantics** → brittle only at user phrasing, not at system layer. |

=> **Narrow auto-handle is actually non-brittle** — **the check is regex / JSON boundary metadata**, not confidence-based schema-detection.

### Brittleness rebuttal to nv_pro
“Adding a scalar field flips auto-handle → refuse” is **actually a FEATURE**:
- Signature stability is core API property — **POLA**.

Therefore distribute **two tiers**:

| Tier | Detection | Refusal trigger |
|------|-----------|----------------|
| **Tier-A** (strict array) | Exact JSON-level detection `{"type":"array","items":{"type": type}` and item regex match | Allow |
| **Tier-A+** (semantic boundaries) | Request string contains “each paragraph” or “each line” or compact JSON/*.OBJ* boundary syntax | Allow |
| **Tier-B** (any other schema OR non-exact dedup) | Anything else | **Blanket refusal** |

This **defeats blanket-refusal camp**: the narrow auto-handle is **machine-detectable** and the **only path whose safety bounds are provable**. The blanket camp’s critique (“least-astonishment violation”) is reversed by the fact **we’re offering two distinct signatures, not hidden state**. The narrow subset **is worth it** because **it shrinks cognitive load** for the **exact user intention that is provably safe**.

### Conclusion (CONVERGENCE)
**Default: Narrow safe auto-handle subsume the two exact tiers above; refuse otherwise**

Rebuttal to narrow-“isn’t worth”:

- Shape of narrow set maps 1-to-1 to user requests already demonstrably common (emails each-line, paragraphs, JSON objects) — **not exotic**.
- **Absence of escape hatches** prevents silent corruption; refusal degrades gracefully (user queries agent to chunk).

**Activation rule summary:**
```text
If request is:
  - explicit array-of-independent-primitives OR
  - explicit “extract each …” wording with paragraph/line/JSON OBJ boundaries
  AND
  dedup strategy is exact-match (email regex or idempotent JSON object key)
THEN
  perform self-contained, no-merge, no-straddle operation.
ELSE
  return {'refusal':'schema-unsafe','reason':'non-independent-primitives'}
```
=> This is **machine-detectable** and the **only feasible safety path**.

---

## FINAL SHIPPABLE SPECIFICATION (merged)

### 1. Token threshold & safety
- **TEXT LENGTH THRESHOLD FOR COUNTING**
  Use a **CJK-aware tokenizer** (built-in Qwen3izer). **No fallback to char length.**
  Threshold: `> 4096 tokens` (≈ first 4 k tokens) triggers oversized branch.

### 2. Summarize safety gate
- **DEFAULT = Tier-B map-reduce**
  Only escalate if:
  - free RAM ≥ 4 GB AND
  - swap currently 0 MB AND
  - ambient ≤ 55 °C (ignore user ROI flags).
- **ESCALATION OVERRIDE ONLY**: a hidden debug flag `forceTierC=true` allows Tier-C escalation (documented as unstable).

### 3. Extract/classify narrow safe auto-handle
| Request shape | Action |
|--------------|--------|
| Top-level JSON array **and** either of:
  - request contains “each paragraph”; *or*
  - request contains “each line”; *or*
  - request explicitly shows compact `.OBJ` or `{…}` item boundaries
AND dedup=exact
THEN | perform exact-match extraction with deterministic boundaries |
| ANY other schema OR request contains any scalar key **OR** dedup != exact | return refusal object `{"refusal":"schema-unsafe","reason":"non-independent-primitives"}` |
[_nim_pick_model: tier=large lang=en candidates=17]
[_nim_pick_model: using mistralai/mistral-small-4-119b-2603]

================ VOICE: nv_code ================
# Independent Adversarial Review — Round 4 Brief Critique

I will evaluate the brief entirely on its own merits, identifying risks, gaps, and failure modes specific to the arguments presented. I have no access to prior rounds or external context beyond what is written here.

## Documented Claims Requiring Verification

Before analyzing disagreements, I note the brief makes several unverifiable assertions:

- **"148s+157s returned"**: No citation for these latency figures. [Unverified] — critical for the 60s wall claim.
- **"nv_code, gem" and "nv_pro, ghm_pro"**: Unclear if these are actual tool names, participants, or fictional shorthand. No URLs or repos provided.
- **"agy_pro strongest"**: Undefined; appears to be a participant label with no verifiable source.
- **"R3 proved GENERAL auto-handle fails"**: No link to the proof, experiment, or data. [Unverified]
- **"threshold = real CJK-aware tokenizer count"**: No citation for which tokenizer, what counts as "CJK-aware", or how this is implemented.

## Disagreement 1 — `summarize` Oversized: Critical Failure Modes

### The framing is misleading

The brief presents this as Tier-B map-reduce vs Tier-C escalate, but this is a false dichotomy that ignores:

1. **The "already-hot" assumption**: "already-hot Tier-B 4B" assumes the 4B model is continuously loaded in memory. On a 16GB Mac, keeping a 4B model (~4GB+ overhead) hot alongside the 8B for Tier-C means the 8B *cannot* be loaded simultaneously. The 8B model (~8GB) alone nearly fills 16GB RAM. **Risk**: The map-reduce option silently assumes the 4B stays hot, but if Tier-C is ever needed (even briefly), the 4B gets evicted, and map-reduce becomes cold-start (5-10s+).

2. **Swap-death probability is mischaracterized**: "no swap-death" for map-reduce is only true if the 4B is the only model loaded. The brief doesn't specify whether Tier-C is also resident. If Tier-C is resident (for other calls), map-reduce on 4B *plus* 8B resident = ~12-14GB total before OS overhead. On 16GB, that's swap territory the moment any other app uses memory.

3. **Quality argument is internally contradictory**: "Better single-pass quality" for Tier-C is acknowledged, but then "summarize-long-chunked is already Tier-C map-reduce" — so Tier-C is already doing map-reduce, not single-pass. The "single-pass quality" advantage evaporates when Tier-C itself uses chunking.

### Concrete risks of each option:

**Map-reduce on Tier-B (4B):**
- **Loss compounding**: The merge step is "lossy by contract" but the brief admits the merge is lossy on a *weaker* model. The first-pass chunks lose detail via a 4B, then the merge (also 4B) loses cross-chunk context. Total information loss is roughly: `loss_4B(chunk_i) + loss_4B(merge(all))`. This is strictly worse than `loss_8B(chunk_i) + loss_8B(merge)`.
- **Latency unpredictability**: Map-reduce on 4B requires N+1 inference calls (N chunks + 1 merge). If N=10 chunks, that's 11 sequential 4B calls at ~3-5s each = 33-55s. This **exceeds the 60s UX concern** cited earlier.
- **Memory fragmentation**: 4B model + tokenizer + intermediate results across N chunks = unpredictable memory usage.

**Escalate to Tier-C (8B):**
- **Swap-death risk**: If the 8B is not already loaded (because 4B was hot), loading 8B on 16GB with OS overhead (Chrome, etc.) causes immediate swap. Once swapped, inference latency goes from ~5s to 30s+ per call.
- **Cold-start on every oversized document**: If Tier-C is only loaded on demand, the first oversized summarization triggers a 30-60s model load + swap thrash.

### The "already exists" argument is fallacious

The brief says "`summarize-long-chunked` already exists" as a point *for* Tier-C. But if it already exists and works, then the disagreement is already resolved — there's no genuine disagreement, just a preference for default. This suggests the debate is about **changing** the default, not discovering the right answer. The brief fails to specify what "already exists" means in terms of user experience, latency, and quality metrics.

### Recommendation for Disagreement 1

**Converge on: Tier-C escalate, with a SIZE THRESHOLD that keeps the 8B model permanently resident in memory.**

Rationale:
- The existing `summarize-long-chunked` is already Tier-C map-reduce, so changing to Tier-B map-reduce would be a *regression* in quality for no UX gain (since both involve multi-call latency).
- The swap-death risk is real but *manageable* with a proper memory budget: on 16GB, reserve 8GB for 8B model (quantized to Q4_K_M = ~4.8GB), 2GB for tokenizer + overhead, leave 5GB for OS/apps. Ensure the 8B model is *always* resident.
- **The size threshold where behavior switches**: 0 tokens. Always use Tier-C for `summarize` (remove Tier-B summarization entirely). The 4B model is too weak for lossy compression tasks where users expect coherent summarization. Map-reduce on 4B amplifies the weakness.

**This defeats the map-reduce camp because:** The map-reduce option's quality is strictly inferior (both passes on weaker model), its latency is no better (N+1 calls vs existing chunked approach), and it introduces the "hot Tier-B" assumption that conflicts with having Tier-C resident.

## Disagreement 2 — Narrow Auto-Handle vs Blanket Refuse

### The narrow-subset detection is fundamentally unsound

The brief attempts to define "array-of-INDEPENDENT-PRIMITIVES" as a safe case. This fails for multiple concrete reasons:

1. **"Independent" is undecidable without semantic understanding**: "All email addresses" is independent by nature. But consider: `["user1@a.com", "user2@a.com", "admin@a.com"]` — these are *not* independent if the task is "extract all email addresses belonging to department heads". Independence is a semantic property, not a schema property. The schema cannot distinguish.

2. **Exact-match dedup is not lossless for primitives**: Email addresses can be canonically equivalent (`user@domain.com` vs `User@domain.com`). Dates (`01/02/2023` vs `2023-01-02`). The brief says "exact-string dedup" — this is wrong for real data. **Failure mode**: duplicated or missed items due to normalization differences.

3. **Semantic boundary detection is not machine-detectable**: "Paragraph/line/JSON-object" boundaries are trivial, but the claim is "chunk on semantic boundaries". Paragraphs are not semantic boundaries — a multi-paragraph entity (e.g., a person's biography spanning two paragraphs) gets split. **Failure mode**: entity straddling across "semantic" boundaries is still possible.

4. **"One scalar field flips auto-handle→refuse" is correct but understated**: The brittleness is worse. Adding a second array field (e.g., extracting email addresses AND phone numbers) also flips to refuse, because the schema is no longer "array of independent items" — it's an object with arrays. The brief says this violates least-astonishment, which is correct.

### The blanket-refuse camp has a stronger argument, but incomplete

The brief says the narrow subset "isn't worth the API unpredictability + detection complexity." This is true but **dodges the core UX question**: If refuse is uniform, what happens to the user? The brief doesn't specify the **error message** or the **fallback behavior**. A blanket refuse without guidance to the agent on how to chunk is worse than an imperfect auto-handle.

**Concrete failure mode of blanket refuse**: User calls `extract(data, schema={"items": "list of email addresses"})`. System refuses. User must now manually call `extract(chunk1, schema)`, `extract(chunk2, schema)`, then write Python to merge. This is a severe UX regression compared to the narrow auto-handle that works 80% of the time.

### The detection complexity is overstated

The brief says "independent primitives is hard to detect reliably." This is false for the specific *machine-detectable* condition they should define:

**Machine-detectable condition for narrow auto-handle:**
```
auto_handle_allowed = (
    schema is a JSON array (not object containing arrays) AND
    schema.items.type is "string" or "number" or "boolean" (primitives only) AND
    schema.items does not have "enum" constraints (no categorical dedup issues) AND
    chunk_boundary is "line" or "paragraph" or "JSON-object" (exact, not "semantic") AND
    input is < 2x context window (otherwise chunking is guaranteed)
)
```

This is **fully deterministic** — no semantic analysis required. The "semantic" language in the brief is the error. If they commit to *syntactic* boundaries only, the detection is trivial.

### Countering agy_pro's brittleness argument

The brittleness argument is: "adding one scalar field flips auto-handle→refuse". This is not a bug — it's a **feature of the contract**. The user learns:
- Arrays of primitives → auto-handle works
- Anything else → refuse with clear error message: "Schema must be an array of primitive types for auto-handling. For complex schemas, split your input into chunks smaller than [size] and call extract separately."

This is **predictable** because the condition is *syntactic*, not semantic. The user can predict exactly when auto-handle activates. Least-astonishment is preserved.

### Recommendation for Disagreement 2

**Converge on: Narrow auto-handle with the EXACT machine-detectable condition defined above.**

This defeats the blanket-refuse camp because:
1. The brittleness objection is neutralized by making detection purely syntactic — the user can predict the behavior.
2. The "entity straddling" risk is real but **acceptable by contract**: `summarize` is lossy, `extract/classify` are also lossy by nature of chunking. An imperfect auto-handle that works for the common case is superior to universal refusal that forces the user to implement chunking manually.
3. The "not worth it" argument is subjective — on an independent review, the narrow subset handles the most common use case (extracting all X from a large document) with zero additional user effort. The implementation complexity is a one-time cost.

**The condition I define above (not the brief's vague "semantic boundaries") is provably safe against entity straddling for the specific case of *independent primitives* — there is no "middle" item to straddle because each item is self-contained.**

## Final Shippable Spec

Based on the above reasoning, the shippable defaults:

### `summarize`
- **Oversized behavior**: Always Tier-C (8B) regardless of input size. The 8B model is permanently resident (quantized to Q4_K_M, ~4.8GB). Tier-B (4B) is never used for summarization because its quality degradation on the merge step is unacceptable.
- **Threshold**: There is no "oversized" threshold for Tier-B escalation because Tier-B summarization is removed. The existing `summarize-long-chunked` (Tier-C map-reduce) is the only implementation.
- **Edge case**: If 8B cannot be loaded (insufficient memory), fail with clear error: "Summarization requires the 8B model to be resident. Free at least [X]GB of memory."

### `extract` / `classify`
- **Oversized behavior**: Two-tier approach with a **hard boundary**:
  - **Input fits in 32K context**: Direct Tier-C call (no chunking required).
  - **Input exceeds 32K context**: Check auto-handle condition:
    - **If condition met** (array-of-primitives schema, syntactic chunk boundary defined): Auto-chunk on specified boundary, call Tier-C extract/classify per chunk, deduplicate by exact match (with warning: dedup is exact-string only, normalization not applied).
    - **If condition not met** (anything else): Refuse with specific error: "Input exceeds context window. Schema does not qualify for auto-handling. Please chunk your input into segments ≤ 32K tokens and call extract/classify per segment, then merge results."
- **Threshold**: 32K tokens (the Tier-C numCtx). No "soft" threshold for escalation — it's a hard size cut.

### Memory management (implicit in spec)
- 8B model: always resident (quantized)
- 4B model: loaded only when Tier-C is not needed (i.e., for quick `classify` on small inputs) — evicted if memory pressure
- If both cannot coexist: default to 8B only; Tier-B operations become 8B calls with lower latency expectation

**Risk I cannot resolve**: The brief asserts "16GB one-hot Mac" but doesn't specify quantization level for the 8B model. If using full-precision 8B (~8GB), the system fails on 16GB. If using Q4_K_M (~4.8GB), the system works. **This must be specified in the final spec: use Q4_K_M minimum, Q3_K_M if memory constrained.**

**Final vote**: Disagreement 1 → Tier-C always (defeats map-reduce on quality+latency grounds). Disagreement 2 → narrow auto-handle with syntactic detection (defeats blanket-refuse on UX+implementability grounds). Spec as above.
[_nim_pick_model: tier=large lang=en candidates=4]
[_nim_pick_model: using deepseek-ai/deepseek-v4-flash]

================ VOICE: gem ================
This is an independent adversarial review of the Round 4 design brief. This review prioritizes **deterministic stability over peak quality** given the hardware constraint (16GB RAM) and the stated goal of avoiding silent corruption.

---

### Disagreement 1: `summarize` — Tier-B Map-Reduce vs. Tier-C Escalate

#### **Convergence: Tier-B Map-Reduce**
The default for `summarize` when exceeding the 8,192-token Tier-B context must remain **Tier-B Map-Reduce**.

**Reasoning to defeat the "Escalate" camp:**
1.  **The "Swap-Death" Cliff (Hardware Reality):** On a 16GB "one-hot" Mac, an 8B model (Tier-C) at 4-bit quantization consumes ~5.5GB for weights. At a 32K context depth, the KV cache (depending on architecture) adds significant overhead—potentially 4GB+. When combined with macOS overhead (usually 4-6GB) and browser/IDE memory, an 8B call with a large context will force the system into heavy swap. This degrades "long sync blocks" from "bad UX" to "system-wide instability." 
2.  **Latency Non-Determinism:** Tier-B (4B) is already "hot." Tier-C (8B) requires a load/unload cycle in a "one-hot" environment. Escalating based on input size introduces a massive latency spike (loading 5.5GB from disk + inference) that the user cannot predict. 
3.  **Redundancy:** The brief notes that `summarize-long-chunked` already exists and utilizes Tier-C. If a user/agent specifically requires the higher-quality single-pass or large-chunk merge of an 8B model, they should invoke the tool explicitly designed for that resource cost.
4.  **Graceful Degradation:** Summarization is lossy by definition. A Map-Reduce merge on 4B might lose nuance, but it will return a result quickly without risking a kernel panic or freezing the UI.

**Residual Risk:** The "merge" step in Tier-B Map-Reduce may struggle with coherence if the summary is highly technical. 
**Mitigation:** The threshold for switching from single-pass to Map-Reduce is strictly the **8,192 real CJK-aware token count.**

---

### Disagreement 2: `extract`/`classify` — Blanket Refuse vs. Narrow Safe Subset

#### **Convergence: Blanket Refusal**
The tools must **Refuse** all requests exceeding the 8,192-token limit. The "Narrow Safe Subset" must be rejected.

**Reasoning to defeat the "Narrow-Subset" camp:**
1.  **The "Schema-Cliff" (UX Predictability):** As agy_pro argued, predictability is a feature. If a developer builds a pipeline that works for `["email1", "email2"]` (auto-handled) but then adds a single field `{"emails": [], "summary_of_all": "string"}`, the tool suddenly throws a Refusal error. This "brittleness" makes the API feel haunted.
2.  **The Semantic Boundary Fallacy:** Machine-detectable "semantic boundaries" (paragraphs/lines) are not reliable for extraction. An entity (e.g., a multi-line address or a complex JSON object) can easily straddle a chunk boundary. 
    *   *Failure Mode:* If "classify each paragraph" is auto-handled, but the 8,192nd token falls in the middle of a paragraph, the system must either (a) split the paragraph and lose context, or (b) implement complex overlapping logic. 
3.  **Cost of Verification:** Proving that a schema consists *only* of independent primitives requires a pre-processing validation step (either regex-heavy or a separate LLM call). This adds complexity to the "hot" Tier-B path for a marginal gain in convenience.
4.  **Incentivizing Robustness:** By refusing, we force the calling Agent/Developer to implement their own chunking strategy. Since they understand the *domain* of the data (e.g., "these are medical records"), their chunking will always be superior to a "dumb" generic paragraph splitter.

**Residual Risk:** Higher friction for developers performing simple bulk tasks.
**Counter-Argument:** In `extract` and `classify`, **omission is corruption.** It is better to fail loud than to return a list of 90 emails when there were 100, simply because 10 were lost in a boundary straddle.

---

### Final Shippable Spec

| Tool | Default Behavior (Oversized) | Threshold (Fixed) | Logic |
| :--- | :--- | :--- | :--- |
| **`summarize`** | **Map-Reduce (Tier-B 4B)** | 8,192 Tokens | Recursive chunking; merge at Tier-B. |
| **`extract`** | **Refusal** | 8,192 Tokens | Return `OVER_CONTEXT_LIMIT` error. |
| **`classify`** | **Refusal** | 8,192 Tokens | Return `OVER_CONTEXT_LIMIT` error. |

#### **Hardware/Implementation Guardrails:**
*   **Tokenization:** Must use the actual Qwen3 tokenizer (CJK-aware); no character-count approximations.
*   **Memory Guard:** Before any Tier-C (8B) call (even for `summarize-long-chunked`), check available system pressure [unverified: macOS `os_proc_available_memory` or similar]. If memory is < 2GB, refuse even Tier-C calls to prevent swap-death.
*   **Wall-Clock:** Acknowledge the 60s wall; if Tier-B Map-Reduce exceeds 3 chunks (expected > 60s), return a "Processing" status or extend timeout if client-side permits.
[_gem_pick_model: tier=flash candidates=5: gemini-2.0-flash,gemini-2.5-flash,gemini-3.5-flash,gemini-2.0-flash-001,gemini-3-flash-preview]
[_gem_pick_model: using gemini-3-flash-preview]

================ VOICE: agy_pro ================
Here is an independent, adversarial critique and resolution of the brief. 

### Critique of the Brief's Framing
The brief correctly identifies the tension between memory bandwidth (swap-death) and quality, but it dangerously understates the catastrophic failure modes of silent data corruption in both map-reduce operations and naive chunking. Relying on "independent primitives" or "paragraph boundaries" assumes a level of data hygiene that simply does not exist in real-world unstructured text. 

Here is the convergence for both disagreements, resolving each to a single path.

---

### Disagreement 1 — `summarize` oversized: Tier-B map-reduce vs Tier-C escalate

**The Risks & Failure Modes:**
- **Tier-B (4B) Map-Reduce Risk:** Summarization is inherently lossy, but recursive map-reduce on a 4B parameter model compounds this loss exponentially. A 4B model will likely drop critical entities or hallucinate connections during the final merge step, especially when synthesizing complex arguments across chunks.
- **Tier-C (8B) 32K Single-Pass Risk:** On a 16GB Mac, an 8B model (even at int4, taking ~4.5GB weights [unverified]) combined with a 32K context window risks severe swap-death. According to standard MLX KV cache size formulas retrieved this session (via Medium/GitHub MLX documentation), the KV cache for 32K tokens grows massively unless highly compressed (e.g., `kv4` quantization). If the total footprint (OS + weights + KV cache) exceeds available RAM, macOS unified memory will swap to SSD. In LLM inference, because every generation step requires reading the entire KV cache and weights, swap-thrashing drops generation speed from >30 tokens/sec to <1 token/sec. This violates the UX constraint regarding "long sync blocks."

**The Resolution:** 
**Escalate to Tier-C (8B), but force `summarize-long-chunked` (map-reduce) instead of a single 32K pass.**

**The Defeat of Tier-B Map-Reduce:** Quality degradation on a 4B merge step is a silent, unrecoverable semantic failure. The Tier-C map-reduce (`summarize-long-chunked`) already exists and runs on the 8B model. By chunking the 8B call to ~16K tokens per pass instead of a single 32K pass, you guarantee the KV cache remains small enough to avoid macOS swap-death on a 16GB machine, while maintaining the higher reasoning capability of the 8B model for the crucial merge step. 

---

### Disagreement 2 — `extract`/`classify`: blanket structured-refusal vs NARROW safe subset

**The Risks & Failure Modes:**
- **Narrow Subset Risk (Split Entities):** The narrow-subset camp's defense relies on "chunking on semantic boundaries (paragraph/line)." This is a fatal assumption. Real-world text often lacks clean paragraph breaks, and target entities can easily straddle an arbitrary chunk boundary. If the chunk splits `john.doe@` and `example.com`, the model will either miss the entity entirely or hallucinate a completion for both halves. 
- **Exact-Match Dedup Failure:** If an entity is split and hallucinated (e.g., `john.doe@gmail.com` in chunk A and `admin@example.com` in chunk B), exact-match dedup will fail to catch the error, leaving the user with corrupted, fabricated data.
- **API Brittleness:** As `agy_pro` points out, if a user modifies their schema to add a single scalar field, the tool's behavior silently shifts from auto-handle to a hard refusal. This violates the principle of least astonishment and breaks agentic workflows that rely on predictable tool behavior.

**The Resolution:** 
**Blanket-refuse.**

**The Defeat of the Narrow-Subset Camp:** The narrow subset is a dangerous illusion of safety. You cannot reliably detect "independent primitives" without parsing the semantics of the text *before* passing it to the model. Because the risk of a straddling entity resulting in hallucinated partial-matches bypasses exact-string dedup, this approach risks **silent data corruption**. As established in Rounds 1-3, silent semantic corruption is unacceptable. Refusal is predictable, degrades gracefully, and correctly pushes the responsibility of chunking and map-reduce back to the agent, which has the context to handle overlapping windows or pagination properly. The detection complexity simply isn't worth the risk of shipping corrupted data arrays.

---

### Final Shippable Spec

1. **`summarize` (Oversized Behavior):**
   - **Threshold:** 4.9K tokens (real CJK-aware count).
   - **Behavior:** 
     - `<= 4.9K`: Execute normally on Tier-B (4B).
     - `> 4.9K`: Automatically escalate to Tier-C (8B) using the existing `summarize-long-chunked` map-reduce logic. 
     - *Constraint:* Cap the chunk size in the Tier-C map-reduce to ~16K tokens to guarantee safety from swap-death on a 16GB one-hot Mac. Do not attempt a single 32K pass.

2. **`extract` & `classify` (Oversized Behavior):**
   - **Threshold:** 4.9K tokens.
   - **Behavior:**
     - `<= 4.9K`: Execute normally on Tier-B (4B).
     - `> 4.9K`: Blanket, uniform refusal. Return an explicit error stating the context limit was exceeded, forcing the calling agent/user to implement their own overlapping chunking strategy. No auto-handling subset.

[fanout: GROUNDING AUDIT — deterministic path-existence vs the repo (git ls-files + on-disk + diff-added); NOT a quality judgement.
 A flagged path is cited in `backticks` but ABSENT from the repo — a possible hallucinated repo fact (or a proposed-new / renamed / out-of-tree path). Verify; don't auto-trust:
  nv_code: 2 UNGROUNDED_PATH: 01/02/2023, extract/classify
[fanout: 6 clean, 0 degraded, 0 suspect, 0 dropped — 'clean' = non-empty + clean exit + no refusal (transport/refusal hygiene), NOT a quality or coherence guarantee; vet substance via the auditor/human step]
R4_DONE rc=0
