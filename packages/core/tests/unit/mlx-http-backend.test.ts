/**
 * Unit tests for MlxHttpBackend.
 *
 * All HTTP is mocked via `vi.stubGlobal('fetch', ...)` — no real server needed.
 * Tests cover: chat, ping, abort, error paths, and JSON-mode routing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MlxHttpBackend, normalizeForStrictMode } from '../../src/llm/mlx-http-backend.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOkResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function makeErrorResponse(status: number, body = ''): Response {
  return {
    ok: false,
    status,
    statusText: 'Error',
    json: async () => {
      throw new Error('not json');
    },
    text: async () => body,
  } as unknown as Response;
}

/** Build a minimal valid OpenAI chat completion response. */
function chatResponse(content: string, promptTokens = 10, completionTokens = 5) {
  return {
    id: 'mlx-42ms',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: 15 },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MlxHttpBackend', () => {
  let backend: MlxHttpBackend;
  const BASE_URL = 'http://127.0.0.1:8080';

  beforeEach(() => {
    // Supply modelName to skip the /v1/models auto-detect round-trip in tests
    // that focus on chat() behaviour rather than model resolution.
    backend = new MlxHttpBackend({ baseUrl: BASE_URL, numCtx: 16384, modelName: 'test-model' });
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── modelId ────────────────────────────────────────────────────────────

  it('returns modelId including base URL and model name', () => {
    // modelName is known from construction → included immediately.
    expect(backend.modelId).toBe(`mlx-http:${BASE_URL}/test-model`);
  });

  it('returns modelId with only base URL when no modelName is configured', () => {
    const b = new MlxHttpBackend({ baseUrl: 'http://localhost:8080' });
    expect(b.modelId).toBe('mlx-http:http://localhost:8080');
  });

  it('strips trailing slash from base URL', () => {
    const b = new MlxHttpBackend({ baseUrl: 'http://localhost:8080/' });
    expect(b.modelId).toBe('mlx-http:http://localhost:8080');
  });

  // ── model name resolution ─────────────────────────────────────────────

  it('auto-detects model from /v1/models when modelName is not set', async () => {
    const b = new MlxHttpBackend({ baseUrl: BASE_URL });
    const modelsResponse = makeOkResponse({ object: 'list', data: [{ id: 'Qwen3-8B-4bit' }] });
    const chatOkResponse = makeOkResponse(chatResponse('hi'));
    // First call → /v1/models; second call → /v1/chat/completions
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(modelsResponse)
      .mockResolvedValueOnce(chatOkResponse));

    const result = await b.chat({ user: 'test', maxInputTokens: 4096 });
    expect(result.text).toBe('hi');
    expect(b.modelId).toBe(`mlx-http:${BASE_URL}/Qwen3-8B-4bit`);

    // Second call should NOT hit /v1/models again (cached).
    const chatOkResponse2 = makeOkResponse(chatResponse('hi2'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(chatOkResponse2));
    const result2 = await b.chat({ user: 'test2', maxInputTokens: 4096 });
    expect(result2.text).toBe('hi2');
    expect(vi.mocked(fetch).mock.calls.length).toBe(1); // only one fetch (no re-detect)
  });

  it('throws when /v1/models returns empty list', async () => {
    const b = new MlxHttpBackend({ baseUrl: BASE_URL });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeOkResponse({ data: [] })));
    await expect(b.chat({ user: 'hi', maxInputTokens: 4096 })).rejects.toThrow(/empty list/i);
  });

  // ── chat ──────────────────────────────────────────────────────────────

  it('sends a well-formed POST to /v1/chat/completions', async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeOkResponse(chatResponse('Hello!')));
    vi.stubGlobal('fetch', mockFetch);

    const result = await backend.chat({
      user: 'Say hello',
      maxInputTokens: 4096,
      temperature: 0,
    });

    expect(result.text).toBe('Hello!');
    expect(result.promptTokens).toBe(10);
    expect(result.completionTokens).toBe(5);

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/v1/chat/completions`);
    expect(init.method).toBe('POST');

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.model).toBe('test-model');
    // `/no_think` is appended to user content to disable Qwen3 thinking trace.
    expect(body.messages).toEqual([{ role: 'user', content: 'Say hello\n/no_think' }]);
    expect(body.temperature).toBe(0);
    // No response_format field when format is absent
    expect(body.response_format).toBeUndefined();
  });

  it('prepends a system message when opts.system is set', async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeOkResponse(chatResponse('ok')));
    vi.stubGlobal('fetch', mockFetch);

    await backend.chat({
      system: 'You are terse.',
      user: 'Count to 3',
      maxInputTokens: 4096,
    });

    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { messages: Array<{ role: string; content: string }> };
    expect(body.messages[0]).toEqual({ role: 'system', content: 'You are terse.' });
    expect(body.messages[1]).toEqual({ role: 'user', content: 'Count to 3\n/no_think' });
  });

  it('adds response_format json_object when opts.format is set', async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeOkResponse(chatResponse('{"label":"A"}')));
    vi.stubGlobal('fetch', mockFetch);

    await backend.chat({
      user: 'Classify',
      maxInputTokens: 4096,
      format: { type: 'object', properties: { label: { type: 'string' } } },
    });

    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as {
      response_format?: {
        type: string;
        json_schema?: { name: string; strict: boolean; schema: unknown };
      };
    };
    expect(body.response_format?.type).toBe('json_schema');
    expect(body.response_format?.json_schema?.strict).toBe(true);
    // Strict-mode normalization: every object node gets
    // additionalProperties: false + required: <all property keys>.
    expect(body.response_format?.json_schema?.schema).toEqual({
      type: 'object',
      properties: { label: { type: 'string' } },
      additionalProperties: false,
      required: ['label'],
    });
  });

  it('passes maxOutputTokens as max_tokens', async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeOkResponse(chatResponse('x')));
    vi.stubGlobal('fetch', mockFetch);

    await backend.chat({ user: 'hi', maxInputTokens: 4096, maxOutputTokens: 256 });

    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { max_tokens?: number };
    expect(body.max_tokens).toBe(256);
  });

  it('omits max_tokens when maxOutputTokens is not set', async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeOkResponse(chatResponse('x')));
    vi.stubGlobal('fetch', mockFetch);

    await backend.chat({ user: 'hi', maxInputTokens: 4096 });

    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { max_tokens?: number };
    expect(body.max_tokens).toBeUndefined();
  });

  it('handles empty completions gracefully (no choices)', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      makeOkResponse({ id: 'x', choices: [] }),
    );
    vi.stubGlobal('fetch', mockFetch);

    const result = await backend.chat({ user: 'hi', maxInputTokens: 4096 });
    expect(result.text).toBe('');
    expect(result.promptTokens).toBe(0);
    expect(result.completionTokens).toBe(0);
  });

  // ── error handling ────────────────────────────────────────────────────

  it('throws on non-2xx HTTP status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(makeErrorResponse(503, 'model not loaded')),
    );

    await expect(
      backend.chat({ user: 'hi', maxInputTokens: 4096 }),
    ).rejects.toThrow(/503/);
  });

  it('throws on malformed JSON response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => {
        throw new SyntaxError('bad json');
      },
      text: async () => '',
    } as unknown as Response));

    await expect(
      backend.chat({ user: 'hi', maxInputTokens: 4096 }),
    ).rejects.toThrow(/parse JSON/i);
  });

  it('throws a network error when fetch rejects with a non-connection-reset error', async () => {
    // Use an error string that DOESN'T match CONNECTION_RESET_MARKERS so
    // the circuit breaker stays out of the path. A reset-class error
    // would trigger waitForRestart instead — covered by the circuit-
    // breaker describe block below.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('TLS handshake failed')),
    );

    await expect(
      backend.chat({ user: 'hi', maxInputTokens: 4096 }),
    ).rejects.toThrow(/network error.*TLS handshake/i);
  });

  // ── AbortSignal ───────────────────────────────────────────────────────

  it('throws immediately when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      backend.chat({ user: 'hi', maxInputTokens: 4096 }, controller.signal),
    ).rejects.toThrow(/aborted before fetch/i);

    // fetch should not have been called
    expect(vi.mocked(fetch).mock.calls.length).toBe(0);
  });

  it('passes the AbortSignal to fetch', async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeOkResponse(chatResponse('done')));
    vi.stubGlobal('fetch', mockFetch);

    const controller = new AbortController();
    await backend.chat({ user: 'hi', maxInputTokens: 4096 }, controller.signal);

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBe(controller.signal);
  });

  it('wraps AbortError as aborted message', async () => {
    const abortError = Object.assign(new Error('signal aborted'), { name: 'AbortError' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortError));

    const controller = new AbortController();
    controller.abort();

    await expect(
      backend.chat({ user: 'hi', maxInputTokens: 4096 }, controller.signal),
    ).rejects.toThrow(/aborted/i);
  });

  // ── countTokens ───────────────────────────────────────────────────────

  it('returns ceil(chars / 3.5) as approximate token count', async () => {
    // "hello" = 5 chars → ceil(5/3.5) = 2
    expect(await backend.countTokens('hello')).toBe(2);
    // 35 chars → exactly 10
    expect(await backend.countTokens('a'.repeat(35))).toBe(10);
    // 36 chars → ceil(36/3.5) = ceil(10.28) = 11
    expect(await backend.countTokens('a'.repeat(36))).toBe(11);
    // empty string → 0
    expect(await backend.countTokens('')).toBe(0);
  });

  // ── ping ──────────────────────────────────────────────────────────────

  it('GET /health succeeds on 200', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
    } as Response);
    vi.stubGlobal('fetch', mockFetch);

    await expect(backend.ping()).resolves.toBeUndefined();

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/health`);
    expect(init.method).toBe('GET');
  });

  it('throws on /health non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
    } as Response));

    await expect(backend.ping()).rejects.toThrow(/503/);
  });

  it('throws on /health network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')));

    await expect(backend.ping()).rejects.toThrow(/unreachable/i);
  });

  // ── circuit breaker ───────────────────────────────────────────────────
  // chat() retries exactly once when fetch fails with a connection-reset
  // class error AND /health recovers within 5s. See
  // docs/notes/v0.5.x-omlx-stability-2026-05-11.md for the failure mode.

  describe('circuit breaker on connection-reset', () => {
    it('retries chat once after ECONNRESET when oMLX recovers', async () => {
      const fetchMock = vi.fn()
        // 1st chat attempt: simulate oMLX SIGABORT mid-request
        .mockRejectedValueOnce(
          Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } }),
        )
        // /health probe after launchd-restart succeeds
        .mockResolvedValueOnce(makeOkResponse({ status: 'ok' }))
        // 2nd chat attempt: succeeds
        .mockResolvedValueOnce(makeOkResponse(chatResponse('retried-ok')));
      vi.stubGlobal('fetch', fetchMock);

      const result = await backend.chat({ user: 'hi', maxInputTokens: 1024 });

      expect(result.text).toBe('retried-ok');
      // 1st chat (ECONNRESET) + 1 /health probe + 2nd chat (ok) = 3
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('does NOT retry on HTTP 500 (real server response, not crash)', async () => {
      const fetchMock = vi.fn().mockResolvedValue(makeErrorResponse(500, 'oops'));
      vi.stubGlobal('fetch', fetchMock);

      await expect(backend.chat({ user: 'hi', maxInputTokens: 1024 })).rejects.toThrow(/500/);
      // Exactly one attempt; circuit breaker stays out of HTTP-error paths.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does NOT retry if signal was aborted at error time', async () => {
      const controller = new AbortController();
      const fetchMock = vi.fn().mockImplementation(() => {
        controller.abort();
        return Promise.reject(
          Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } }),
        );
      });
      vi.stubGlobal('fetch', fetchMock);

      await expect(
        backend.chat({ user: 'hi', maxInputTokens: 1024 }, controller.signal),
      ).rejects.toThrow();
      // Just the one failing chat attempt — caller-cancelled abort suppresses retry.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('retries on mid-stream terminated error (undici stream abort)', async () => {
      // Failure mode #2: response headers arrive ok, then response.json()
      // aborts mid-stream because oMLX SIGABORTed during decode.
      // _chatOnce wraps the inner TypeError as "MlxHttpBackend: failed to
      // parse JSON response — terminated".
      const fetchMock = vi.fn()
        // 1st chat: response.json() throws "terminated"
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => {
            throw new TypeError('terminated');
          },
          text: async () => '',
        } as unknown as Response)
        // /health probe succeeds (launchd already restarted)
        .mockResolvedValueOnce(makeOkResponse({ status: 'ok' }))
        // 2nd chat: ok
        .mockResolvedValueOnce(makeOkResponse(chatResponse('retried-after-terminated')));
      vi.stubGlobal('fetch', fetchMock);

      const result = await backend.chat({ user: 'hi', maxInputTokens: 1024 });

      expect(result.text).toBe('retried-after-terminated');
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('throws "did not recover" if oMLX never comes back within the budget', async () => {
      // Use the @internal budget/interval overrides to keep this test well
      // under vitest's 5s timeout (default budget would be 5000 ms exactly).
      const fastBackend = new MlxHttpBackend({
        baseUrl: BASE_URL,
        modelName: 'test-model',
        _restartPollBudgetMs: 100,
        _restartPollIntervalMs: 10,
      });
      const fetchMock = vi.fn().mockRejectedValue(
        Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } }),
      );
      vi.stubGlobal('fetch', fetchMock);

      await expect(
        fastBackend.chat({ user: 'hi', maxInputTokens: 1024 }),
      ).rejects.toThrow(/did not recover within 100ms/);
      // 1 initial chat + several /health probes during the 100 ms budget +
      // no second chat attempt because we never declared "alive again".
      expect(fetchMock).toHaveBeenCalled();
    });
  });
});

describe('normalizeForStrictMode — recursion completeness (code-review E1-E3)', () => {
  type Node = Record<string, unknown>;
  const prop = (schema: Node, name: string): Node =>
    (schema['properties'] as Record<string, Node>)[name];

  it('E1: tightens a nullable object node (type: ["object", "null"])', () => {
    const out = normalizeForStrictMode({
      type: 'object',
      properties: {
        addr: { type: ['object', 'null'], properties: { city: { type: 'string' } } },
      },
    });
    const addr = prop(out, 'addr');
    expect(addr['additionalProperties']).toBe(false);
    expect(addr['required']).toEqual(['city']);
  });

  it('E2: recurses into prefixItems even when items is also present', () => {
    const out = normalizeForStrictMode({
      type: 'object',
      properties: {
        pair: {
          type: 'array',
          items: { type: 'string' },
          prefixItems: [{ type: 'object', properties: { a: { type: 'string' } } }],
        },
      },
    });
    const tupleObj = (prop(out, 'pair')['prefixItems'] as Node[])[0];
    expect(tupleObj['additionalProperties']).toBe(false);
    expect(tupleObj['required']).toEqual(['a']);
  });

  it('E3: tightens sibling anyOf branches on an object node (not just its properties)', () => {
    const out = normalizeForStrictMode({
      type: 'object',
      properties: {
        field: {
          type: 'object',
          properties: { known: { type: 'string' } },
          anyOf: [{ type: 'object', properties: { x: { type: 'string' } } }],
        },
      },
    });
    const field = prop(out, 'field');
    expect(field['additionalProperties']).toBe(false);
    expect(field['required']).toEqual(['known']);
    const branch = (field['anyOf'] as Node[])[0];
    expect(branch['additionalProperties']).toBe(false);
    expect(branch['required']).toEqual(['x']);
  });

  it('leaves data-bearing keywords (schema-shaped enum values) untouched', () => {
    const out = normalizeForStrictMode({
      type: 'object',
      properties: {
        shape: { enum: [{ type: 'object', properties: { x: { type: 'string' } } }] },
      },
    });
    // The enum entry is DATA, not a subschema — it must NOT gain
    // additionalProperties/required (allow-list recursion, never `enum`).
    expect((prop(out, 'shape')['enum'] as Node[])[0]).toEqual({
      type: 'object',
      properties: { x: { type: 'string' } },
    });
  });

  it('operates on a clone — caller schema is not mutated', () => {
    const input: Node = { type: 'object', properties: { a: { type: 'string' } } };
    const before = JSON.parse(JSON.stringify(input)) as Node;
    normalizeForStrictMode(input);
    expect(input).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Multimodal (tier V) — image content + chat_template_kwargs suppression
// ---------------------------------------------------------------------------

describe('MlxHttpBackend — multimodal / chat_template (tier V)', () => {
  const BASE_URL = 'http://127.0.0.1:8080';
  const DATA_URI = 'data:image/png;base64,iVBORw0KGgo=';

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function capture(
    opts: ConstructorParameters<typeof MlxHttpBackend>[0],
    chatArgs: Parameters<MlxHttpBackend['chat']>[0],
  ): Promise<{ messages: Array<{ role: string; content: unknown }>; chat_template_kwargs?: unknown }> {
    const mockFetch = vi.fn().mockResolvedValue(makeOkResponse(chatResponse('{}')));
    vi.stubGlobal('fetch', mockFetch);
    const backend = new MlxHttpBackend(opts);
    await backend.chat(chatArgs);
    const init = (mockFetch.mock.calls[0] as [string, RequestInit])[1];
    return JSON.parse(init.body as string);
  }

  it('chat_template mode: images → multimodal content array + chat_template_kwargs(enable_thinking:false)', async () => {
    const body = await capture(
      { baseUrl: BASE_URL, modelName: 'Qwen3-VL-4B-Instruct-4bit', thinkingMode: 'chat_template' },
      { user: 'extract', images: [DATA_URI], maxInputTokens: 32768, disableThinking: true },
    );
    expect(body.messages[0].content).toEqual([
      { type: 'text', text: 'extract' }, // NO /no_think appended in chat_template mode
      { type: 'image_url', image_url: { url: DATA_URI } },
    ]);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it('chat_template mode: disableThinking:false → enable_thinking:true', async () => {
    const body = await capture(
      { baseUrl: BASE_URL, modelName: 'Qwen3-VL-4B-Instruct-4bit', thinkingMode: 'chat_template' },
      { user: 'hi', maxInputTokens: 32768, disableThinking: false },
    );
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: true });
  });

  it('default (no_think) mode: text-only request is byte-identical (string content, no chat_template_kwargs)', async () => {
    const body = await capture(
      { baseUrl: BASE_URL, modelName: 'test-model' },
      { user: 'Say hello', maxInputTokens: 8192, disableThinking: true },
    );
    expect(body.messages[0].content).toBe('Say hello\n/no_think');
    expect(body.chat_template_kwargs).toBeUndefined();
  });

  it('multiple images → one image_url part each, after the text part', async () => {
    const body = await capture(
      { baseUrl: BASE_URL, modelName: 'Qwen3-VL-4B-Instruct-4bit', thinkingMode: 'chat_template' },
      { user: 'compare', images: [DATA_URI, DATA_URI], maxInputTokens: 32768, disableThinking: true },
    );
    expect(Array.isArray(body.messages[0].content)).toBe(true);
    const content = body.messages[0].content as Array<{ type: string }>;
    expect(content.map((c) => c.type)).toEqual(['text', 'image_url', 'image_url']);
  });
});
