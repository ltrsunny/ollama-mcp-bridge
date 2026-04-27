/**
 * JobRegistry — in-memory state machine + event emitter on top of JobStore.
 *
 * Responsibilities:
 *   - Generate job_ids (nanoid 10).
 *   - Track in-flight jobs in a Map; emit lifecycle events.
 *   - Persist every state transition through the store.
 *   - Dedup `enqueue` calls by `hash(tool_name + args)` so a frontier
 *     busy-loop doesn't queue ten copies of the same work (§12 #9).
 *   - On startup, mark previously-running orphans as failed.
 *
 * Does NOT execute jobs — that's the runner's job (next commit).
 *
 * Event channel: a single 'update' event per status change. Consumers use
 * `onUpdate(job_id, listener)` to subscribe to a specific job; the wrapper
 * filters by id and returns an unsubscribe function for clean teardown
 * (important for `wait_for_job` to avoid listener leaks across abort cycles).
 *
 * See docs/scope-memos/v0.3.0-async-jobs-and-diff-index.md §3.1, §3.5.
 */

import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import {
  JobStore,
  type JobMetadata,
  type JobProgress,
  type JobStatus,
} from './store.js';

export interface JobUpdateEvent {
  job_id: string;
  status: JobStatus;
  meta: JobMetadata;
}

export interface JobRegistryOptions {
  /**
   * If a previously-enqueued job with identical (tool_name, args) is still
   * `queued` or `running`, return that job's metadata instead of creating
   * a new one. Default true (§12 #9).
   */
  dedupInflight?: boolean;
}

export class JobRegistry extends EventEmitter {
  private readonly active = new Map<string, JobMetadata>();
  /** hash(tool_name + sorted-args) → job_id, while job is queued/running. */
  private readonly inflightHashes = new Map<string, string>();
  private readonly dedupEnabled: boolean;

  constructor(
    readonly store: JobStore,
    opts: JobRegistryOptions = {},
  ) {
    super();
    this.dedupEnabled = opts.dedupInflight ?? true;
    // Long-running registries can accumulate many concurrent waiters; raise
    // the listener cap to avoid spurious MaxListeners warnings under load.
    this.setMaxListeners(0);
  }

  /**
   * Initialize the store and reconcile any persisted state from a previous
   * bridge run. Jobs whose `status: 'queued' | 'running'` is left over from
   * a prior crash are marked `failed` with `error: 'bridge restarted'`.
   * Returns the count of orphans cleaned up for observability.
   */
  async initialize(): Promise<{ orphansFailed: number }> {
    await this.store.init();
    const orphans = await this.store.findOrphaned();
    for (const o of orphans) {
      const updated: JobMetadata = {
        ...o,
        status: 'failed',
        finished_at: new Date().toISOString(),
        error: 'bridge restarted',
      };
      await this.store.writeMetadata(updated);
    }
    return { orphansFailed: orphans.length };
  }

  /**
   * Create (or return-existing-by-dedup) a job. Always persists the
   * `queued` metadata to disk before returning so a crash before the
   * runner picks it up still leaves a recoverable record.
   */
  async enqueue(
    toolName: string,
    args: Record<string, unknown>,
    ttl_days = 7,
  ): Promise<JobMetadata> {
    if (this.dedupEnabled) {
      const h = hashRequest(toolName, args);
      const existingId = this.inflightHashes.get(h);
      if (existingId) {
        const existing = this.active.get(existingId);
        if (existing && (existing.status === 'queued' || existing.status === 'running')) {
          return existing;
        }
        this.inflightHashes.delete(h);
      }
      const job_id = nanoid(10);
      const meta: JobMetadata = {
        job_id,
        tool_name: toolName,
        args,
        status: 'queued',
        enqueued_at: new Date().toISOString(),
        ttl_days,
      };
      this.active.set(job_id, meta);
      this.inflightHashes.set(h, job_id);
      await this.store.writeMetadata(meta);
      this.emit('update', { job_id, status: 'queued', meta });
      return meta;
    }
    // Dedup disabled
    const job_id = nanoid(10);
    const meta: JobMetadata = {
      job_id,
      tool_name: toolName,
      args,
      status: 'queued',
      enqueued_at: new Date().toISOString(),
      ttl_days,
    };
    this.active.set(job_id, meta);
    await this.store.writeMetadata(meta);
    this.emit('update', { job_id, status: 'queued', meta });
    return meta;
  }

  /**
   * Get current state. Checks in-memory first (active jobs), then falls
   * back to the persistent store (terminal states or jobs from a prior
   * bridge run).
   */
  async getMeta(job_id: string): Promise<JobMetadata | null> {
    return this.active.get(job_id) ?? (await this.store.readMetadata(job_id));
  }

  /**
   * Apply a partial update to the metadata, persist, emit an event, and
   * (if the job became terminal) drop it from active tracking.
   */
  async update(job_id: string, patch: Partial<JobMetadata>): Promise<JobMetadata | null> {
    const cur = await this.getMeta(job_id);
    if (!cur) return null;
    const next: JobMetadata = { ...cur, ...patch };
    if (next.status === 'done' || next.status === 'failed') {
      this.active.delete(job_id);
      // Clear the dedup entry — same args become eligible to re-enqueue.
      const h = hashRequest(next.tool_name, next.args);
      if (this.inflightHashes.get(h) === job_id) {
        this.inflightHashes.delete(h);
      }
    } else {
      this.active.set(job_id, next);
    }
    await this.store.writeMetadata(next);
    this.emit('update', { job_id, status: next.status, meta: next });
    return next;
  }

  /** Convenience: just update progress without a status change. */
  async setProgress(job_id: string, progress: JobProgress): Promise<JobMetadata | null> {
    return this.update(job_id, { progress });
  }

  /**
   * Subscribe to lifecycle updates for a single job. Returns an
   * unsubscribe function that the caller MUST invoke when done — important
   * for `wait_for_job` whose abort path must not leave dangling listeners
   * across many wait/abort cycles.
   */
  onUpdate(job_id: string, listener: (e: JobUpdateEvent) => void): () => void {
    const wrapped = (e: JobUpdateEvent): void => {
      if (e.job_id === job_id) listener(e);
    };
    this.on('update', wrapped);
    return () => {
      this.off('update', wrapped);
    };
  }

  /** Test helper — count of currently-tracked active jobs. */
  activeCount(): number {
    return this.active.size;
  }
}

/** Stable hash of (tool_name + canonically-keyed args). For dedup only. */
function hashRequest(toolName: string, args: Record<string, unknown>): string {
  const canonical = JSON.stringify({ t: toolName, a: sortKeys(args) });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

function sortKeys<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortKeys) as unknown as T;
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[k] = sortKeys((value as Record<string, unknown>)[k]);
  }
  return sorted as unknown as T;
}
