/**
 * Regression: `summarize-long` must NOT surface an error when its single
 * Tier-C call hits the oMLX prefill memory guard (empty completion). An error
 * to the caller is still a failure ("an error IS a bug"), so the handler
 * transparently falls back to the chunked map-reduce path — which uses smaller
 * per-chunk prefills that fit under the guard — and actually produces a summary.
 *
 * Driven through the real in-process MCP client/server with a backend whose
 * FIRST chat() throws the empty-completion error and whose subsequent calls
 * (the chunked MAP + REDUCE) succeed.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { buildBridgeServer } from '../../src/mcp/server.js';
import {
  _installTestBackend,
  _resetMlxHttpCacheForTests,
} from '../../src/mcp/backend-factory.js';
import { JobStore } from '../../src/jobs/store.js';
import { JobRegistry } from '../../src/jobs/registry.js';
import { JobRunner } from '../../src/jobs/runner.js';
import type { LlmBackend, ChatOptions, ChatResult } from '../../src/llm/backend.js';

/** Long enough to chunk into several pieces, but under summarize-long's
 *  oversizeCheck floor (so the handler reaches the single chat call that
 *  triggers the fallback rather than erroring proactively). */
const LONG_TEXT =
  'The quarterly report covered revenue, costs, headcount, and the forward outlook. '.repeat(
    700,
  );

/** First chat() throws the empty-completion error (simulating the prefill
 *  memory-guard rejection); every later call (chunk MAP + REDUCE) succeeds. */
class FirstCallThrowsBackend implements LlmBackend {
  calls = 0;
  readonly modelId = 'first-throws-fake';
  async chat(opts: ChatOptions, signal?: AbortSignal): Promise<ChatResult> {
    void opts;
    void signal;
    this.calls += 1;
    if (this.calls === 1) {
      throw new Error(
        'MlxHttpBackend: oMLX returned an EMPTY completion (prompt_tokens=0, completion_tokens=0). ' +
          'Likely a decode abort or a prefill memory-guard rejection under memory pressure.',
      );
    }
    return { text: `chunk-summary-${this.calls}`, promptTokens: 80, completionTokens: 12 };
  }
  async countTokens(text: string): Promise<number> {
    return Math.ceil(text.length / 3.5);
  }
  async ping(): Promise<void> {
    /* healthy */
  }
}

describe('summarize-long → chunked fallback on memory-guard / empty completion', () => {
  let client: Client;
  let runner: JobRunner;
  let tmpDir: string;
  let backend: FirstCallThrowsBackend;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'omcp-sl-fallback-'));
    const store = new JobStore({ baseDir: tmpDir });
    const registry = new JobRegistry(store);
    await registry.initialize();
    runner = new JobRunner(
      registry,
      async () => ({ isError: true, content: [{ type: 'text' as const, text: 'sync-only stub' }] }),
      { concurrency: 1 },
    );

    _resetMlxHttpCacheForTests();
    backend = new FirstCallThrowsBackend();
    _installTestBackend(backend);

    const server = buildBridgeServer({
      defendUntrusted: false,
      jobRegistry: registry,
      jobRunner: runner,
    });
    const [serverT, clientT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    client = new Client({ name: 'sl-fallback-test', version: '0.0.0' });
    await client.connect(clientT);
  });

  afterEach(async () => {
    await client.close();
    await runner.waitIdle();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('does NOT error — it falls back to chunked and returns a summary', async () => {
    const result = (await client.callTool({
      name: 'summarize-long',
      arguments: { text: LONG_TEXT },
    })) as { isError?: boolean; content?: Array<{ text?: string }> };

    // An error here would be the bug. The guard rejection must recover via chunking.
    expect(result.isError ?? false).toBe(false);
    // Single call threw (#1); the chunked fallback then issued ≥1 more call.
    expect(backend.calls).toBeGreaterThan(1);
    // A real (non-empty) summary came back.
    const text = result.content?.[0]?.text ?? '';
    expect(text.length).toBeGreaterThan(0);
  });
});
