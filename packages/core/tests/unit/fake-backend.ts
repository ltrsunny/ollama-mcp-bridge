/**
 * FakeBackend — deterministic in-process `LlmBackend` for unit-testing the
 * chunking orchestrator without spinning up Ollama.
 *
 * Capabilities:
 *   - Scripted responses: a queue of `ChatResult`s consumed FIFO. When the
 *     queue is empty, returns a default echo response (so tests don't have
 *     to enumerate every call). The MAP phase typically takes per-chunk
 *     scripted responses; REDUCE pulls from the same queue.
 *   - Per-call delay: simulates a slow LLM. Combined with AbortSignal.timeout
 *     in the orchestrator, this drives the local-timeout vs job-cancel
 *     branches.
 *   - Per-call throw: simulates a backend error.
 *   - countTokens proxy: returns chars/4 (deterministic, fast). Tests use
 *     this knowingly — the orchestrator code under test treats it as a
 *     proxy, so the value being approximate is the realistic case.
 *   - Records every chat() invocation (args + signal) so tests can inspect
 *     queue ordering, prompt construction, and AbortSignal flow.
 */

import type {
  LlmBackend,
  ChatOptions,
  ChatResult,
} from '../../src/llm/backend.js';

export interface ScriptedCall {
  /** Pre-canned ChatResult to return. */
  result?: ChatResult;
  /** Synthetic per-call delay before resolving (ms). Default 0 (immediate). */
  delayMs?: number;
  /** If set, throws this error after the delay instead of returning. */
  throwError?: Error;
  /**
   * If true, after applying delayMs the call resolves only when the
   * signal aborts; on abort it throws an AbortError with the signal's
   * reason. Useful for verifying that the orchestrator's chained signal
   * actually fires per-call.
   */
  waitForAbort?: boolean;
}

export interface RecordedChatCall {
  opts: ChatOptions;
  /** Signal observed at call time; tests inspect .aborted. */
  signal?: AbortSignal;
  /** Wall-clock ordering of calls. */
  index: number;
}

export interface FakeBackendOptions {
  /** Identifier returned by `modelId`. */
  modelId?: string;
  /**
   * Default ChatResult used when the scripted queue is empty.
   * Default is a small generic echo with non-zero token counts.
   */
  defaultResult?: ChatResult;
  /** Optional initial scripted calls; more can be queued via `script()`. */
  initialScript?: ScriptedCall[];
}

const DEFAULT_RESULT: ChatResult = {
  text: '<<fake summary>>',
  promptTokens: 50,
  completionTokens: 10,
};

export class FakeBackend implements LlmBackend {
  readonly modelId: string;
  readonly recorded: RecordedChatCall[] = [];

  private readonly defaultResult: ChatResult;
  private readonly queue: ScriptedCall[];

  constructor(opts: FakeBackendOptions = {}) {
    this.modelId = opts.modelId ?? 'fake:test-model';
    this.defaultResult = opts.defaultResult ?? DEFAULT_RESULT;
    this.queue = [...(opts.initialScript ?? [])];
  }

  /** Append more scripted calls to the FIFO queue. */
  script(...calls: ScriptedCall[]): void {
    this.queue.push(...calls);
  }

  async chat(opts: ChatOptions, signal?: AbortSignal): Promise<ChatResult> {
    this.recorded.push({
      opts,
      ...(signal !== undefined ? { signal } : {}),
      index: this.recorded.length,
    });
    const scripted = this.queue.shift();
    const call = scripted ?? {};

    if (call.delayMs !== undefined && call.delayMs > 0) {
      await sleep(call.delayMs, signal);
    }

    if (call.waitForAbort) {
      // Wait until the signal fires (or never, if no signal supplied).
      // Tests use this with a short AbortSignal.timeout to verify the
      // chained-signal mechanism works as designed.
      if (!signal) {
        throw new Error('FakeBackend waitForAbort: no signal provided');
      }
      await new Promise<void>((_, reject) => {
        if (signal.aborted) {
          reject(signal.reason ?? new Error('aborted'));
          return;
        }
        signal.addEventListener('abort', () => {
          reject(signal.reason ?? new Error('aborted'));
        });
      });
    }

    if (call.throwError) {
      throw call.throwError;
    }

    return call.result ?? this.defaultResult;
  }

  /**
   * Deterministic char-per-token proxy. Real backends use real tokenizers;
   * tests don't care about exact counts, only that countTokens is called
   * consistently.
   */
  async countTokens(text: string): Promise<number> {
    return Math.ceil(text.length / 4);
  }

  async ping(): Promise<void> {
    /* noop */
  }
}

/** Promise-friendly sleep that respects an optional AbortSignal. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new Error('aborted'));
  }
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      cleanup();
      reject(signal?.reason ?? new Error('aborted'));
    };
    function cleanup(): void {
      signal?.removeEventListener('abort', onAbort);
    }
    signal?.addEventListener('abort', onAbort);
  });
}
