/**
 * AbortSignal-propagation tests for the chunking orchestrator.
 *
 * Per scope memo §8 (Gemini-3.1 audit conditions): four scenarios must hold.
 *   A. job-level abort during MAP causes pending p-limit queue items to
 *      early-exit (queue-drain guard) without backend calls.
 *   B. per-call 50 s timeout substitutes the placeholder for that chunk
 *      only (other chunks continue, job survives).
 *   C. jobSignal.aborted re-throws cleanly without substitution.
 *   D. AbortSignal.any chaining: per-call timeout does not trigger job
 *      signal; job signal does propagate to per-call signals.
 */

import { describe, it, expect } from 'vitest';
import { chunkedSummarize } from '../../src/chunking/map-reduce.js';
import { FakeBackend } from './fake-backend.js';

describe('AbortSignal propagation', () => {
  // A. queue-drain guard
  it('A: job abort during MAP prevents pending queue items from running', async () => {
    const ctrl = new AbortController();
    // Deterministic setup (no wall-clock racing — flaky on slow CI):
    //   - concurrency=1 so only chunk 1 runs at a time
    //   - chunk 1's scripted call uses waitForAbort, so it hangs until the
    //     signal fires
    //   - we abort once we observe chunk 1 is in-flight (recorded.length
    //     reaches 1), simulating an MCP client disconnect during the
    //     first chunk's backend call
    //   - remaining chunks (2..N) sit queued in p-limit; when chunk 1
    //     throws, p-limit drains the queue but each chunk-fn's
    //     throwIfAborted() guard fires before any backend call
    const backend = new FakeBackend();
    backend.script({ waitForAbort: true });

    // Poll for chunk 1's backend call landing, then abort. The `testDone`
    // flag is the escape hatch: if chunkedSummarize ever rejects without
    // invoking backend.chat (e.g. an unexpected validation throw), the
    // poll exits cleanly instead of spinning forever and leaking handles.
    let testDone = false;
    const abortWhenChunk1Starts = (async (): Promise<void> => {
      while (backend.recorded.length === 0 && !testDone) {
        await new Promise<void>((r) => setImmediate(r));
      }
      if (!testDone) ctrl.abort(new Error('client disconnect'));
    })();

    const source = 'sentence. '.repeat(1200); // many chunks at chunkSize=200

    try {
      await expect(
        chunkedSummarize({
          source,
          backend,
          maxInputTokens: 500,
          chunkSize: 200,
          chunkOverlap: 20,
          concurrency: 1,
          signal: ctrl.signal,
        }),
      ).rejects.toThrow(/client disconnect|aborted/);
    } finally {
      testDone = true;
      await abortWhenChunk1Starts;
    }

    // Only chunk 1 ever reached backend.chat(). Chunks 2..N hit the
    // queue-drain guard and threw before invoking the backend.
    expect(backend.recorded.length).toBe(1);
  });

  // B. per-call timeout substitutes placeholder, job survives
  it('B: per-call timeout substitutes placeholder; other chunks continue', async () => {
    // Set up backend so first MAP call hangs forever (until aborted by the
    // chained per-call timeout signal). A shortened FakeBackend timeout
    // simulation is awkward because the orchestrator's PER_CALL_TIMEOUT_MS
    // is a hard 50 s constant. To exercise this path with reasonable test
    // wall time, we use the `waitForAbort` flag — the backend resolves
    // ONLY when the signal fires, which from the orchestrator's perspective
    // is exactly the per-call-timeout behavior.
    //
    // The orchestrator's actual 50 s timeout is unaffected by this test —
    // we're exercising the SAME catch path the timeout would trigger.
    // Specifically: the FakeBackend throws an AbortError whose signal.reason
    // matches a TimeoutError-style cause, which the orchestrator should
    // treat as a local-timeout (substitute placeholder) and not re-throw.
    //
    // To tightly simulate "local timeout but job NOT aborted", we pass a
    // very short timeout via... well, we can't override PER_CALL_TIMEOUT_MS
    // without exposing it as an option. So we use throwError instead:
    // the orchestrator's catch sees a non-AbortError, jobSignal not aborted,
    // and substitutes — same control-flow branch as a real timeout.
    const backend = new FakeBackend();
    backend.script({
      throwError: Object.assign(new Error('simulated per-call timeout'), {
        name: 'TimeoutError',
      }),
    });

    const source = 'sentence. '.repeat(1200);
    const ctrl = new AbortController();
    const result = await chunkedSummarize({
      source,
      backend,
      maxInputTokens: 500,
      chunkSize: 200,
      chunkOverlap: 20,
      concurrency: 1,
      signal: ctrl.signal,
    });

    expect(result.chunksFailed).toBe(1);
    // Job did NOT abort — we got a real result.
    expect(result.text).toBeTruthy();
    expect(ctrl.signal.aborted).toBe(false);
    // Other chunks ran (more than just the one that errored).
    expect(backend.recorded.length).toBeGreaterThan(1);
  });

  // C. jobSignal abort re-throws cleanly without substitution
  it('C: pre-aborted signal re-throws before any work', async () => {
    const ctrl = new AbortController();
    ctrl.abort(new Error('pre-aborted'));

    const backend = new FakeBackend();
    await expect(
      chunkedSummarize({
        source: 'sentence. '.repeat(100),
        backend,
        maxInputTokens: 500,
        signal: ctrl.signal,
      }),
    ).rejects.toThrow(/pre-aborted/);

    // No backend calls at all
    expect(backend.recorded).toHaveLength(0);
  });

  // D. AbortSignal.any chaining direction
  it('D: aborting the job signal cancels the per-call signal observed by the backend', async () => {
    const ctrl = new AbortController();
    // FakeBackend with waitForAbort: resolves only when its signal aborts.
    // This proves the chained signal propagated job → per-call.
    const backend = new FakeBackend();
    backend.script({ waitForAbort: true });

    // Same deterministic-poll pattern as test A — with escape hatch.
    let testDone = false;
    const abortWhenChunk1Starts = (async (): Promise<void> => {
      while (backend.recorded.length === 0 && !testDone) {
        await new Promise<void>((r) => setImmediate(r));
      }
      if (!testDone) ctrl.abort(new Error('client gone'));
    })();

    try {
      await expect(
        chunkedSummarize({
          source: 'sentence. '.repeat(1200),
          backend,
          maxInputTokens: 500,
          chunkSize: 200,
          chunkOverlap: 20,
          concurrency: 1,
          signal: ctrl.signal,
        }),
      ).rejects.toThrow(/client gone|aborted/);
    } finally {
      testDone = true;
      await abortWhenChunk1Starts;
    }

    // The first chunk's backend call observed an aborted signal
    const firstCall = backend.recorded[0];
    expect(firstCall).toBeDefined();
    expect(firstCall?.signal?.aborted).toBe(true);
  });
});
