/**
 * Unit tests for the JobStore file-backed persistence layer.
 *
 * No Ollama required. Each test uses an isolated temp directory under
 * the OS temp root so no test pollutes another and we never touch the
 * project's real `.memory/`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, utimes } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobStore, type JobMetadata } from '../../src/jobs/store.js';

let tmpDir: string;
let store: JobStore;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'omcp-job-store-test-'));
  store = new JobStore({ baseDir: tmpDir });
  await store.init();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function sampleMeta(overrides: Partial<JobMetadata> = {}): JobMetadata {
  return {
    job_id: 'test12345A',
    tool_name: 'summarize',
    args: { text: 'hello world' },
    status: 'queued',
    enqueued_at: '2026-04-27T00:00:00.000Z',
    ttl_days: 7,
    ...overrides,
  };
}

describe('JobStore.init', () => {
  it('creates baseDir if missing (idempotent)', async () => {
    const sub = join(tmpDir, 'nested', 'deep');
    const s = new JobStore({ baseDir: sub });
    await s.init();
    await s.init(); // second call does not throw
    expect(existsSync(sub)).toBe(true);
  });
});

describe('JobStore — metadata round-trip', () => {
  it('writes and reads metadata', async () => {
    const meta = sampleMeta();
    await store.writeMetadata(meta);
    const read = await store.readMetadata(meta.job_id);
    expect(read).toEqual(meta);
  });

  it('returns null for unknown id', async () => {
    expect(await store.readMetadata('does-not-exist')).toBeNull();
  });

  it('overwrites previous metadata for same id', async () => {
    await store.writeMetadata(sampleMeta({ status: 'queued' }));
    await store.writeMetadata(sampleMeta({ status: 'running' }));
    const read = await store.readMetadata('test12345A');
    expect(read?.status).toBe('running');
  });

  it('writes are atomic — no .tmp leaks after success', async () => {
    await store.writeMetadata(sampleMeta());
    expect(existsSync(`${store.metadataPath('test12345A')}.tmp`)).toBe(false);
  });
});

describe('JobStore — result body', () => {
  it('writes and reads result content', async () => {
    await store.writeResult('test12345A', '# summary\n\nbody');
    const read = await store.readResult('test12345A');
    expect(read).toBe('# summary\n\nbody');
  });

  it('returns null when result not yet written', async () => {
    expect(await store.readResult('test12345A')).toBeNull();
  });
});

describe('JobStore.gcExpired', () => {
  it('keeps fresh entries; removes stale ones', async () => {
    // fresh: meta with ttl=7d, mtime now → keep
    await store.writeMetadata(sampleMeta({ job_id: 'fresh01234', ttl_days: 7 }));
    // stale: meta with ttl=1d, mtime 2 days ago → remove
    await store.writeMetadata(sampleMeta({ job_id: 'stale01234', ttl_days: 1 }));
    const stalePath = store.metadataPath('stale01234');
    const oldTime = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await utimes(stalePath, oldTime, oldTime);

    const result = await store.gcExpired();
    expect(result.removed).toContain('stale01234');
    expect(result.removed).not.toContain('fresh01234');
    expect(result.kept).toBe(1);
    expect(existsSync(store.metadataPath('fresh01234'))).toBe(true);
    expect(existsSync(store.metadataPath('stale01234'))).toBe(false);
  });

  it('also removes the .md result when expiring its .json sidecar', async () => {
    await store.writeMetadata(sampleMeta({ job_id: 'expire1234', ttl_days: 1 }));
    await store.writeResult('expire1234', 'old result body');
    const oldTime = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await utimes(store.metadataPath('expire1234'), oldTime, oldTime);

    await store.gcExpired();
    expect(existsSync(store.metadataPath('expire1234'))).toBe(false);
    expect(existsSync(store.resultPath('expire1234'))).toBe(false);
  });

  it('ignores .json.tmp leftover files (no spurious removal)', async () => {
    // Drop a .tmp file directly to simulate a half-completed write
    await writeFile(`${store.metadataPath('halfwrit12')}.tmp`, '{}');
    const result = await store.gcExpired();
    expect(result.removed).toHaveLength(0);
  });

  it('survives a corrupt .json file without crashing', async () => {
    await writeFile(store.metadataPath('corrupt123'), 'not valid json');
    const result = await store.gcExpired();
    // Corrupt file is counted as kept (we don't unilaterally delete user data)
    expect(result.kept).toBe(1);
    expect(result.removed).toHaveLength(0);
  });
});

describe('JobStore.findOrphaned', () => {
  it('reports queued + running jobs as orphaned', async () => {
    await store.writeMetadata(sampleMeta({ job_id: 'queue01234', status: 'queued' }));
    await store.writeMetadata(sampleMeta({ job_id: 'runni01234', status: 'running' }));
    await store.writeMetadata(sampleMeta({ job_id: 'doneA01234', status: 'done' }));
    await store.writeMetadata(sampleMeta({ job_id: 'failA01234', status: 'failed' }));

    const orphaned = await store.findOrphaned();
    const ids = orphaned.map((m) => m.job_id).sort();
    expect(ids).toEqual(['queue01234', 'runni01234']);
  });

  it('returns empty array when no orphaned jobs exist', async () => {
    expect(await store.findOrphaned()).toEqual([]);
  });
});

describe('JobStore — defaults', () => {
  it('defaults baseDir to <cwd>/.memory/jobs when no opts given', () => {
    const s = new JobStore();
    expect(s.baseDir.endsWith('/.memory/jobs')).toBe(true);
  });
});
