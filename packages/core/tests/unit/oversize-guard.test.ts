/**
 * oversize-guard.test.ts — large inputs are rejected with an actionable message
 * BEFORE reaching the backend, instead of hitting oMLX's opaque
 * prefill_memory_exceeded 400 (sister bug report 2026-06-17: a ~2700-line file
 * → kv_len≈40k → memory-guard rejection with no fallback / unclear error).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { buildBridgeServer } from '../../src/mcp/server.js';
import {
  _installTestBackend,
  _resetMlxHttpCacheForTests,
} from '../../src/mcp/backend-factory.js';
import { RecorderBackend } from './recorder-client.js';

async function makeBridge(): Promise<{ recorder: RecorderBackend; client: Client }> {
  _resetMlxHttpCacheForTests();
  const recorder = new RecorderBackend();
  _installTestBackend(recorder);
  const server = buildBridgeServer({ defendUntrusted: false });
  const [st, ct] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: 'oversize-test', version: '0.0.0' });
  await client.connect(ct);
  return { recorder, client };
}

type ToolResult = { isError?: boolean; content?: Array<{ text?: string }> };
const firstText = (r: ToolResult): string => r.content?.[0]?.text ?? '';

describe('oversize input guard', () => {
  let recorder: RecorderBackend;
  let client: Client;
  beforeEach(async () => {
    ({ recorder, client } = await makeBridge());
  });

  it('summarize-long: huge input → actionable error pointing to chunked, backend NOT called', async () => {
    const r = (await client.callTool({
      name: 'summarize-long',
      arguments: { text: 'x'.repeat(120_000) }, // ~34k est tokens > Tier C safe limit
    })) as ToolResult;
    expect(r.isError).toBe(true);
    expect(firstText(r)).toMatch(/too large|summarize-long-chunked/i);
    expect(recorder.recorded).toHaveLength(0); // short-circuited before the model
  });

  it('extract: huge input → actionable error (split), backend NOT called', async () => {
    const r = (await client.callTool({
      name: 'extract',
      arguments: {
        text: 'y'.repeat(40_000), // > Tier B safe limit
        schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
      },
    })) as ToolResult;
    expect(r.isError).toBe(true);
    expect(firstText(r)).toMatch(/too large|split/i);
    expect(recorder.recorded).toHaveLength(0);
  });

  it('normal-size input still reaches the backend (guard does not over-trigger)', async () => {
    await client.callTool({
      name: 'summarize-long',
      arguments: { text: 'A reasonable paragraph. '.repeat(50) },
    });
    expect(recorder.recorded).toHaveLength(1);
  });
});
