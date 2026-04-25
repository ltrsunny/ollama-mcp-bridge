/**
 * Unit tests for the map-reduce orchestrator (src/chunking/map-reduce.ts).
 *
 * Uses FakeBackend (deterministic, in-process) so no Ollama is needed.
 * The chars/4 token proxy in FakeBackend is shared with the orchestrator's
 * countTokens path, making bucket-sizing math predictable in tests.
 */

import { describe, it, expect } from 'vitest';
import {
  chunkedSummarize,
  REDUCE_BUCKET_TOKENS,
  PROMPT_OVERHEAD_TOKENS,
  MAX_RECURSION_DEPTH,
} from '../../src/chunking/map-reduce.js';
import { FakeBackend } from './fake-backend.js';

/** Builds a fresh AbortController for each test so signals are isolated. */
function freshSignal(): AbortSignal {
  return new AbortController().signal;
}

describe('chunkedSummarize — fast-path', () => {
  it('takes the fast-path when input fits in maxInputTokens minus overhead', async () => {
    const backend = new FakeBackend({
      initialScript: [
        { result: { text: 'fast-path summary', promptTokens: 250, completionTokens: 30 } },
      ],
    });
    const result = await chunkedSummarize({
      source: 'A short doc.', // 12 chars ~ 3 tokens, easily fits
      backend,
      maxInputTokens: 8192,
      signal: freshSignal(),
    });

    expect(result.text).toBe('fast-path summary');
    expect(result.chunksProcessed).toBe(1);
    expect(result.reduceDepth).toBe(0);
    expect(result.partial).toBe(false);
    expect(result.chunksFailed).toBe(0);
    expect(result.promptTokens).toBe(250);
    expect(result.completionTokens).toBe(30);
    expect(backend.recorded).toHaveLength(1);
  });

  it('forwards the style hint to the fast-path prompt', async () => {
    const backend = new FakeBackend();
    await chunkedSummarize({
      source: 'short',
      style: 'one sentence',
      backend,
      maxInputTokens: 8192,
      signal: freshSignal(),
    });
    expect(backend.recorded[0]?.opts.user).toContain('Style override: one sentence');
  });
});

describe('chunkedSummarize — multi-chunk single-pass reduce', () => {
  it('runs MAP across multiple chunks then a single REDUCE', async () => {
    // ~12 K char input → ~3 K tokens. With chunkSize=200 and × 0.85 factor,
    // splitter should make ~18-20 chunks; each MAP summary is ~16 chars
    // (default fake summary), so ~20 × 4 tokens = 80 tokens — well under
    // the 3 K reduce bucket → single REDUCE pass.
    const backend = new FakeBackend({
      defaultResult: { text: 'chunk summary', promptTokens: 60, completionTokens: 5 },
    });
    const source = 'sentence. '.repeat(1200);
    const result = await chunkedSummarize({
      source,
      backend,
      maxInputTokens: 500, // forces past fast-path
      chunkSize: 200,
      chunkOverlap: 20,
      signal: freshSignal(),
    });

    expect(result.chunksProcessed).toBeGreaterThan(1);
    expect(result.reduceDepth).toBe(1);
    expect(result.partial).toBe(false);
    expect(result.chunksFailed).toBe(0);
    expect(result.text).toBeTruthy();
    // Total backend calls = N MAP + 1 REDUCE
    expect(backend.recorded.length).toBe(result.chunksProcessed + 1);
    // Last call is the REDUCE — verified by its user prompt containing
    // the REDUCE template's distinctive "Document fragment summaries" header.
    const lastCall = backend.recorded[backend.recorded.length - 1];
    expect(lastCall?.opts.user).toContain('Document fragment summaries');
    // And the system prompt is the REDUCE one, not MAP.
    expect(lastCall?.opts.system).toContain('combining ordered fragment summaries');
  });
});

describe('chunkedSummarize — recursive reduce', () => {
  it('recurses when joined summaries exceed REDUCE_BUCKET_TOKENS', async () => {
    // Force recursion: each chunk produces a ~250-char summary; many
    // chunks → joined > 3 K-token bucket → recursion required.
    const longSummary =
      'This is a chunk-level summary that contains specific details. '.repeat(4);
    const backend = new FakeBackend({
      defaultResult: { text: longSummary, promptTokens: 150, completionTokens: 60 },
    });
    const source = 'sentence. '.repeat(2400); // many chunks
    const result = await chunkedSummarize({
      source,
      backend,
      maxInputTokens: 500,
      chunkSize: 200,
      chunkOverlap: 20,
      signal: freshSignal(),
    });

    expect(result.chunksProcessed).toBeGreaterThan(1);
    expect(result.reduceDepth).toBeGreaterThanOrEqual(2);
    expect(result.partial).toBe(false);
    // The final text comes from the last reduce call (FakeBackend default)
    // and must be non-empty.
    expect(result.text).toBeTruthy();
    // Total calls = N_MAP + N_BUCKET_REDUCES + 1 final reduce.
    // With recursion happening, total > N_MAP + 1.
    expect(backend.recorded.length).toBeGreaterThan(result.chunksProcessed + 1);
  });

  it('returns partial=true when recursion hits MAX_RECURSION_DEPTH', async () => {
    // Need an extreme case where even after MAX_RECURSION_DEPTH passes, the
    // input still doesn't fit a single bucket. Trick: make the FAKE summary
    // outputs LONG so each reduce pass produces output that's still bigger
    // than the bucket. We set defaultResult to "X".repeat(15000) (~3.7 K
    // tokens proxy) which always exceeds the 3 K bucket on its own.
    const longResult = 'X'.repeat(15_000); // > REDUCE_BUCKET_TOKENS proxy
    const backend = new FakeBackend({
      defaultResult: { text: longResult, promptTokens: 200, completionTokens: 800 },
    });

    const source = 'sentence. '.repeat(800); // ~10 chunks at chunkSize=200
    const result = await chunkedSummarize({
      source,
      backend,
      maxInputTokens: 500,
      chunkSize: 200,
      chunkOverlap: 20,
      signal: freshSignal(),
    });

    expect(result.partial).toBe(true);
    expect(result.reduceDepth).toBe(MAX_RECURSION_DEPTH);
  });
});

describe('chunkedSummarize — guards and validation', () => {
  it('throws if chunkOverlap >= chunkSize', async () => {
    const backend = new FakeBackend();
    await expect(
      chunkedSummarize({
        source: 'A doc.',
        backend,
        maxInputTokens: 1000,
        chunkSize: 100,
        chunkOverlap: 100, // not strictly less than
        signal: freshSignal(),
      }),
    ).rejects.toThrow(/overlap.*must satisfy/);
  });

  it('throws if chunkSize is non-positive', async () => {
    const backend = new FakeBackend();
    await expect(
      chunkedSummarize({
        source: 'A doc.',
        backend,
        maxInputTokens: 1000,
        chunkSize: 0,
        signal: freshSignal(),
      }),
    ).rejects.toThrow(/chunk size must be positive/);
  });

  it('throws if concurrency < 1', async () => {
    const backend = new FakeBackend();
    await expect(
      chunkedSummarize({
        source: 'A doc.',
        backend,
        maxInputTokens: 1000,
        concurrency: 0,
        signal: freshSignal(),
      }),
    ).rejects.toThrow(/concurrency must be ≥ 1/);
  });

  it('throws if maxChunks < 1', async () => {
    const backend = new FakeBackend();
    await expect(
      chunkedSummarize({
        source: 'A doc.',
        backend,
        maxInputTokens: 1000,
        maxChunks: 0,
        signal: freshSignal(),
      }),
    ).rejects.toThrow(/max_chunks must be ≥ 1/);
  });

  it('errors out when chunks exceed max_chunks', async () => {
    const backend = new FakeBackend();
    await expect(
      chunkedSummarize({
        source: 'word '.repeat(5000), // many chunks
        backend,
        maxInputTokens: 100,
        chunkSize: 50,
        chunkOverlap: 5,
        maxChunks: 3, // very low cap
        signal: freshSignal(),
      }),
    ).rejects.toThrow(/exceeding max_chunks=3/);
  });
});

describe('chunkedSummarize — telemetry', () => {
  it('sums prompt and completion tokens across all phases', async () => {
    // Each MAP call: prompt=100, completion=20
    // The single REDUCE call: prompt=500, completion=80
    const backend = new FakeBackend({
      defaultResult: { text: 'short', promptTokens: 100, completionTokens: 20 },
    });
    backend.script({ result: { text: 'final', promptTokens: 500, completionTokens: 80 } });

    const result = await chunkedSummarize({
      source: 'sentence. '.repeat(1200),
      backend,
      maxInputTokens: 500,
      chunkSize: 200,
      chunkOverlap: 20,
      signal: freshSignal(),
    });

    // promptTokens = N_MAP * 100 + 500
    // completionTokens = N_MAP * 20 + 80
    const N = result.chunksProcessed;
    expect(result.promptTokens).toBe(N * 100 + 500);
    expect(result.completionTokens).toBe(N * 20 + 80);
  });
});

describe('chunkedSummarize — chunk failure resilience', () => {
  it('substitutes placeholders for chunks that error and keeps chunksFailed accurate', async () => {
    const backend = new FakeBackend();
    // First MAP call throws, the rest succeed (no scripted entries → defaults)
    backend.script({ throwError: new Error('synthetic backend error') });

    const source = 'sentence. '.repeat(1200);
    const result = await chunkedSummarize({
      source,
      backend,
      maxInputTokens: 500,
      chunkSize: 200,
      chunkOverlap: 20,
      signal: freshSignal(),
    });

    expect(result.chunksFailed).toBe(1);
    expect(result.reduceFailed).toBe(0);
    expect(result.partial).toBe(false);
    expect(result.text).toBeTruthy();
    // The placeholder must have been threaded into the REDUCE input
    const reduceCall = backend.recorded[backend.recorded.length - 1];
    expect(reduceCall?.opts.user).toContain('summary unavailable');
  });

  it('degrades terminal-reduce errors to partial result instead of bubbling raw timeout', async () => {
    // Single-pass reduce scenario (small input → 1 terminal reduce call).
    // Make every REDUCE call throw → the catch in fitsInOneCall path must
    // return partial=true with the joined chunk summaries as fallback text,
    // NOT bubble the raw error and discard MAP work.
    class FailReduceBackend extends FakeBackend {
      override async chat(
        opts: import('../../src/llm/backend.js').ChatOptions,
        signal?: AbortSignal,
      ): Promise<import('../../src/llm/backend.js').ChatResult> {
        if (opts.system?.includes('combining ordered fragment summaries')) {
          throw Object.assign(new Error('terminal reduce timeout'), {
            name: 'TimeoutError',
          });
        }
        return super.chat(opts, signal);
      }
    }
    const backend = new FailReduceBackend({
      defaultResult: { text: 'chunk summary text', promptTokens: 50, completionTokens: 10 },
    });
    const result = await chunkedSummarize({
      source: 'sentence. '.repeat(1200), // forces chunking + 1 reduce
      backend,
      maxInputTokens: 500,
      chunkSize: 200,
      chunkOverlap: 20,
      signal: freshSignal(),
    });

    expect(result.partial).toBe(true);
    expect(result.reduceFailed).toBe(1);
    expect(result.chunksFailed).toBe(0);
    expect(result.text).toContain('Final reduce unavailable');
    // The fallback should preserve the chunk summaries so MAP work is not lost
    expect(result.text).toContain('[Chunk 1]');
  });

  it('counts reduceFailed when an intermediate-bucket REDUCE call errors', async () => {
    // Force recursion (so there are intermediate-bucket reduce calls), then
    // throw on the FIRST reduce-phase call to exercise the reduceFailed path.
    // We use a thin subclass of FakeBackend to detect REDUCE calls by their
    // distinctive system prompt and throw exactly once on the first one.
    class FailFirstReduceBackend extends FakeBackend {
      private reducesSeen = 0;
      override async chat(
        opts: import('../../src/llm/backend.js').ChatOptions,
        signal?: AbortSignal,
      ): Promise<import('../../src/llm/backend.js').ChatResult> {
        if (opts.system?.includes('combining ordered fragment summaries')) {
          this.reducesSeen++;
          if (this.reducesSeen === 1) {
            throw new Error('synthetic reduce error');
          }
        }
        return super.chat(opts, signal);
      }
    }
    const longSummary =
      'This is a chunk-level summary that contains specific details. '.repeat(4);
    const backend = new FailFirstReduceBackend({
      defaultResult: { text: longSummary, promptTokens: 150, completionTokens: 60 },
    });
    const source = 'sentence. '.repeat(2400); // forces recursion
    const result = await chunkedSummarize({
      source,
      backend,
      maxInputTokens: 500,
      chunkSize: 200,
      chunkOverlap: 20,
      signal: freshSignal(),
    });

    expect(result.reduceDepth).toBeGreaterThanOrEqual(2);
    expect(result.reduceFailed).toBe(1);
    expect(result.chunksFailed).toBe(0);
    expect(result.partial).toBe(false);
    // The placeholder for the failed bucket must have been threaded forward
    // into the next reduce pass.
    const calls = backend.recorded;
    const reducesAfterFail = calls.filter((c) =>
      c.opts.user.includes('reduce unavailable'),
    );
    expect(reducesAfterFail.length).toBeGreaterThanOrEqual(1);
  });
});

describe('chunkedSummarize — sanity checks on tunables', () => {
  it('REDUCE_BUCKET_TOKENS is the documented 3000', () => {
    expect(REDUCE_BUCKET_TOKENS).toBe(3000);
  });

  it('PROMPT_OVERHEAD_TOKENS is the documented 500', () => {
    expect(PROMPT_OVERHEAD_TOKENS).toBe(500);
  });

  it('MAX_RECURSION_DEPTH is the documented 3', () => {
    expect(MAX_RECURSION_DEPTH).toBe(3);
  });
});
