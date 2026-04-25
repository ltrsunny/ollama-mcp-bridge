/**
 * OllamaBackend — `LlmBackend` implementation that forwards to a local
 * Ollama daemon via the existing `OllamaClient`.
 *
 * Ollama-specific concerns kept here, not on the `LlmBackend` interface:
 *   - `keepAlive` (Ollama process-lifecycle hint, no llama.cpp analogue)
 *   - `think` (Qwen3-specific reasoning toggle)
 *   - mapping `maxInputTokens` → `num_ctx`, `maxOutputTokens` → `num_predict`
 *
 * Token counting uses `js-tiktoken` (cl100k_base) as a proxy. Real Qwen /
 * Llama tokenizers drift ~±15 % from cl100k. The chunker's × 0.85 safety
 * margin absorbs this. v0.3.0's `LlamaCppBackend` will use llama-server's
 * exact `/tokenize` endpoint to remove the proxy.
 */

import { getEncoding, type Tiktoken } from 'js-tiktoken';
import type { LlmBackend, ChatOptions, ChatResult } from './backend.js';
import type { OllamaClient } from '../ollama/client.js';

/**
 * Byte slice used for streaming tokenization. js-tiktoken's `encode()` is
 * synchronous and non-interruptible, so we slice the input string into
 * segments, encode each, and yield via `setImmediate` between segments to
 * keep the Node event loop responsive (and the MCP transport's keep-alives
 * flowing) on large inputs.
 *
 * 20 KB ≈ 5 000–7 000 cl100k tokens — small enough that one `encode()` call
 * stays under ~10 ms on the target hardware, large enough that the per-slice
 * overhead is amortized.
 */
const TOKENIZER_SEGMENT_BYTES = 20_000;

/** Lazily-initialized cl100k_base encoder, shared across all instances. */
let _encoder: Tiktoken | null = null;
function getCl100kEncoder(): Tiktoken {
  if (_encoder === null) {
    _encoder = getEncoding('cl100k_base');
  }
  return _encoder;
}

export interface OllamaBackendOptions {
  /** The model tag to invoke, e.g. `qwen2.5:7b`. */
  modelTag: string;
  /** Ollama `keep_alive` parameter (seconds, duration string, or -1 forever). */
  keepAlive?: string | number;
  /**
   * Qwen3 hybrid-reasoning toggle. Default `false` — the bridge's whole
   * point is fast cheap delegation; thinking models burn minutes on
   * trivial tasks. Opt in per-tier if the model needs it.
   */
  think?: boolean | 'low' | 'medium' | 'high';
}

export class OllamaBackend implements LlmBackend {
  constructor(
    private readonly client: OllamaClient,
    private readonly opts: OllamaBackendOptions,
  ) {}

  get modelId(): string {
    return `ollama:${this.opts.modelTag}`;
  }

  async chat(opts: ChatOptions, signal?: AbortSignal): Promise<ChatResult> {
    return this.client.chat({
      model: this.opts.modelTag,
      keepAlive: this.opts.keepAlive,
      think: this.opts.think ?? false,
      numCtx: opts.maxInputTokens,
      numPredict: opts.maxOutputTokens,
      system: opts.system,
      user: opts.user,
      temperature: opts.temperature,
      format: opts.format,
      signal,
    });
  }

  /**
   * Approximate token count using cl100k_base as a proxy.
   *
   * Strategy: slice the raw string into ~20 KB segments, encode each segment,
   * sum, and yield to the event loop between segments via `setImmediate`.
   * This keeps individual blocking spans under ~10 ms on the target hardware
   * even for 100 K-token documents.
   *
   * Boundary effects (a multibyte character or multi-character token
   * straddling two slices) introduce ≤ ±2 % miscount on top of the ±15 %
   * tokenizer-proxy drift — both absorbed by the chunker's × 0.85 safety
   * margin on chunk-size targets.
   */
  async countTokens(text: string): Promise<number> {
    if (text.length === 0) return 0;
    const enc = getCl100kEncoder();
    let total = 0;
    for (let i = 0; i < text.length; i += TOKENIZER_SEGMENT_BYTES) {
      total += enc.encode(text.slice(i, i + TOKENIZER_SEGMENT_BYTES)).length;
      if (i + TOKENIZER_SEGMENT_BYTES < text.length) {
        await new Promise<void>((r) => setImmediate(r));
      }
    }
    return total;
  }

  async ping(): Promise<void> {
    await this.client.ping();
  }
}
