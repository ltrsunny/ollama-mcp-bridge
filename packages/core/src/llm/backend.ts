/**
 * LlmBackend — neutral contract for any local-LLM backend.
 *
 * v0.2.0 ships only one implementation (`OllamaBackend`). v0.3.0 will add
 * `LlamaCppBackend`. The interface is deliberately narrow: anything
 * Ollama-specific (keep-alive, the qwen3 `think` flag, native option names
 * like `num_ctx`) belongs in the concrete class, not on the interface.
 *
 * See docs/scope-memos/v0.2.0-backend-abstraction-and-chunked-summarize.md §3.
 */

/** JSON Schema-like object for grammar-constrained output. */
export type JsonSchemaLike = Record<string, unknown>;

export interface ChatOptions {
  /** Optional system prompt. */
  system?: string;
  /** User prompt (always required). */
  user: string;
  /** Sampling temperature. 0 = deterministic. */
  temperature?: number;
  /**
   * Max tokens the backend should admit from the prompt.
   * Maps to: Ollama `num_ctx`, llama.cpp `-c` / per-slot context size.
   * This is a per-call budget, not a model-load-time parameter — backends
   * with a load-time ceiling (llama-server) MUST verify the call's value
   * is within their loaded ceiling.
   */
  maxInputTokens: number;
  /** Max tokens to generate. Absent = backend default. */
  maxOutputTokens?: number;
  /**
   * Grammar-constrained output schema. Interface takes JSON Schema; concrete
   * backends adapt to their native format (Ollama: `format:`, llama.cpp:
   * GBNF — translation is the v0.3.0 LlamaCppBackend's responsibility).
   */
  format?: JsonSchemaLike;
  // NOTE: `stopSequences` deferred until a real consumer needs it. v0.3.0
  // LlamaCppBackend may surface it; until then keep the interface minimal.
}

export interface ChatResult {
  text: string;
  /** Tokens used to encode the prompt (Ollama: `prompt_eval_count`). */
  promptTokens: number;
  /** Tokens generated in the completion (Ollama: `eval_count`). */
  completionTokens: number;
}

export interface LlmBackend {
  /** Identifier surfaced in telemetry, e.g. `ollama:qwen2.5:7b`. */
  readonly modelId: string;

  /**
   * Run a chat-style completion.
   *
   * Implementations MUST honor `signal.aborted` and abort any in-flight work
   * when the signal fires. Long-running chunked jobs rely on this to clean up
   * when the MCP client disconnects (the @modelcontextprotocol/sdk passes a
   * client-cancellation signal to every request handler via `extra.signal`).
   *
   * Per-call timeouts should chain via `AbortSignal.any([jobSignal,
   * AbortSignal.timeout(ms)])` at the call site so a chunk timeout doesn't
   * propagate to the whole job.
   */
  chat(opts: ChatOptions, signal?: AbortSignal): Promise<ChatResult>;

  /**
   * Count tokens in `text` according to *this backend's* tokenizer.
   *
   * Implementations MAY return an approximate count; the docstring on each
   * implementation MUST declare whether the result is exact or proxy.
   * Callers (e.g. the chunker) assume up to ±15 % drift on proxy
   * implementations and apply a safety margin (typically × 0.85 on chunk-size
   * targets).
   *
   * Implementations of this method MUST yield to the event loop periodically
   * on large inputs so that MCP keep-alive responses are not blocked.
   */
  countTokens(text: string): Promise<number>;

  /** Lightweight liveness check. Throws if the backend is unreachable. */
  ping(): Promise<void>;
}
