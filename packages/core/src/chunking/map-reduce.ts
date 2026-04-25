/**
 * Map-reduce chunked summarization orchestrator.
 *
 * See docs/scope-memos/v0.2.0-backend-abstraction-and-chunked-summarize.md
 * §5 for the design and §3.2 for the AbortSignal / timeout discipline this
 * implements.
 *
 * Flow:
 *   0. Validate options (OMCP_CHUNK_OVERLAP < OMCP_CHUNK_SIZE etc).
 *   1. Pre-flight abort check.
 *   2. Fast-path: byte-count estimate. If it clearly fits, verify with
 *      actual countTokens; if it really fits, ONE single-call summarize
 *      using FAST_PATH_SYSTEM. No chunking, no reduce.
 *   3. Chunking: RecursiveCharacterTextSplitter with backend tokenizer.
 *      Hard-error if chunks > max_chunks (default 100).
 *   4. MAP: p-limit(concurrency) per chunk; each chunk gets a chained
 *      AbortSignal (job ⊕ 50 s timeout). Queue-drain guard at chunk-fn
 *      entry checks jobSignal.aborted and bails before any backend work.
 *      Catch logic distinguishes job cancellation (re-throw) from local
 *      timeout / error (substitute placeholder + chunksFailed++).
 *   5. REDUCE: pack summaries into ≤ 3 K-token buckets. If single
 *      bucket fits, ONE reduce call → done. Else recurse with same
 *      orchestration. Max depth 3; beyond that return partial.
 */

import pLimit from 'p-limit';
import type { LlmBackend } from '../llm/backend.js';
import { splitToChunks } from './split.js';
import {
  MAP_SYSTEM,
  REDUCE_SYSTEM,
  FAST_PATH_SYSTEM,
  mapUserPrompt,
  reduceUserPrompt,
  fastPathUserPrompt,
} from './prompts.js';

// ── Tunables ────────────────────────────────────────────────────────────────

export const DEFAULT_CHUNK_SIZE = 2000;
export const DEFAULT_CHUNK_OVERLAP = 200;
export const DEFAULT_CONCURRENCY = 2;
export const DEFAULT_MAX_CHUNKS = 100;

/**
 * Multiply the user-configured chunk size by this factor before passing to
 * the splitter, to absorb proxy-tokenizer drift (js-tiktoken cl100k vs
 * Qwen / Llama tokenizers, up to ±15 %). Caller's apparent budget × 0.85
 * keeps actual model usage under the budget when the proxy under-counts.
 */
export const TOKENIZER_SAFETY_FACTOR = 0.85;

/**
 * Prompt-framing overhead that the map / reduce / fast-path system+template
 * prompts add on top of the user content. Used both for the actual num_ctx
 * sizing and for the fast-path budget check.
 */
export const PROMPT_OVERHEAD_TOKENS = 500;

/**
 * Per-call soft timeout. Each backend.chat() inside MAP and REDUCE phases
 * is wrapped in `AbortSignal.any([jobSignal, AbortSignal.timeout(this)])`.
 * 50 s leaves ~10 s margin under Claude Code's hard ~60 s MCP request
 * timeout.
 */
export const PER_CALL_TIMEOUT_MS = 50_000;

/**
 * Generous timeout for the fast-path single call — it summarizes the whole
 * document in one shot, so it's allowed up to 4 × the per-chunk budget.
 * Still well under any sane MCP-client total timeout.
 */
export const FAST_PATH_TIMEOUT_MS = 200_000;

/**
 * Max prompt-token budget for a single REDUCE call. Sized so that
 * prompt-eval (≈ 6.4 s/1 K on qwen2.5:7b) + reduce-output generation
 * (≈ 26.7 s for 400 tokens at thermal-throttled 15 t/s) finish under
 * PER_CALL_TIMEOUT_MS even on a loaded 16 GB Mac. See scope memo §5.2
 * "Why the bucket budget shrinks across drafts".
 */
export const REDUCE_BUCKET_TOKENS = 3_000;

export const MAX_RECURSION_DEPTH = 3;

/** MAP-phase output token budget — one fragment summary, 3-5 sentences. */
export const MAP_OUTPUT_BUDGET = 400;

/** REDUCE-phase final-output token budget — 1-2 sentence lead + 3-6 bullets. */
export const REDUCE_OUTPUT_BUDGET = 800;

// ── Public types ────────────────────────────────────────────────────────────

export interface ChunkedSummarizeOptions {
  /** The full document text. */
  source: string;
  /** Optional style hint forwarded to the REDUCE / fast-path prompt. */
  style?: string;
  /** LLM backend used for both MAP and REDUCE phases. */
  backend: LlmBackend;
  /**
   * Backend's per-call max input tokens (Tier C `num_ctx`, typically 32 K).
   * Used for the fast-path budget check.
   */
  maxInputTokens: number;
  /**
   * Job-level AbortSignal — typically `extra.signal` from the MCP request
   * handler. The MCP SDK fires this on client cancellation / disconnect.
   */
  signal: AbortSignal;
  /** Hard cap on chunk count. Default 100. */
  maxChunks?: number;
  /** Override default chunk size in tokens (env: OMCP_CHUNK_SIZE). */
  chunkSize?: number;
  /** Override default chunk overlap in tokens (env: OMCP_CHUNK_OVERLAP). */
  chunkOverlap?: number;
  /** Override default fan-out concurrency (env: OMCP_CHUNK_CONCURRENCY). */
  concurrency?: number;
  /** Optional progress callback wired to MCP `sendProgress`. */
  onProgress?: (msg: string, current: number, total: number) => void | Promise<void>;
}

export interface ChunkedSummarizeResult {
  /** The final summary text, trimmed. */
  text: string;
  /** Number of chunks processed in the MAP phase. 1 means fast-path was taken. */
  chunksProcessed: number;
  /** Number of REDUCE passes performed. 0 for fast-path; 1+ for normal flow. */
  reduceDepth: number;
  /** True if recursion hit MAX_RECURSION_DEPTH and the result is incomplete. */
  partial: boolean;
  /** Chunks whose MAP call timed out or errored; placeholders were substituted. */
  chunksFailed: number;
  /** REDUCE-pass calls that timed out or errored; placeholders were substituted. */
  reduceFailed: number;
  /** Total prompt tokens summed across every backend.chat() call this job made. */
  promptTokens: number;
  /** Total completion tokens summed across every backend.chat() call this job made. */
  completionTokens: number;
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function chunkedSummarize(
  opts: ChunkedSummarizeOptions,
): Promise<ChunkedSummarizeResult> {
  // 0. Validate options
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const chunkOverlap = opts.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP;
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  const maxChunks = opts.maxChunks ?? DEFAULT_MAX_CHUNKS;
  if (chunkSize <= 0) {
    throw new Error(`chunk size must be positive (got ${chunkSize})`);
  }
  if (chunkOverlap < 0 || chunkOverlap >= chunkSize) {
    throw new Error(
      `chunk overlap (${chunkOverlap}) must satisfy 0 ≤ overlap < chunk size (${chunkSize})`,
    );
  }
  if (concurrency < 1) {
    throw new Error(`concurrency must be ≥ 1 (got ${concurrency})`);
  }
  if (maxChunks < 1) {
    throw new Error(`max_chunks must be ≥ 1 (got ${maxChunks})`);
  }

  // 1. Pre-flight abort check — bail before any backend work
  throwIfAborted(opts.signal);

  // 2. Fast-path: cheap byte-count estimate first, only call countTokens
  //    if estimate looks promising (avoids tokenizing the full source on
  //    documents we already know don't fit).
  const fastPathBudget = opts.maxInputTokens - PROMPT_OVERHEAD_TOKENS - 200;
  // ~3 bytes per token as conservative Chinese estimate; ~4 for English. Use 3.
  const cheapEstimate = Math.ceil(opts.source.length / 3);
  if (cheapEstimate <= fastPathBudget) {
    const actualTokens = await opts.backend.countTokens(opts.source);
    throwIfAborted(opts.signal);
    if (actualTokens <= fastPathBudget) {
      return runFastPath(opts);
    }
    // else: estimate was optimistic; fall through to chunking
  }

  // 3. Chunking
  await opts.onProgress?.('chunking source', 0, 1);
  const targetChunkSize = Math.max(1, Math.floor(chunkSize * TOKENIZER_SAFETY_FACTOR));
  const chunks = await splitToChunks(opts.source, {
    chunkSize: targetChunkSize,
    chunkOverlap: Math.min(chunkOverlap, targetChunkSize - 1),
    countTokens: (t) => opts.backend.countTokens(t),
  });
  throwIfAborted(opts.signal);
  if (chunks.length > maxChunks) {
    throw new Error(
      `Input produces ${chunks.length} chunks at chunk size ${chunkSize}, ` +
        `exceeding max_chunks=${maxChunks}. Either raise OMCP_CHUNK_SIZE or split the source.`,
    );
  }
  if (chunks.length === 0) {
    // Defensive — splitter shouldn't return empty for non-empty input,
    // but if source was whitespace-only the fast-path's countTokens() returned 0.
    return {
      text: '',
      chunksProcessed: 0,
      reduceDepth: 0,
      partial: false,
      chunksFailed: 0,
      reduceFailed: 0,
      promptTokens: 0,
      completionTokens: 0,
    };
  }
  if (chunks.length === 1) {
    // Single chunk that didn't fit the fast-path budget — go straight
    // through the MAP system (per-chunk wording) and skip REDUCE.
    return runSingleChunk(chunks[0]!, opts);
  }

  // 4. MAP phase
  const mapResult = await runMapPhase(chunks, concurrency, opts);

  // 5. REDUCE phase
  const reduceResult = await reduceRecursive(mapResult.summaries, 1, concurrency, opts);

  return {
    text: reduceResult.text,
    chunksProcessed: chunks.length,
    reduceDepth: reduceResult.depth,
    partial: reduceResult.partial,
    chunksFailed: mapResult.failed,
    reduceFailed: reduceResult.reduceFailed,
    promptTokens: mapResult.promptTokens + reduceResult.promptTokens,
    completionTokens: mapResult.completionTokens + reduceResult.completionTokens,
  };
}

// ── Phases ──────────────────────────────────────────────────────────────────

async function runFastPath(
  opts: ChunkedSummarizeOptions,
): Promise<ChunkedSummarizeResult> {
  await opts.onProgress?.('fast-path: input fits in one call', 1, 1);
  const callSignal = AbortSignal.any([
    opts.signal,
    AbortSignal.timeout(FAST_PATH_TIMEOUT_MS),
  ]);
  const r = await opts.backend.chat(
    {
      system: FAST_PATH_SYSTEM,
      user: fastPathUserPrompt(opts.source, opts.style),
      temperature: 0.2,
      maxInputTokens: opts.maxInputTokens,
    },
    callSignal,
  );
  return {
    text: r.text.trim(),
    chunksProcessed: 1,
    reduceDepth: 0,
    partial: false,
    chunksFailed: 0,
    reduceFailed: 0,
    promptTokens: r.promptTokens,
    completionTokens: r.completionTokens,
  };
}

async function runSingleChunk(
  chunk: string,
  opts: ChunkedSummarizeOptions,
): Promise<ChunkedSummarizeResult> {
  await opts.onProgress?.('single chunk: no reduce needed', 1, 1);
  const callSignal = AbortSignal.any([
    opts.signal,
    AbortSignal.timeout(PER_CALL_TIMEOUT_MS),
  ]);
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const r = await opts.backend.chat(
    {
      system: MAP_SYSTEM,
      user: mapUserPrompt(chunk, 1, 1),
      temperature: 0.2,
      maxInputTokens: chunkSize + PROMPT_OVERHEAD_TOKENS,
      maxOutputTokens: MAP_OUTPUT_BUDGET,
    },
    callSignal,
  );
  return {
    text: r.text.trim(),
    chunksProcessed: 1,
    reduceDepth: 0,
    partial: false,
    chunksFailed: 0,
    reduceFailed: 0,
    promptTokens: r.promptTokens,
    completionTokens: r.completionTokens,
  };
}

interface MapResult {
  summaries: string[];
  failed: number;
  promptTokens: number;
  completionTokens: number;
}

async function runMapPhase(
  chunks: string[],
  concurrency: number,
  opts: ChunkedSummarizeOptions,
): Promise<MapResult> {
  const limit = pLimit(concurrency);
  let promptTokens = 0;
  let completionTokens = 0;
  let failed = 0;
  let done = 0;
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
  await opts.onProgress?.(
    `MAP: ${chunks.length} chunks, concurrency ${concurrency}`,
    0,
    chunks.length,
  );

  const summaries = await Promise.all(
    chunks.map((chunk, idx) =>
      limit(async () => {
        // Queue-drain guard — p-limit does not auto-cancel pending closures
        // when the shared AbortSignal aborts. Without this, an MCP client
        // disconnect would still drain the entire queue doing useless work.
        throwIfAborted(opts.signal);
        const callSignal = AbortSignal.any([
          opts.signal,
          AbortSignal.timeout(PER_CALL_TIMEOUT_MS),
        ]);
        try {
          const r = await opts.backend.chat(
            {
              system: MAP_SYSTEM,
              user: mapUserPrompt(chunk, idx + 1, chunks.length),
              temperature: 0.2,
              maxInputTokens: chunkSize + PROMPT_OVERHEAD_TOKENS,
              maxOutputTokens: MAP_OUTPUT_BUDGET,
            },
            callSignal,
          );
          promptTokens += r.promptTokens;
          completionTokens += r.completionTokens;
          done++;
          await opts.onProgress?.(
            `MAP: ${done}/${chunks.length}`,
            done,
            chunks.length,
          );
          return r.text.trim();
        } catch (err) {
          // Distinguish job-level cancel (re-throw, exit cleanly) from
          // local 50 s timeout / backend error (substitute placeholder,
          // continue). The check is `jobSignal.aborted` — local timeouts
          // abort callSignal but not jobSignal.
          if (opts.signal.aborted) {
            throw opts.signal.reason ?? err;
          }
          failed++;
          done++;
          const reason =
            err instanceof Error
              ? err.name === 'TimeoutError'
                ? 'call timed out'
                : err.message
              : 'unknown error';
          return `[Chunk ${idx + 1}: summary unavailable — ${reason}]`;
        }
      }),
    ),
  );

  return { summaries, failed, promptTokens, completionTokens };
}

interface ReduceResult {
  text: string;
  depth: number;
  partial: boolean;
  /** REDUCE-phase calls that errored or timed out and were substituted with placeholders. */
  reduceFailed: number;
  promptTokens: number;
  completionTokens: number;
}

async function reduceRecursive(
  summaries: string[],
  currentDepth: number,
  concurrency: number,
  opts: ChunkedSummarizeOptions,
): Promise<ReduceResult> {
  const labeled = summaries.map((s, i) => `[Chunk ${i + 1}]\n${s}`);
  const joined = labeled.join('\n\n');
  const inputTokens = await opts.backend.countTokens(joined);
  throwIfAborted(opts.signal);

  const fitsInOneCall =
    inputTokens + PROMPT_OVERHEAD_TOKENS <= REDUCE_BUCKET_TOKENS;

  if (fitsInOneCall) {
    await opts.onProgress?.(
      `REDUCE: pass ${currentDepth} (final, ${inputTokens} tokens)`,
      currentDepth,
      currentDepth,
    );
    const callSignal = AbortSignal.any([
      opts.signal,
      AbortSignal.timeout(PER_CALL_TIMEOUT_MS),
    ]);
    try {
      const r = await opts.backend.chat(
        {
          system: REDUCE_SYSTEM,
          user: reduceUserPrompt(joined, opts.style),
          temperature: 0.2,
          maxInputTokens: REDUCE_BUCKET_TOKENS + PROMPT_OVERHEAD_TOKENS,
          maxOutputTokens: REDUCE_OUTPUT_BUDGET,
        },
        callSignal,
      );
      return {
        text: r.text.trim(),
        depth: currentDepth,
        partial: false,
        reduceFailed: 0,
        promptTokens: r.promptTokens,
        completionTokens: r.completionTokens,
      };
    } catch (err) {
      // Terminal reduce failure (typically PER_CALL_TIMEOUT_MS or backend
      // error). Distinguish job-cancel (re-throw) from local error
      // (degrade gracefully: return chunk summaries joined, marked partial).
      // Without this fallback, a single bad terminal call discards every
      // successful MAP-phase result.
      if (opts.signal.aborted) {
        throw opts.signal.reason ?? err;
      }
      const reason =
        err instanceof Error
          ? err.name === 'TimeoutError'
            ? 'final reduce timed out'
            : err.message
          : 'unknown error';
      return {
        text:
          `[Final reduce unavailable — ${reason}. Chunk summaries follow:]\n\n` +
          joined,
        depth: currentDepth,
        partial: true,
        reduceFailed: 1,
        promptTokens: 0,
        completionTokens: 0,
      };
    }
  }

  if (currentDepth >= MAX_RECURSION_DEPTH) {
    // Last-resort partial: reduce the FIRST bucket (intro / primary thesis,
    // typically the most important part of the document) and mark
    // partial=true. Selecting the last bucket would drop the introduction
    // and surface mainly appendices/footnotes — the worst possible
    // tradeoff for a summarization tool.
    await opts.onProgress?.(
      `REDUCE: max depth ${MAX_RECURSION_DEPTH} reached, returning partial`,
      currentDepth,
      currentDepth,
    );
    const truncated = await packIntoBuckets(
      labeled,
      REDUCE_BUCKET_TOKENS - PROMPT_OVERHEAD_TOKENS,
      opts.backend,
    );
    const firstBucket = truncated[0] ?? joined;
    const callSignal = AbortSignal.any([
      opts.signal,
      AbortSignal.timeout(PER_CALL_TIMEOUT_MS),
    ]);
    try {
      const r = await opts.backend.chat(
        {
          system:
            REDUCE_SYSTEM +
            '\n\nNote: this is a partial summary; some content may be omitted.',
          user: reduceUserPrompt(firstBucket, opts.style),
          temperature: 0.2,
          maxInputTokens: REDUCE_BUCKET_TOKENS + PROMPT_OVERHEAD_TOKENS,
          maxOutputTokens: REDUCE_OUTPUT_BUDGET,
        },
        callSignal,
      );
      return {
        text: r.text.trim(),
        depth: currentDepth,
        partial: true,
        reduceFailed: 0,
        promptTokens: r.promptTokens,
        completionTokens: r.completionTokens,
      };
    } catch (err) {
      // Same graceful-degradation pattern as the fitsInOneCall path.
      if (opts.signal.aborted) {
        throw opts.signal.reason ?? err;
      }
      const reason =
        err instanceof Error
          ? err.name === 'TimeoutError'
            ? 'final partial-reduce timed out'
            : err.message
          : 'unknown error';
      return {
        text:
          `[Could not reduce — ${reason}. Showing first bucket of summaries:]\n\n` +
          firstBucket,
        depth: currentDepth,
        partial: true,
        reduceFailed: 1,
        promptTokens: 0,
        completionTokens: 0,
      };
    }
  }

  // Pack labeled summaries into buckets of ≤ (REDUCE_BUCKET_TOKENS - overhead) tokens
  const buckets = await packIntoBuckets(
    labeled,
    REDUCE_BUCKET_TOKENS - PROMPT_OVERHEAD_TOKENS,
    opts.backend,
  );
  await opts.onProgress?.(
    `REDUCE: pass ${currentDepth} of ${buckets.length} buckets`,
    currentDepth,
    MAX_RECURSION_DEPTH,
  );

  // Reduce each bucket in parallel (with same concurrency cap as MAP)
  const limit = pLimit(concurrency);
  let promptTokens = 0;
  let completionTokens = 0;
  let bucketsFailed = 0;
  const bucketSummaries = await Promise.all(
    buckets.map((bucket, idx) =>
      limit(async () => {
        throwIfAborted(opts.signal);
        const callSignal = AbortSignal.any([
          opts.signal,
          AbortSignal.timeout(PER_CALL_TIMEOUT_MS),
        ]);
        try {
          const r = await opts.backend.chat(
            {
              system: REDUCE_SYSTEM,
              user: reduceUserPrompt(bucket, opts.style),
              temperature: 0.2,
              maxInputTokens: REDUCE_BUCKET_TOKENS + PROMPT_OVERHEAD_TOKENS,
              // Intermediate reduces use MAP-sized output (terser);
              // final-pass output uses the larger budget.
              maxOutputTokens: MAP_OUTPUT_BUDGET,
            },
            callSignal,
          );
          promptTokens += r.promptTokens;
          completionTokens += r.completionTokens;
          return r.text.trim();
        } catch (err) {
          if (opts.signal.aborted) {
            throw opts.signal.reason ?? err;
          }
          bucketsFailed++;
          const reason =
            err instanceof Error
              ? err.name === 'TimeoutError'
                ? 'reduce timed out'
                : err.message
              : 'unknown error';
          return `[Bucket ${idx + 1}: reduce unavailable — ${reason}]`;
        }
      }),
    ),
  );

  // Recurse on bucket summaries
  const inner = await reduceRecursive(
    bucketSummaries,
    currentDepth + 1,
    concurrency,
    opts,
  );
  return {
    text: inner.text,
    depth: inner.depth,
    partial: inner.partial,
    reduceFailed: bucketsFailed + inner.reduceFailed,
    promptTokens: promptTokens + inner.promptTokens,
    completionTokens: completionTokens + inner.completionTokens,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Greedy bucket packing: append entries to the current bucket until it
 * would exceed `bucketBudget` tokens, then start a new bucket. An entry
 * larger than the budget gets its own bucket (potentially exceeding
 * `bucketBudget` — caller is expected to surface this case via a higher-
 * level cap; in practice MAP_OUTPUT_BUDGET = 400 ≪ REDUCE_BUCKET_TOKENS).
 *
 * Token-counting for all entries runs in parallel via Promise.all before
 * the synchronous greedy pass — for 100 chunks this saves ~99 × per-call
 * tokenizer overhead compared to a sequential await loop.
 */
async function packIntoBuckets(
  entries: string[],
  bucketBudget: number,
  backend: LlmBackend,
): Promise<string[]> {
  const tokenCounts = await Promise.all(entries.map((e) => backend.countTokens(e)));
  const buckets: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const t = tokenCounts[i]!;
    if (current.length > 0 && currentTokens + t > bucketBudget) {
      buckets.push(current.join('\n\n'));
      current = [entry];
      currentTokens = t;
    } else {
      current.push(entry);
      currentTokens += t;
    }
  }
  if (current.length > 0) {
    buckets.push(current.join('\n\n'));
  }
  return buckets;
}

/** Throw the signal's reason (or a generic abort error) if the signal is aborted. */
function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason ?? new Error('aborted');
  }
}
