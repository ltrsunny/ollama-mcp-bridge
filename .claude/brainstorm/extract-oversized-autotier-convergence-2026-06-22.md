# Convergence — oversized-input handling for Tier-B bridge tools (extract/classify/summarize)

3-round full-power fanout debate (6-voice roster ghm/ghm_pro/nv_pro/nv_code/gem/agy_pro). Trajectory:
- **R1 (independent):** diverged. Converged on tool-split + no-LLM-router + truncation-as-an-option.
- **R2 (rebut):** FLIPPED the naive "auto-escalate + sticky-lock + truncate" synthesis. 6/6 voices
  killed sticky-lock (8B resident → OS swap-death on 16GB), killed truncation-with-warning for
  extract/classify (silent semantic corruption; agents ignore `_warning`), killed auto-escalation
  (removes the backpressure circuit-breaker).
- **R3 (anti-woozle steelman of the user's directive):** the steelman of TRUE auto-handling
  (schema-shape-aware chunk→extract→deterministic-union) GENUINELY FAILS — 5/5 effective voices, by
  concrete refutation not fatigue: dedup-by-key fallacy (no reliable key; fuzzy/hallucinated keys),
  coreference/long-range semantic straddling (overlap fixes lexical not semantic), contradictory-state
  merge (needs an LLM merge = forbidden), lost-in-the-middle (arXiv:2307.03172 — recall degrades
  mid-context, not just at the limit), resident-lock hypocrisy (Tier-B map-reduce blocks just as long),
  schema-shape brittleness (adding one scalar field flips auto-handle→refuse = unpredictable API).

## Final converged design
| Tool | Oversized behavior | Notes |
|---|---|---|
| `summarize` | **Auto-route to the existing `summarize-long`/`summarize-long-chunked`** (Tier-C map-reduce; lossy is acceptable by the tool's contract). | True plug-and-play. Mostly exists — change is `summarize` auto-escalating instead of refusing. Directly fixes the originating friction (digest-class needs were mis-routed to `extract`). |
| `extract` / `classify` | **Structured, actionable refusal** — a valid response `{error, input_tokens, limit, suggestion}` flagged `isError` (so an agent doesn't read it as empty-success). NO auto-escalate, NO truncate, NO chunk-merge. Optional opt-in `allow_tier_escalation` (default **false**). | The plug-and-play-SAFE maximum: the tool tells the agent what to do at the point of failure (no pre-memory needed), preserves the backpressure circuit-breaker, never silently corrupts. The agent does the chunking — only it knows if its task is map-reduceable. |
| threshold | **Real tokenizer count (CJK-aware)**, NOT char/N. Bridge already has `countTokens` (js-tiktoken). | Critical for CJK (char/3.8 under-counts Chinese → could breach the real limit + crash the MLX runner before the guard). |

## Residual risk
Agents may ignore the structured refusal / fail to chunk → retry loop. Mitigations: `isError` flag +
concrete `suggestion` in the body. Accepted trade: a visibly-looping agent > silent semantic corruption.

## How this lands vs the user's directive
- `summarize`: directive FULLY met (tool auto-handles).
- `extract`/`classify`: true auto-handling is unsafe (3 rounds incl. a dedicated steelman proved it).
  The structured-actionable-refusal is "the tool guides you at the failure point" rather than "remember
  in advance" — honors plug-and-play as far as is safe, but the agent still performs the chunking.

## R4 RESOLUTION — both remaining disagreements converged ON-MERITS (not by vote)
- **`extract`/`classify` → blanket structured-refusal (CONVERGED).** The narrow-subset-auto-handle
  dissent (nv_code/nv_pro: pure-SYNTACTIC detection makes it predictable, defeating the brittleness
  objection) was refuted by agy_pro and left unanswered: a PRIMITIVE itself straddles a chunk boundary
  (`john.doe@` | `example.com`); overlap fixes the MISSING-item case but the edge-partial gets
  **hallucinated-completed** by the model (chunk A: `john.doe@fabricated.com`; chunk B: the real one) →
  two distinct strings → exact-match dedup CANNOT catch the fabricated extra → silent corruption.
  Deterministically discarding edge-touching items needs reliable char offsets, which schema-extraction
  doesn't provide → can't be fixed without semantic judgment (violates C5). So "no silent corruption"
  ⇒ blanket-refuse. (No opt-in escalation flag — the panel didn't endorse it; keep it simple.)
- **`summarize` → auto-route to the EXISTING `summarize-long-chunked` (CONVERGED).** The B-vs-C split
  was a false dichotomy (agy_pro, nv_code): the real choice isn't "Tier-B map-reduce vs single-32K-pass
  Tier-C" — `summarize-long-chunked` is ALREADY Tier-C *bounded* map-reduce, which avoids BOTH the
  single-pass swap-death (KV stays bounded) AND the Tier-B-4B merge quality regression. Empirically
  validated: Tier-C `summarize-long` ran on this 16GB box this session (148s, 157s, no swap-death).
  It already inherits the memory-guard + chunked-fallback (commit 7b96516). Tier-B-map-reduce camp
  defeated: 4B merge = silent quality regression, and unnecessary since bounded Tier-C already avoids swap.

## Shippable spec (4-round converged) + implementation size
- `summarize` oversized → delegate to the existing `summarize-long-chunked` path (low-risk; reuses the
  guarded chunked map-reduce). Directly fixes the originating friction.
- `extract`/`classify` oversized → return a structured `isError` response `{error, input_tokens,
  limit, suggestion}` (replaces the current bare "exceeds limit" throw). Small change.
- threshold → real tokenizer count (CJK-aware) via the bridge's `countTokens`, replacing the current
  char/estimate heuristic. (js-tiktoken is an approximation of Qwen's tokenizer but far closer than
  char/N for CJK; the ideal Qwen tokenizer is a follow-up.)
- Next: scope memo (feature-intake) → Auditor pass → implement.

## Records
Briefs + per-round voice outputs: `extract-oversized-autotier-r{1,2,3}-{brief,voices}-2026-06-22.md`.
Empirical grounding: 60s-wall probe — two silent Tier-C calls (148s, 157s, stdio) returned → wall not
client-enforced here; but a long sync block is still poor UX (so: no async, but cap sync wait).
