/**
 * MlxHttpBackend — `LlmBackend` implementation that delegates inference to a
 * local oMLX inference server over HTTP.
 *
 * oMLX exposes an OpenAI-compatible `/v1/chat/completions` endpoint backed
 * by MLX weights running on Apple Silicon. See
 * `docs/scope-memos/v0.5.0-tier-d-eval-2026-05-06.md` §D3 for benchmark
 * data and integration rationale.
 *
 * Lifecycle: oMLX is managed independently of the Node MCP host. Start it
 * before launching the bridge:
 *   brew services start jundot/omlx/omlx
 *
 * Concurrency: each `chat()` call is a separate HTTP request; oMLX
 * serializes them (one generation at a time on Metal).
 *
 * Token counting: approximate — the exact tokenizer is not exposed over
 * HTTP. Returns `Math.ceil(text.length / 3.5)` (±15 % vs exact). The
 * chunker applies a safety margin on top of proxy counts, so this is safe.
 *
 * Grammar-constrained output: when `opts.format` (JSON Schema) is set,
 * the backend sends `response_format: { type: "json_schema", strict: true }`.
 * oMLX enforces the schema at decode time (enum constraints binding, required
 * fields produced), making it the unified backend for classify and extract tools.
 *
 * See: docs/scope-memos/v0.5.0-tier-d-eval-2026-05-06.md
 */

import type { LlmBackend, ChatOptions, ChatResult } from './backend.js';

export interface MlxHttpBackendOptions {
  /**
   * Base URL of the MLX bridge server, e.g. `"http://127.0.0.1:8080"`.
   * No trailing slash.
   */
  baseUrl: string;
  /**
   * Context window size passed to the server in the request. Informational
   * only — the server-side model's context is fixed at load time. Used for
   * the `modelId` label and telemetry.
   */
  numCtx?: number;
  /**
   * Model name to pass in the `model` field of each OpenAI request.
   *
   * - Required by oMLX for model routing by name.
   * - When omitted, auto-detected on first request via `GET /v1/models`
   *   and cached for the backend lifetime.
   */
  modelName?: string;
  /**
   * @internal Override the circuit-breaker total wait budget (default 5000 ms).
   * Used by tests to keep the "never recovers" path under vitest's 5s timeout.
   */
  _restartPollBudgetMs?: number;
  /**
   * @internal Override the circuit-breaker poll interval (default 200 ms).
   */
  _restartPollIntervalMs?: number;
}

/** Shape of the OpenAI-compatible request sent to the bridge server. */
interface OpenAIChatRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  max_tokens?: number;
  temperature?: number;
  response_format?:
    | { type: 'text' | 'json_object' }
    | {
        type: 'json_schema';
        json_schema: {
          name: string;
          strict: true;
          schema: Record<string, unknown>;
        };
      };
}

/** Minimal subset of OpenAI response we consume. */
interface OpenAIChatResponse {
  choices: Array<{
    message: { content: string };
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
  };
}

/**
 * Normalize a JSON Schema for OpenAI Structured Outputs strict mode.
 *
 * oMLX strict mode requires every object node to satisfy:
 *   1. `additionalProperties: false`
 *   2. `required` lists every key in `properties`
 *
 * Without these, oMLX silently falls back to non-strict mode and the model
 * output is unconstrained — exactly the bug the strict mode was meant to
 * prevent. This helper walks the schema and patches every object node —
 * including nullable union types (`type: ["object", "null"]`) — in-place on a
 * deep clone, so the caller's schema is unchanged.
 *
 * Recurses into every applicator position (`properties`, `items`,
 * `prefixItems`, `anyOf`/`oneOf`/`allOf`, `$defs`, …) so nested AND sibling
 * subschemas are all tightened; only applicator keywords are walked, so
 * data-bearing `enum`/`const`/`default` values are never mutated. `$ref` is
 * left alone (oMLX resolves refs; the extract path rejects `$ref` upstream in
 * `sanitizeSchemaForStrictMode`); pattern / format are not strict-mode concerns.
 */
export function normalizeForStrictMode(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const cloned = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;

  // A node is an "object node" if its `type` is "object" OR a union that
  // includes "object" (e.g. a nullable object: `type: ["object", "null"]`).
  const isObjectType = (t: unknown): boolean =>
    t === 'object' || (Array.isArray(t) && t.includes('object'));

  // Applicator keywords that hold sub-schemas. We recurse ONLY into these (an
  // allow-list) and never into data-bearing keywords (enum/const/default/
  // examples), so literal values are never mutated.
  const SUBSCHEMA = ['items', 'additionalProperties', 'propertyNames', 'contains', 'not', 'if', 'then', 'else'];
  const SUBSCHEMA_ARRAY = ['prefixItems', 'anyOf', 'oneOf', 'allOf'];
  const SUBSCHEMA_MAP = ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'];

  const visit = (node: unknown): void => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
    const obj = node as Record<string, unknown>;

    // Tighten object nodes in place. The old `obj['type'] === 'object'` check
    // silently skipped nullable union types, leaving that subtree unconstrained.
    if (isObjectType(obj['type']) && obj['properties'] && typeof obj['properties'] === 'object') {
      obj['additionalProperties'] = false;
      obj['required'] = Object.keys(obj['properties'] as Record<string, unknown>);
    }

    // Recurse into EVERY sub-schema position — independent of this node's type,
    // not mutually exclusive with the tighten above. The previous
    // if/else-if/else made the object/array/other branches exclusive, so
    // sibling combinators (anyOf/oneOf/allOf) and `prefixItems` co-located on an
    // object or array node were never visited and decoded unconstrained
    // (code-review E1-E3).
    for (const key of SUBSCHEMA) {
      const v = obj[key];
      if (v && typeof v === 'object' && !Array.isArray(v)) visit(v);
    }
    for (const key of SUBSCHEMA_ARRAY) {
      const arr = obj[key];
      if (Array.isArray(arr)) for (const child of arr) visit(child);
    }
    for (const key of SUBSCHEMA_MAP) {
      const m = obj[key];
      if (m && typeof m === 'object' && !Array.isArray(m)) {
        for (const v of Object.values(m as Record<string, unknown>)) visit(v);
      }
    }
  };

  visit(cloned);
  return cloned;
}

export class MlxHttpBackend implements LlmBackend {
  /**
   * Circuit-breaker constants for the oMLX-aborted-mid-request recovery
   * path. See `chat()` doc-comment and
   * `docs/notes/v0.5.x-omlx-stability-2026-05-11.md` for the failure
   * mode this protects against.
   */
  private static readonly RESTART_POLL_INTERVAL_MS = 200;
  private static readonly RESTART_POLL_BUDGET_MS = 5000;

  /**
   * Substrings on `Error.message` / `Error.code` / `Error.cause.*` that we
   * treat as "server died mid-request" — i.e. eligible for one circuit-
   * breaker retry after the launchd-managed oMLX has restarted. Anything
   * else propagates unchanged (HTTP 4xx/5xx, authentic JSON parse errors
   * on a complete response body, etc.).
   *
   * Two failure modes observed in production (oMLX SIGABRT mid-request):
   *   1. `fetch()` itself rejects before any response — undici raises
   *      `TypeError: fetch failed` with cause `{ code: 'ECONNRESET' }`
   *      or `{ code: 'UND_ERR_SOCKET' }`.
   *   2. Response headers arrive, then `response.json()` aborts mid-stream
   *      with `TypeError: terminated` (undici 6+ wording for a connection
   *      that was severed mid-body). Our `_chatOnce` wraps this as
   *      "MlxHttpBackend: failed to parse JSON response — terminated";
   *      `"terminated"` covers both the unwrapped and wrapped forms.
   *
   * Deliberately NOT included: our own "MlxHttpBackend: network error — …"
   * wrapper text. If we matched that we'd retry on every fetch failure
   * (TLS handshake, DNS, etc.), defeating the narrow purpose of the breaker.
   */
  private static readonly CONNECTION_RESET_MARKERS = [
    'ECONNRESET',
    'ECONNREFUSED',
    'socket hang up',
    'UND_ERR_SOCKET',
    'fetch failed', // Node 22 undici outer message for socket-level aborts
    'terminated', // undici 6+ wording for stream aborted mid-body (oMLX SIGABORT during decode)
  ];

  private readonly baseUrl: string;
  private readonly configuredModelName?: string;
  /** Cached after first auto-detect or set from configuredModelName. */
  private resolvedModelName?: string;
  private readonly restartPollBudgetMs: number;
  private readonly restartPollIntervalMs: number;

  constructor(opts: MlxHttpBackendOptions) {
    // Normalise: strip trailing slash once so every endpoint path is clean.
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.configuredModelName = opts.modelName;
    this.restartPollBudgetMs =
      opts._restartPollBudgetMs ?? MlxHttpBackend.RESTART_POLL_BUDGET_MS;
    this.restartPollIntervalMs =
      opts._restartPollIntervalMs ?? MlxHttpBackend.RESTART_POLL_INTERVAL_MS;
    // numCtx is informational — stored in TierConfig, not needed at call time
    // (server-side context is fixed at model load). Not retained here.
  }

  get modelId(): string {
    // Include resolved model name when available; fall back to base URL alone.
    const model = this.resolvedModelName ?? this.configuredModelName;
    return model ? `mlx-http:${this.baseUrl}/${model}` : `mlx-http:${this.baseUrl}`;
  }

  /**
   * Return the model name to pass in OpenAI requests.
   *
   * If `modelName` was supplied at construction time, use it directly.
   * Otherwise, query `GET /v1/models`, pick the first entry, and cache it
   * so subsequent calls skip the round-trip.
   */
  private async resolveModelName(): Promise<string> {
    if (this.resolvedModelName) return this.resolvedModelName;
    if (this.configuredModelName) {
      this.resolvedModelName = this.configuredModelName;
      return this.resolvedModelName;
    }
    // Auto-detect from server.
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/models`, { method: 'GET' });
    } catch (err) {
      throw new Error(
        `MlxHttpBackend: /v1/models unreachable — ${(err as Error).message}`,
      );
    }
    if (!res.ok) {
      throw new Error(`MlxHttpBackend: /v1/models returned ${res.status}`);
    }
    const data = (await res.json()) as { data?: Array<{ id: string }> };
    const first = data.data?.[0]?.id;
    if (!first) {
      throw new Error('MlxHttpBackend: /v1/models returned empty list');
    }
    this.resolvedModelName = first;
    return this.resolvedModelName;
  }

  /**
   * Run a chat-style completion against the MLX bridge server.
   *
   * Honors the AbortSignal by passing it to `fetch`.  If the server returns
   * a non-2xx status, throws with the status + body for debuggability.
   *
   * **Circuit breaker**: when fetch fails with a connection-reset class
   * error (ECONNRESET / socket hang up / "fetch failed") — the symptom of
   * oMLX aborting mid-request while launchd auto-restarts it (see
   * `docs/notes/v0.5.x-omlx-stability-2026-05-11.md`) — this poll-pings
   * `/health` for up to 5s and, on recovery, retries the request exactly
   * once. Other errors (HTTP 4xx/5xx, JSON parse, user-aborted signal,
   * authentic refusals) propagate unchanged.
   *
   * This makes oMLX crashes recoverable from the caller's perspective at
   * a ~5s worst-case latency tax, instead of a connection-reset error.
   */
  async chat(opts: ChatOptions, signal?: AbortSignal): Promise<ChatResult> {
    try {
      return await this._chatOnce(opts, signal);
    } catch (err) {
      // User-cancelled abort wins over circuit-breaker — don't second-guess
      // the caller's intent.
      if (signal?.aborted) throw err;
      if (!MlxHttpBackend.isConnectionResetError(err)) throw err;

      // oMLX likely SIGABORTed; launchd will restart. Wait briefly, then
      // retry once. If still down or the retry also drops, the second
      // error propagates as-is — we don't retry indefinitely.
      //
      // Telemetry: each retry writes one structured line to stderr so the
      // breaker doesn't hide ongoing upstream instability. Users can
      // count occurrences with e.g. `grep -c "circuit-breaker:" stderr.log`
      // to monitor crash frequency over time.
      const marker = MlxHttpBackend.firstMatchingMarker(err);
      const startedAt = Date.now();
      process.stderr.write(
        `[bridge] circuit-breaker: triggered marker=${marker} model=${this.resolvedModelName ?? 'unresolved'}\n`,
      );
      try {
        await this.waitForRestart(signal);
        const result = await this._chatOnce(opts, signal);
        process.stderr.write(
          `[bridge] circuit-breaker: outcome=retry-ok wait_ms=${Date.now() - startedAt} marker=${marker}\n`,
        );
        return result;
      } catch (retryErr) {
        process.stderr.write(
          `[bridge] circuit-breaker: outcome=${
            signal?.aborted ? 'aborted-during-wait' : 'did-not-recover'
          } wait_ms=${Date.now() - startedAt} marker=${marker}\n`,
        );
        throw retryErr;
      }
    }
  }

  /**
   * The actual single HTTP attempt — used by `chat()` and its retry path.
   * Same observable behavior as the pre-circuit-breaker implementation.
   */
  private async _chatOnce(opts: ChatOptions, signal?: AbortSignal): Promise<ChatResult> {
    if (signal?.aborted) {
      throw new Error('MlxHttpBackend: aborted before fetch');
    }

    const messages: Array<{ role: string; content: string }> = [];
    if (opts.system !== undefined) {
      messages.push({ role: 'system', content: opts.system });
    }
    // Append `/no_think` to user content when reasoning trace must be
    // suppressed. Qwen3 thinking models (8B, 14B) honor this token to
    // disable the `<think>...</think>` reasoning trace; non-thinking models
    // (Qwen3-4B-Instruct-2507, Mistral, Phi-4) treat it as inert text.
    //
    // Resolution order:
    //   1. Explicit per-call `opts.disableThinking` (computed by server.ts
    //      via `src/config/thinking-defaults.ts` resolver) — authoritative
    //      when present.
    //   2. Env-var fallback `OMCP_THINKING_MODE=on` — used when the
    //      caller doesn't compute via resolver (e.g. tests, eval harness).
    //   3. Otherwise: suppress (append `/no_think`) — safe default.
    //
    // Why suppress-by-default: oMLX puts the trace in a separate
    // `reasoning_content` field that doesn't burn our MAX_OUTPUT_TOKENS cap,
    // but it adds 30-80 s wall-clock — risks Claude Code's 60 s MCP wall on
    // longer tasks.
    let thinkingOn: boolean;
    if (opts.disableThinking !== undefined) {
      thinkingOn = !opts.disableThinking;
    } else {
      thinkingOn = process.env['OMCP_THINKING_MODE'] === 'on';
    }
    const userContent = thinkingOn ? opts.user : `${opts.user}\n/no_think`;
    messages.push({ role: 'user', content: userContent });

    const modelName = await this.resolveModelName();

    const body: OpenAIChatRequest = {
      model: modelName,
      messages,
      temperature: opts.temperature ?? 0,
      ...(opts.maxOutputTokens !== undefined
        ? { max_tokens: opts.maxOutputTokens }
        : {}),
      // When a JSON Schema is provided, use OpenAI Structured Outputs strict
      // mode. Strict mode requires `additionalProperties: false` and `required:
      // <all properties>` on every object node — `normalizeForStrictMode`
      // injects these so callers can pass plain JSON Schema. oMLX enforces
      // the constraint at decode time via json_schema strict mode.
      ...(opts.format !== undefined
        ? {
            response_format: {
              type: 'json_schema' as const,
              json_schema: {
                name: 'response',
                strict: true as const,
                schema: normalizeForStrictMode(
                  opts.format as Record<string, unknown>,
                ),
              },
            },
          }
        : {}),
    };

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (signal?.aborted) {
        throw new Error('MlxHttpBackend: fetch aborted');
      }
      throw new Error(
        `MlxHttpBackend: network error — ${(err as Error).message}`,
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `MlxHttpBackend: server returned ${response.status} ${response.statusText}: ${text}`,
      );
    }

    let data: OpenAIChatResponse;
    try {
      data = (await response.json()) as OpenAIChatResponse;
    } catch (err) {
      throw new Error(
        `MlxHttpBackend: failed to parse JSON response — ${(err as Error).message}`,
      );
    }

    const text = data.choices?.[0]?.message?.content ?? '';
    const promptTokens = data.usage?.prompt_tokens ?? 0;
    const completionTokens = data.usage?.completion_tokens ?? 0;

    return { text, promptTokens, completionTokens };
  }

  /**
   * Approximate token count: `ceil(chars / 3.5)`.
   *
   * The exact tokenizer is not exposed over HTTP; approximation stays
   * within ±15 % for typical prose/code.  The chunker applies a 0.85
   * safety margin on top of proxy counts so this drift is acceptable.
   */
  async countTokens(text: string): Promise<number> {
    return Math.ceil(text.length / 3.5);
  }

  /**
   * Liveness check: GET /health.  Throws if the server is unreachable or
   * returns a non-2xx status.
   */
  async ping(): Promise<void> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/health`, { method: 'GET' });
    } catch (err) {
      throw new Error(
        `MlxHttpBackend: ping failed — server at ${this.baseUrl} is unreachable (${(err as Error).message})`,
      );
    }
    if (!response.ok) {
      throw new Error(
        `MlxHttpBackend: /health returned ${response.status} ${response.statusText}`,
      );
    }
  }

  /**
   * Returns true if the error looks like the connection was severed by
   * the *server* mid-request (as opposed to a 4xx/5xx response or a
   * client-side abort). Walks the `Error.cause` chain (Node 22's fetch
   * sometimes nests the underlying socket error one level deep).
   */
  private static isConnectionResetError(err: unknown): boolean {
    return MlxHttpBackend.firstMatchingMarker(err) !== null;
  }

  /**
   * Returns the first CONNECTION_RESET_MARKERS substring that appears in
   * the error's message or code chain (walking `cause` up to 4 levels),
   * or `null` if none match. Used both for the boolean check and for
   * telemetry attribution (which marker triggered the breaker).
   */
  private static firstMatchingMarker(err: unknown): string | null {
    let cur: unknown = err;
    for (let depth = 0; depth < 4 && cur != null && typeof cur === 'object'; depth++) {
      const msg = (cur as { message?: unknown }).message;
      const code = (cur as { code?: unknown }).code;
      const text = typeof msg === 'string' ? msg : '';
      const codeText = typeof code === 'string' ? code : '';
      const haystack = `${text} ${codeText}`;
      for (const m of MlxHttpBackend.CONNECTION_RESET_MARKERS) {
        if (haystack.includes(m)) return m;
      }
      cur = (cur as { cause?: unknown }).cause;
    }
    return null;
  }

  /**
   * Poll `/health` until oMLX answers or the budget runs out. Sleeps
   * `RESTART_POLL_INTERVAL_MS` between attempts. Respects the caller's
   * AbortSignal so a chunked-summarize job's overall cancel can still
   * unblock from inside the wait.
   */
  private async waitForRestart(signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + this.restartPollBudgetMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) {
        throw new Error('MlxHttpBackend: aborted while waiting for oMLX restart');
      }
      try {
        await this.ping();
        return; // alive again
      } catch {
        // not yet — sleep and retry
        await new Promise<void>((resolve) =>
          setTimeout(resolve, this.restartPollIntervalMs),
        );
      }
    }
    throw new Error(
      `MlxHttpBackend: oMLX did not recover within ${this.restartPollBudgetMs}ms ` +
        `after suspected mid-request abort — original connection-reset error stands`,
    );
  }
}
