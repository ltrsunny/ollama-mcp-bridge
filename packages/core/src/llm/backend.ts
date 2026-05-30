/**
 * LlmBackend — neutral contract for local-LLM backends.
 *
 * The sole current implementation is `MlxHttpBackend`. The interface is
 * deliberately narrow: anything backend-specific (server options, native
 * option names, model-load parameters) belongs in the concrete class, not
 * here.
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
   * This is a per-call budget hint; the server-side model context is fixed
   * at load time. Used by the chunker's safety margin and tool maxInputTokens.
   */
  maxInputTokens: number;
  /** Max tokens to generate. Absent = backend default. */
  maxOutputTokens?: number;
  /**
   * Grammar-constrained output schema. Interface takes JSON Schema; the
   * backend adapts to its native format. `MlxHttpBackend` sends
   * `response_format: { type: "json_schema", strict: true }` to oMLX,
   * which enforces the schema at decode time.
   */
  format?: JsonSchemaLike;
  /**
   * Disable the model's reasoning trace (e.g. Qwen3 thinking-mode
   * `<think>...</think>` output). When `true`, MlxHttpBackend appends
   * `/no_think` to the user prompt; when `false`, the prompt is left
   * alone and the model is free to reason. When `undefined`, falls back
   * to the env var `OMCP_THINKING_MODE`.
   *
   * server.ts computes this via the per-tool registry in
   * `src/config/thinking-defaults.ts` so callers don't have to
   * know which models are thinking-capable. See scope memo v0.6.0 §4.
   */
  disableThinking?: boolean;
  // NOTE: `stopSequences` deferred until a real consumer needs it; keep the interface minimal.
}

export interface ChatResult {
  text: string;
  /** Tokens used to encode the prompt (from response `usage.prompt_tokens`). */
  promptTokens: number;
  /** Tokens generated in the completion (from response `usage.completion_tokens`). */
  completionTokens: number;
}

export interface LlmBackend {
  /** Identifier surfaced in telemetry, e.g. `mlx-http:Qwen3-4B-Instruct-2507-4bit`. */
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
