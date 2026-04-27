/**
 * Unit tests for JobRunner — runs enqueued jobs through a ToolInvoker
 * and updates the registry. Uses fake invokers; no Ollama, no MCP.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobStore } from '../../src/jobs/store.js';
import { JobRegistry } from '../../src/jobs/registry.js';
import { JobRunner, type ToolInvoker, type ToolResult } from '../../src/jobs/runner.js';
import type { ProgressCaptureExtra } from '../../src/jobs/progress-capture.js';

let tmpDir: string;
let store: JobStore;
let registry: JobRegistry;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'omcp-job-runner-test-'));
  store = new JobStore({ baseDir: tmpDir });
  registry = new JobRegistry(store);
  await registry.initialize();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

/** Build a fake invoker that always succeeds with a given text + footer. */
function fixedInvoker(text: string, footer?: string): ToolInvoker {
  return async () => {
    const content: ToolResult['content'] = [{ type: 'text', text }];
    if (footer) content.push({ type: 'text', text: footer });
    return { content };
  };
}

describe('JobRunner — happy path', () => {
  it('runs a job to completion: queued → running → done; persists .md and footer', async () => {
    const runner = new JobRunner(
      registry,
      fixedInvoker('summary body', '[bridge: qwen3:4b B 1234ms in=10 out=5]'),
    );
    const meta = await registry.enqueue('summarize', { text: 'hi' });
    runner.schedule(meta);
    await runner.waitIdle();

    const final = await store.readMetadata(meta.job_id);
    expect(final?.status).toBe('done');
    expect(final?.started_at).toBeDefined();
    expect(final?.finished_at).toBeDefined();
    expect(final?.has_result_md).toBe(true);
    expect(final?.footer).toBe('[bridge: qwen3:4b B 1234ms in=10 out=5]');

    const body = await store.readResult(meta.job_id);
    expect(body).toContain('summary body');
    expect(body).toContain('[bridge:');
  });

  it('handles tool result without footer cleanly', async () => {
    const runner = new JobRunner(registry, fixedInvoker('plain text result'));
    const meta = await registry.enqueue('summarize', { text: 'hi' });
    runner.schedule(meta);
    await runner.waitIdle();

    const final = await store.readMetadata(meta.job_id);
    expect(final?.status).toBe('done');
    expect(final?.footer).toBeUndefined();
  });
});

describe('JobRunner — failure paths', () => {
  it('captures isError result as failed status with error message', async () => {
    const errorInvoker: ToolInvoker = async () => ({
      isError: true,
      content: [{ type: 'text', text: 'Cannot reach Ollama daemon at ...' }],
    });
    const runner = new JobRunner(registry, errorInvoker);
    const meta = await registry.enqueue('summarize', { text: 'hi' });
    runner.schedule(meta);
    await runner.waitIdle();

    const final = await store.readMetadata(meta.job_id);
    expect(final?.status).toBe('failed');
    expect(final?.error).toContain('Cannot reach Ollama daemon');
    expect(final?.has_result_md).toBeFalsy();
  });

  it('captures thrown errors as failed status', async () => {
    const throwingInvoker: ToolInvoker = async () => {
      throw new Error('synthetic crash inside handler');
    };
    const runner = new JobRunner(registry, throwingInvoker);
    const meta = await registry.enqueue('summarize', { text: 'hi' });
    runner.schedule(meta);
    await runner.waitIdle();

    const final = await store.readMetadata(meta.job_id);
    expect(final?.status).toBe('failed');
    expect(final?.error).toBe('synthetic crash inside handler');
  });
});

describe('JobRunner — concurrency', () => {
  it('runs jobs sequentially when concurrency = 1 (default)', async () => {
    const order: string[] = [];
    const slowInvoker: ToolInvoker = async (_toolName, args) => {
      const id = (args as { id: string }).id;
      order.push(`start-${id}`);
      await new Promise((r) => setTimeout(r, 30));
      order.push(`end-${id}`);
      return { content: [{ type: 'text', text: `result-${id}` }] };
    };
    const runner = new JobRunner(registry, slowInvoker);
    const a = await registry.enqueue('summarize', { id: 'A' });
    const b = await registry.enqueue('summarize', { id: 'B' });
    const c = await registry.enqueue('summarize', { id: 'C' });
    runner.schedule(a);
    runner.schedule(b);
    runner.schedule(c);
    await runner.waitIdle();

    // Sequential = each end happens before the next start
    expect(order).toEqual([
      'start-A', 'end-A',
      'start-B', 'end-B',
      'start-C', 'end-C',
    ]);
  });

  it('allows parallel execution when concurrency > 1', async () => {
    const order: string[] = [];
    const slowInvoker: ToolInvoker = async (_toolName, args) => {
      const id = (args as { id: string }).id;
      order.push(`start-${id}`);
      await new Promise((r) => setTimeout(r, 30));
      order.push(`end-${id}`);
      return { content: [{ type: 'text', text: `r-${id}` }] };
    };
    const runner = new JobRunner(registry, slowInvoker, { concurrency: 3 });
    const a = await registry.enqueue('summarize', { id: 'A' });
    const b = await registry.enqueue('summarize', { id: 'B' });
    const c = await registry.enqueue('summarize', { id: 'C' });
    runner.schedule(a);
    runner.schedule(b);
    runner.schedule(c);
    await runner.waitIdle();

    // Parallel = first three entries are all start-*
    expect(order.slice(0, 3).every((s) => s.startsWith('start-'))).toBe(true);
  });
});

describe('JobRunner — progress capture', () => {
  it('routes sendProgress notifications into the job state', async () => {
    const progressInvoker: ToolInvoker = async (_t, _a, extra) => {
      await extra.sendNotification({
        method: 'notifications/progress',
        params: { progress: 1, total: 3, message: 'step 1' },
      });
      await extra.sendNotification({
        method: 'notifications/progress',
        params: { progress: 2, total: 3, message: 'step 2' },
      });
      await extra.sendNotification({
        method: 'notifications/progress',
        params: { progress: 3, total: 3, message: 'final' },
      });
      return { content: [{ type: 'text', text: 'all done' }] };
    };
    const runner = new JobRunner(registry, progressInvoker);
    const meta = await registry.enqueue('summarize-long-chunked', { text: 'big' });

    // Capture every progress event the registry observes for this job
    const seen: Array<{ current: number; total: number; message: string }> = [];
    const unsub = registry.onUpdate(meta.job_id, (e) => {
      if (e.meta.progress) {
        seen.push({
          current: e.meta.progress.current,
          total: e.meta.progress.total,
          message: e.meta.progress.message,
        });
      }
    });

    runner.schedule(meta);
    await runner.waitIdle();
    unsub();

    // Note: the `done` status update at the end re-emits with the same
    // progress carried forward, so seen.length may be 4+ — we want the
    // first three distinct progress events, not the last three.
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(seen[0]?.message).toBe('step 1');
    expect(seen[1]?.message).toBe('step 2');
    expect(seen[2]?.message).toBe('final');
  });

  it('drops non-progress notifications silently (no crash)', async () => {
    const noisyInvoker: ToolInvoker = async (_t, _a, extra) => {
      // Some unrelated notification — runner should ignore it
      await extra.sendNotification({
        method: 'notifications/something_else',
        params: { random: 'data' },
      });
      return { content: [{ type: 'text', text: 'ok' }] };
    };
    const runner = new JobRunner(registry, noisyInvoker);
    const meta = await registry.enqueue('summarize', { text: 'hi' });
    runner.schedule(meta);
    await runner.waitIdle();
    const final = await store.readMetadata(meta.job_id);
    expect(final?.status).toBe('done');
  });
});
