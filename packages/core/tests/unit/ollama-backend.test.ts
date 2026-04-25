/**
 * Unit tests for OllamaBackend.
 *
 * v0.2.0 commit #1 scope: tests are limited to the parts of OllamaBackend
 * that don't require a running Ollama daemon — modelId resolution and
 * countTokens (which is pure CPU work via js-tiktoken). The full chat()
 * path is exercised by the existing smoke-bridge.mjs (Tier-2 integration).
 */

import { describe, it, expect } from 'vitest';
import { OllamaBackend } from '../../src/llm/ollama-backend.js';
import { OllamaClient } from '../../src/ollama/client.js';

const fakeClient = new OllamaClient('http://127.0.0.1:11434');

describe('OllamaBackend.modelId', () => {
  it('namespaces the model tag with "ollama:"', () => {
    const b = new OllamaBackend(fakeClient, { modelTag: 'qwen2.5:7b' });
    expect(b.modelId).toBe('ollama:qwen2.5:7b');
  });

  it('preserves complex tags including : and -', () => {
    const b = new OllamaBackend(fakeClient, {
      modelTag: 'qwen3:4b-instruct-2507-q4_K_M',
    });
    expect(b.modelId).toBe('ollama:qwen3:4b-instruct-2507-q4_K_M');
  });
});

describe('OllamaBackend.countTokens', () => {
  const backend = new OllamaBackend(fakeClient, { modelTag: 'qwen2.5:7b' });

  it('returns 0 for the empty string', async () => {
    expect(await backend.countTokens('')).toBe(0);
  });

  it('counts a short ASCII string within a sane range', async () => {
    // "hello world" — cl100k tokenizer gives 2 tokens.
    const n = await backend.countTokens('hello world');
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(10);
  });

  it('counts a Chinese string within a sane range', async () => {
    // ~10 Chinese characters — cl100k will under-tokenize Chinese (~1 token
    // per 1.5–2 chars typically). Just assert non-zero and bounded.
    const n = await backend.countTokens('你好世界，今天天气真好');
    expect(n).toBeGreaterThan(3);
    expect(n).toBeLessThan(40);
  });

  it('is deterministic — repeated calls return the same count', async () => {
    const text = 'The quick brown fox jumps over the lazy dog. '.repeat(50);
    const a = await backend.countTokens(text);
    const b = await backend.countTokens(text);
    expect(a).toBe(b);
  });

  it('handles a long input that crosses multiple slice boundaries', async () => {
    // 30 KB → 2 slices (one full 20 KB + one 10 KB tail) at the 20 KB
    // segment size. Verifies the slicing loop doesn't drop tokens at
    // boundaries on a realistic input.
    const longText = 'sentence number twelve. '.repeat(1_500); // 36 KB
    const n = await backend.countTokens(longText);
    expect(n).toBeGreaterThan(100);
    expect(n).toBeLessThan(longText.length);
  });

  it(
    'produces consistent counts on a string at exactly the slice boundary',
    async () => {
      // 40 000 chars = exactly 2 × 20 000 segments. Re-counting the same
      // string MUST give the same number — catches off-by-one bugs in the
      // slicing loop. cl100k BPE on highly repetitive ASCII can be slow
      // (every adjacent pair is a merge candidate), so this test gets an
      // explicit longer timeout. In production usage, countTokens runs
      // inside a tool call's 50 s budget, not a 5 s test timeout.
      const text = 'word '.repeat(8_000);
      const a = await backend.countTokens(text);
      const b = await backend.countTokens(text);
      expect(a).toBe(b);
      expect(a).toBeGreaterThan(1_000);
    },
    30_000,
  );

  it('yields to the event loop on long inputs', async () => {
    // Schedule a competing macrotask. If countTokens were fully blocking,
    // the setImmediate callback would not fire until countTokens completes.
    // We verify the macrotask interleaves — fires before countTokens
    // resolves on a multi-segment input.
    const longText = 'sentence '.repeat(3_500); // ~31 KB → 2 slices, 1 yield
    let macrotaskFiredDuringCount = false;
    let countResolved = false;

    setImmediate(() => {
      if (!countResolved) macrotaskFiredDuringCount = true;
    });

    await backend.countTokens(longText);
    countResolved = true;

    // One more tick to let the setImmediate callback land if it hadn't yet.
    await new Promise((r) => setImmediate(r));

    expect(macrotaskFiredDuringCount).toBe(true);
  });
});
