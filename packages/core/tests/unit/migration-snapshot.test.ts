/**
 * migration-snapshot.test.ts — captures and asserts the deterministic
 * payload that each MCP tool handler sends to OllamaClient.chat() for
 * a fixed set of representative inputs.
 *
 * Why: v0.2.0 commits #2-#6 will migrate each tool's handler from a
 * direct `client.chat({...})` call to `backendForTool(...).chat({...})`
 * indirection. The migration is correct iff the args reaching
 * OllamaClient.chat() are byte-identical before and after.
 *
 * This test runs in two roles across the migration window:
 *   - Pre-migration commit (#1.5): run once → vitest writes snapshot
 *     files to `__snapshots__/`. Those snapshots are the contract.
 *   - Migration commits (#2-#6): each run must match the snapshots
 *     bit-for-bit. Any drift is a behavioral regression and blocks
 *     the migration.
 *
 * Determinism is enforced by:
 *   - Disabling the defender (it injects a random spotlighting
 *     delimiter into prompts, which would make snapshots non-stable).
 *   - Routing all chat() calls into a RecorderClient that captures
 *     args and returns a fixed fake result.
 *   - Using stable, in-process MCP transport — no network, no clock.
 *
 * The recorded payload is what the *handler* chose to send. Defender
 * orchestration, response-handling, and _meta assembly are tested
 * elsewhere; this snapshot is exclusively about the chat-call args.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { buildBridgeServer } from '../../src/mcp/server.js';
import { RecorderClient } from './recorder-client.js';

/**
 * Build a fully-connected (bridge server, MCP test client) pair backed by
 * a fresh RecorderClient. Defender is disabled so prompts are deterministic.
 */
async function makeBridge(): Promise<{
  recorder: RecorderClient;
  client: Client;
}> {
  const recorder = new RecorderClient('http://recorder.invalid');
  const server = buildBridgeServer(recorder, { defendUntrusted: false });

  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: 'migration-snapshot-test', version: '0.0.0' });
  await client.connect(clientTransport);

  return { recorder, client };
}

describe('migration snapshot — pre-migration baseline', () => {
  let recorder: RecorderClient;
  let client: Client;

  beforeEach(async () => {
    ({ recorder, client } = await makeBridge());
  });

  // ── summarize ─────────────────────────────────────────────────────────────

  it('summarize: text only, no style', async () => {
    await client.callTool({
      name: 'summarize',
      arguments: { text: 'A short paragraph about cats sleeping in the sun.' },
    });
    expect(recorder.recorded).toHaveLength(1);
    expect(recorder.recorded[0]?.args).toMatchSnapshot();
  });

  it('summarize: text + style hint', async () => {
    await client.callTool({
      name: 'summarize',
      arguments: {
        text: 'A short paragraph about cats sleeping in the sun.',
        style: 'one sentence',
      },
    });
    expect(recorder.recorded).toHaveLength(1);
    expect(recorder.recorded[0]?.args).toMatchSnapshot();
  });

  // ── summarize-long ────────────────────────────────────────────────────────

  it('summarize-long: text only', async () => {
    await client.callTool({
      name: 'summarize-long',
      arguments: { text: 'A document. '.repeat(20) },
    });
    expect(recorder.recorded).toHaveLength(1);
    expect(recorder.recorded[0]?.args).toMatchSnapshot();
  });

  // ── classify ──────────────────────────────────────────────────────────────

  it('classify: single label, no explain', async () => {
    await client.callTool({
      name: 'classify',
      arguments: {
        text: 'I love this product, it works great.',
        categories: ['positive', 'negative', 'neutral'],
      },
    });
    expect(recorder.recorded).toHaveLength(1);
    expect(recorder.recorded[0]?.args).toMatchSnapshot();
  });

  it('classify: allow_multiple + explain', async () => {
    await client.callTool({
      name: 'classify',
      arguments: {
        text: 'A bug report covering login failures and missing validation.',
        categories: ['bug', 'feature', 'docs', 'security'],
        allow_multiple: true,
        explain: true,
      },
    });
    expect(recorder.recorded).toHaveLength(1);
    expect(recorder.recorded[0]?.args).toMatchSnapshot();
  });

  // ── extract ───────────────────────────────────────────────────────────────

  it('extract: flat schema with required fields', async () => {
    await client.callTool({
      name: 'extract',
      arguments: {
        text: 'Order #4521 from Alice Chen, total $89.50.',
        schema: {
          type: 'object',
          properties: {
            order_id: { type: 'string' },
            customer_name: { type: 'string' },
            total_usd: { type: 'number' },
          },
          required: ['order_id', 'customer_name', 'total_usd'],
        },
      },
    });
    expect(recorder.recorded).toHaveLength(1);
    expect(recorder.recorded[0]?.args).toMatchSnapshot();
  });

  it('extract: schema with constraints that get stripped (pattern, format:email)', async () => {
    // Sanitizer should strip the pattern + format constraints; verifies the
    // chat() format payload doesn't contain them post-sanitization.
    await client.callTool({
      name: 'extract',
      arguments: {
        text: 'Contact Alice at alice@example.com.',
        schema: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1 },
            email: { type: 'string', format: 'email', pattern: '^.+@.+$' },
          },
          required: ['name', 'email'],
        },
      },
    });
    expect(recorder.recorded).toHaveLength(1);
    expect(recorder.recorded[0]?.args).toMatchSnapshot();
  });

  // ── transform ─────────────────────────────────────────────────────────────

  it('transform: instruction + text', async () => {
    await client.callTool({
      name: 'transform',
      arguments: {
        text: 'cd /tmp && rm -rf foo',
        instruction: 'Translate to natural English prose, one sentence',
      },
    });
    expect(recorder.recorded).toHaveLength(1);
    expect(recorder.recorded[0]?.args).toMatchSnapshot();
  });
});
