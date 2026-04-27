/**
 * Unit tests for the `enqueue-job` MCP tool registration.
 *
 * Wires a real JobStore + JobRegistry but uses a FakeBackend-style
 * ToolInvoker for the runner. Goes through the MCP transport so the tool
 * surface (schema validation, response shape) is exercised end-to-end.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { buildBridgeServer, type CapturedToolHandler } from '../../src/mcp/server.js';
import { JobStore } from '../../src/jobs/store.js';
import { JobRegistry } from '../../src/jobs/registry.js';
import { JobRunner } from '../../src/jobs/runner.js';
import { RecorderClient } from './recorder-client.js';

let tmpDir: string;
let store: JobStore;
let registry: JobRegistry;
let runner: JobRunner;
let recorderClient: RecorderClient;
let client: Client;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'omcp-enqueue-job-test-'));
  store = new JobStore({ baseDir: tmpDir });
  registry = new JobRegistry(store);
  await registry.initialize();

  const toolHandlers = new Map<string, CapturedToolHandler>();
  // ToolInvoker that resolves the handler from the Map at call time.
  // It will be empty by the time runner is created — populated when
  // buildBridgeServer registers tools below.
  runner = new JobRunner(
    registry,
    async (toolName, args, extra) => {
      const handler = toolHandlers.get(toolName);
      if (!handler) {
        return { isError: true, content: [{ type: 'text', text: `Unknown: ${toolName}` }] };
      }
      return (await handler(args, extra)) as { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
    },
    { concurrency: 1 },
  );

  recorderClient = new RecorderClient('http://recorder.invalid');
  const server = buildBridgeServer(recorderClient, {
    defendUntrusted: false,
    jobRegistry: registry,
    jobRunner: runner,
    toolHandlers,
  });

  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'enqueue-job-test', version: '0.0.0' });
  await client.connect(clientTransport);
});

afterEach(async () => {
  await client.close();
  // Wait for any in-flight runner work to finish before deleting the tmp
  // dir; otherwise rm -rf races with file writes and ENOTEMPTY.
  await runner.waitIdle();
  await rm(tmpDir, { recursive: true, force: true });
});

describe('enqueue-job tool registration', () => {
  it('appears in tools/list', async () => {
    const list = await client.listTools();
    const names = list.tools.map((t) => t.name);
    expect(names).toContain('enqueue-job');
    // Also confirm v0.2.0 tools still listed
    expect(names).toContain('summarize');
    expect(names).toContain('summarize-long-chunked');
  });

  it('returns a job_id for a valid tool_name + args; persists metadata', async () => {
    const result = await client.callTool({
      name: 'enqueue-job',
      arguments: {
        tool_name: 'summarize',
        args: { text: 'hello world' },
      },
    });
    expect((result as { isError?: boolean }).isError).toBeFalsy();
    const content = (result as { content: Array<{ type: string; text: string }> }).content;
    const body = content[0]?.text ?? '';
    const parsed = JSON.parse(body);
    expect(parsed.job_id).toMatch(/^[A-Za-z0-9_-]{10}$/);
    expect(typeof parsed.enqueued_at).toBe('string');
    expect(typeof parsed.expires_at).toBe('string');

    // Persisted to disk
    const onDisk = await store.readMetadata(parsed.job_id);
    expect(onDisk).not.toBeNull();
    expect(onDisk?.tool_name).toBe('summarize');
  });

  it('rejects unknown tool_name (schema enum)', async () => {
    // Either the SDK throws on Zod validation, or the server responds
    // with isError: true. Both are acceptable; what matters is that a
    // bogus name does NOT silently land in the .memory/jobs/ store.
    let rejected = false;
    try {
      const result = await client.callTool({
        name: 'enqueue-job',
        arguments: {
          tool_name: 'not-a-real-tool',
          args: { text: 'hi' },
        },
      });
      if ((result as { isError?: boolean }).isError) rejected = true;
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);

    // No metadata file should have been written for this bogus call.
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(tmpDir);
    expect(files.filter((f) => f.endsWith('.json'))).toHaveLength(0);
  });

  it('honors a custom ttl_days parameter', async () => {
    const result = await client.callTool({
      name: 'enqueue-job',
      arguments: {
        tool_name: 'classify',
        args: { text: 'spam', categories: ['spam', 'ham'] },
        ttl_days: 14,
      },
    });
    const body = (result as { content: Array<{ text: string }> }).content[0]?.text ?? '';
    const parsed = JSON.parse(body);
    const meta = await store.readMetadata(parsed.job_id);
    expect(meta?.ttl_days).toBe(14);
  });

  it('dedups identical (tool_name, args) while previous job is still queued', async () => {
    const a = await client.callTool({
      name: 'enqueue-job',
      arguments: { tool_name: 'summarize', args: { text: 'same input' } },
    });
    const b = await client.callTool({
      name: 'enqueue-job',
      arguments: { tool_name: 'summarize', args: { text: 'same input' } },
    });
    const aId = JSON.parse((a as { content: Array<{ text: string }> }).content[0]!.text).job_id;
    const bId = JSON.parse((b as { content: Array<{ text: string }> }).content[0]!.text).job_id;
    expect(aId).toBe(bId);
  });
});
