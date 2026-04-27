/**
 * Job Memory Bank — file-backed persistent store for v0.3.0 async jobs.
 *
 * Files per job (under `<baseDir>/<job_id>`):
 *   - `<id>.json` — metadata sidecar: tool, args, status, timestamps,
 *     progress, error, footer
 *   - `<id>.md`   — main result body (only present when `status: 'done'`)
 *
 * Atomic writes: we always write to `<id>.json.tmp` + `<id>.md.tmp` then
 * `fs.rename()` to the final name. Rename is atomic on POSIX when both
 * paths are on the same filesystem, which they are here.
 *
 * GC: TTL-based, scanned at bridge startup and on demand. Default 7 days
 * since last mtime on the metadata file.
 *
 * No external deps — only `node:fs/promises` and `node:path`. p-queue and
 * nanoid land in the next commit alongside jobs/registry.ts.
 *
 * See docs/scope-memos/v0.3.0-async-jobs-and-diff-index.md §3, §6 for
 * design and failure-mode coverage.
 */

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Lifecycle states of a job from enqueue through result. */
export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

/** Optional in-flight progress reporting, captured from tool's `extra.sendProgress`. */
export interface JobProgress {
  current: number;
  total: number;
  message: string;
}

/**
 * Metadata sidecar — fully serializable (no functions, no AbortControllers).
 * Anything the registry needs at restart time must live here.
 */
export interface JobMetadata {
  /** nanoid(10), path-safe. */
  job_id: string;
  /** Whitelisted v0.2.0 tool name. Validated by the registry, not by the store. */
  tool_name: string;
  /** Args forwarded to the wrapped tool. Stored verbatim for re-entry / debugging. */
  args: Record<string, unknown>;
  status: JobStatus;
  /** ISO 8601 timestamps. */
  enqueued_at: string;
  started_at?: string;
  finished_at?: string;
  /** Failure reason; populated only when `status: 'failed'`. */
  error?: string;
  /** Days from `enqueued_at` until GC. Configurable per-job at enqueue time. */
  ttl_days: number;
  /** Latest progress emitted by the wrapped tool's `sendProgress` calls. */
  progress?: JobProgress;
  /** Footer string from the underlying tool's response (last `[bridge: …]` line). */
  footer?: string;
  /** Whether the `<id>.md` result body has been written yet. */
  has_result_md?: boolean;
}

export interface JobStoreOptions {
  /**
   * Directory under which `<id>.json` and `<id>.md` files live.
   * Defaults to `<process.cwd()>/.memory/jobs`. Override via constructor
   * (typically server wires `OMCP_MEMORY_DIR` env into this).
   */
  baseDir?: string;
}

/**
 * Pure file-store API. Stateless across method calls — every method does
 * fs I/O afresh. Concurrency is NOT serialized at this layer; the registry
 * (next commit) owns the in-memory locking.
 */
export class JobStore {
  readonly baseDir: string;

  constructor(opts: JobStoreOptions = {}) {
    this.baseDir = opts.baseDir ?? join(process.cwd(), '.memory', 'jobs');
  }

  /**
   * Ensure baseDir exists. Idempotent. Called by registry at startup; safe
   * to call repeatedly.
   */
  async init(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
  }

  /** Path helpers (also used by tests to verify on-disk artifacts). */
  metadataPath(id: string): string {
    return join(this.baseDir, `${id}.json`);
  }
  resultPath(id: string): string {
    return join(this.baseDir, `${id}.md`);
  }

  /**
   * Persist or update a metadata record. Atomic: writes to `.tmp` then
   * renames. Concurrent writes for the same id will race; the registry
   * caller is expected to serialize per-job updates (an in-memory mutex
   * on the job_id).
   */
  async writeMetadata(meta: JobMetadata): Promise<void> {
    const finalPath = this.metadataPath(meta.job_id);
    const tmpPath = `${finalPath}.tmp`;
    const body = `${JSON.stringify(meta, null, 2)}\n`;
    await writeFile(tmpPath, body, { encoding: 'utf-8' });
    await rename(tmpPath, finalPath);
  }

  /** Returns null when the file doesn't exist (job never created or already GC'd). */
  async readMetadata(id: string): Promise<JobMetadata | null> {
    try {
      const raw = await readFile(this.metadataPath(id), 'utf-8');
      return JSON.parse(raw) as JobMetadata;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  /**
   * Persist the result body. Caller is responsible for setting
   * `has_result_md: true` on the metadata sidecar after this resolves.
   * Atomic write via `.tmp` + rename.
   */
  async writeResult(id: string, content: string): Promise<void> {
    const finalPath = this.resultPath(id);
    const tmpPath = `${finalPath}.tmp`;
    await writeFile(tmpPath, content, { encoding: 'utf-8' });
    await rename(tmpPath, finalPath);
  }

  /** Returns null when the result file doesn't exist or job hasn't completed. */
  async readResult(id: string): Promise<string | null> {
    try {
      return await readFile(this.resultPath(id), 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  /**
   * Scan baseDir for `<id>.json` files whose `mtime + ttl_days` is in the
   * past. Remove the .json AND any matching .md. Idempotent. Safe to run
   * concurrently with active writes (rename collisions on .tmp are rare
   * and survive ENOENT during cleanup).
   *
   * Returns the list of removed job_ids and the count of kept files for
   * easy assertion in tests.
   */
  async gcExpired(now: Date = new Date()): Promise<{ removed: string[]; kept: number }> {
    await this.init();
    const entries = await readdir(this.baseDir);
    const removed: string[] = [];
    let kept = 0;

    for (const entry of entries) {
      if (!entry.endsWith('.json') || entry.endsWith('.json.tmp')) continue;
      const id = entry.slice(0, -'.json'.length);
      const metaPath = this.metadataPath(id);
      let meta: JobMetadata | null;
      try {
        meta = await this.readMetadata(id);
      } catch {
        // Corrupt JSON — leave it; manual cleanup if needed.
        kept++;
        continue;
      }
      if (!meta) continue;
      const ttlMs = meta.ttl_days * 24 * 60 * 60 * 1000;
      let metaStat;
      try {
        metaStat = await stat(metaPath);
      } catch {
        continue;
      }
      const ageMs = now.getTime() - metaStat.mtimeMs;
      if (ageMs > ttlMs) {
        await rm(metaPath, { force: true });
        await rm(this.resultPath(id), { force: true });
        removed.push(id);
      } else {
        kept++;
      }
    }
    return { removed, kept };
  }

  /**
   * Find jobs whose persisted status is `running` or `queued` — i.e., they
   * were either mid-flight when the bridge crashed, or never picked up.
   * Used at startup to mark them as `failed` with `error: 'bridge restarted'`.
   */
  async findOrphaned(): Promise<JobMetadata[]> {
    await this.init();
    const entries = await readdir(this.baseDir);
    const orphaned: JobMetadata[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json') || entry.endsWith('.json.tmp')) continue;
      const id = entry.slice(0, -'.json'.length);
      const meta = await this.readMetadata(id);
      if (meta && (meta.status === 'running' || meta.status === 'queued')) {
        orphaned.push(meta);
      }
    }
    return orphaned;
  }
}
