/**
 * Unit tests for JobRegistry — in-memory state machine + event emitter
 * on top of JobStore.
 *
 * No Ollama, no real tools. Each test gets an isolated temp baseDir.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobStore, type JobMetadata } from '../../src/jobs/store.js';
import { JobRegistry, type JobUpdateEvent } from '../../src/jobs/registry.js';

let tmpDir: string;
let store: JobStore;
let registry: JobRegistry;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'omcp-job-registry-test-'));
  store = new JobStore({ baseDir: tmpDir });
  registry = new JobRegistry(store);
  await registry.initialize();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('JobRegistry.enqueue', () => {
  it('returns metadata with a 10-char nanoid job_id', async () => {
    const meta = await registry.enqueue('summarize', { text: 'hi' });
    expect(meta.job_id).toMatch(/^[A-Za-z0-9_-]{10}$/);
    expect(meta.tool_name).toBe('summarize');
    expect(meta.args).toEqual({ text: 'hi' });
    expect(meta.status).toBe('queued');
    expect(meta.ttl_days).toBe(7);
  });

  it('persists the metadata to the store immediately', async () => {
    const meta = await registry.enqueue('classify', { text: 'x', categories: ['a', 'b'] });
    const onDisk = await store.readMetadata(meta.job_id);
    expect(onDisk).toEqual(meta);
  });

  it('honors a custom ttl_days', async () => {
    const meta = await registry.enqueue('summarize', { text: 'hi' }, 14);
    expect(meta.ttl_days).toBe(14);
  });
});

describe('JobRegistry — dedup', () => {
  it('returns the existing job when same (tool, args) is still queued/running', async () => {
    const a = await registry.enqueue('classify', { text: 'x', categories: ['a', 'b'] });
    const b = await registry.enqueue('classify', { text: 'x', categories: ['a', 'b'] });
    expect(a.job_id).toBe(b.job_id);
  });

  it('treats arg key order as irrelevant (canonical hashing)', async () => {
    const a = await registry.enqueue('extract', {
      text: 'hi',
      schema: { type: 'object' },
    });
    const b = await registry.enqueue('extract', {
      schema: { type: 'object' },
      text: 'hi',
    });
    expect(a.job_id).toBe(b.job_id);
  });

  it('treats different args as different jobs', async () => {
    const a = await registry.enqueue('summarize', { text: 'one' });
    const b = await registry.enqueue('summarize', { text: 'two' });
    expect(a.job_id).not.toBe(b.job_id);
  });

  it('after a job completes, same args become eligible for a fresh job_id', async () => {
    const a = await registry.enqueue('summarize', { text: 'hi' });
    await registry.update(a.job_id, { status: 'done', has_result_md: true });
    const b = await registry.enqueue('summarize', { text: 'hi' });
    expect(b.job_id).not.toBe(a.job_id);
  });

  it('disabling dedup creates fresh jobs every time', async () => {
    const r2 = new JobRegistry(store, { dedupInflight: false });
    await r2.initialize();
    const a = await r2.enqueue('summarize', { text: 'hi' });
    const b = await r2.enqueue('summarize', { text: 'hi' });
    expect(a.job_id).not.toBe(b.job_id);
  });
});

describe('JobRegistry.update', () => {
  it('transitions queued → running → done; persists at each step', async () => {
    const meta = await registry.enqueue('summarize', { text: 'hi' });
    await registry.update(meta.job_id, { status: 'running', started_at: '2026-04-27T01:00:00Z' });
    let read = await store.readMetadata(meta.job_id);
    expect(read?.status).toBe('running');
    expect(read?.started_at).toBe('2026-04-27T01:00:00Z');

    await registry.update(meta.job_id, {
      status: 'done',
      finished_at: '2026-04-27T01:00:30Z',
      has_result_md: true,
      footer: '[bridge: qwen3:4b B 30000ms in=100 out=20]',
    });
    read = await store.readMetadata(meta.job_id);
    expect(read?.status).toBe('done');
    expect(read?.has_result_md).toBe(true);
  });

  it('drops terminal jobs from active tracking', async () => {
    const meta = await registry.enqueue('summarize', { text: 'hi' });
    expect(registry.activeCount()).toBe(1);
    await registry.update(meta.job_id, { status: 'done' });
    expect(registry.activeCount()).toBe(0);
  });

  it('returns null when job_id is unknown', async () => {
    expect(await registry.update('does-not-ex', { status: 'running' })).toBeNull();
  });
});

describe('JobRegistry.getMeta', () => {
  it('reads from in-memory active map first', async () => {
    const meta = await registry.enqueue('summarize', { text: 'hi' });
    const read = await registry.getMeta(meta.job_id);
    expect(read?.job_id).toBe(meta.job_id);
  });

  it('falls back to store for terminal jobs no longer tracked', async () => {
    const meta = await registry.enqueue('summarize', { text: 'hi' });
    await registry.update(meta.job_id, { status: 'done' });
    // active map cleared; store still has the .json
    const read = await registry.getMeta(meta.job_id);
    expect(read?.status).toBe('done');
  });
});

describe('JobRegistry — event emission and subscriptions', () => {
  it('onUpdate fires for the matching job_id only', async () => {
    const events: JobUpdateEvent[] = [];
    const a = await registry.enqueue('summarize', { text: 'a' });
    const unsubscribe = registry.onUpdate(a.job_id, (e) => events.push(e));

    await registry.enqueue('summarize', { text: 'b' }); // different job
    await registry.update(a.job_id, { status: 'running' });
    await registry.update(a.job_id, { status: 'done' });

    expect(events).toHaveLength(2);
    expect(events.map((e) => e.status)).toEqual(['running', 'done']);
    unsubscribe();
  });

  it('unsubscribe removes the listener (no leak across many cycles)', async () => {
    const baseline = registry.listenerCount('update');
    for (let i = 0; i < 100; i++) {
      const meta = await registry.enqueue('summarize', { text: `x${i}` });
      const unsub = registry.onUpdate(meta.job_id, () => {});
      unsub();
    }
    expect(registry.listenerCount('update')).toBe(baseline);
  });
});

describe('JobRegistry.initialize — orphan recovery', () => {
  it('marks orphaned running/queued jobs as failed on startup', async () => {
    // Pre-seed the store with an orphaned `running` job to simulate a prior crash
    const orphanMeta: JobMetadata = {
      job_id: 'orphan1234',
      tool_name: 'summarize-long-chunked',
      args: { text: 'big doc' },
      status: 'running',
      enqueued_at: '2026-04-26T23:00:00Z',
      started_at: '2026-04-26T23:00:01Z',
      ttl_days: 7,
    };
    await store.writeMetadata(orphanMeta);

    // Fresh registry on the same store — initialize should reconcile it
    const r2 = new JobRegistry(store);
    const result = await r2.initialize();

    expect(result.orphansFailed).toBe(1);
    const final = await store.readMetadata('orphan1234');
    expect(final?.status).toBe('failed');
    expect(final?.error).toBe('bridge restarted');
  });
});
