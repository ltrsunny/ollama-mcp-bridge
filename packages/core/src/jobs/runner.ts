/**
 * JobRunner — schedules and executes enqueued jobs.
 *
 * Concurrency: bounded by `p-queue`. Default = 1 because oMLX serializes
 * on a single Metal context anyway; concurrency > 1 just adds queueing
 * overhead. Configurable via `OMCP_JOB_CONCURRENCY`.
 *
 * Tool invocation: the runner holds a `ToolInvoker` callback that knows
 * how to call the MCP-registered handlers. The bridge wires this at server
 * construction time. Tests use a fake invoker — keeps the runner pure.
 *
 * Progress: each job execution gets its own `progress-capture` shim so the
 * wrapped handler's `extra.sendProgress(...)` calls flow into the job's
 * registry state. `wait_for_job` then surfaces the latest `progress` field.
 *
 * See docs/scope-memos/v0.3.0-async-jobs-and-diff-index.md §3.5.
 */

import PQueue from 'p-queue';
import type { JobRegistry } from './registry.js';
import type { JobMetadata } from './store.js';
import { createProgressCapture, type ProgressCaptureExtra } from './progress-capture.js';

/** Shape of an MCP tool response (a structural subset of CallToolResult). */
export interface ToolResult {
  isError?: boolean;
  content: Array<{ type: 'text'; text: string }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _meta?: Record<string, any>;
}

/** What the runner uses to invoke an underlying MCP tool handler. */
export type ToolInvoker = (
  toolName: string,
  args: Record<string, unknown>,
  extra: ProgressCaptureExtra,
) => Promise<ToolResult>;

export interface JobRunnerOptions {
  /** Default 1 — oMLX serializes on Metal so >1 mostly adds queueing. */
  concurrency?: number;
}

export class JobRunner {
  private readonly queue: PQueue;

  constructor(
    private readonly registry: JobRegistry,
    private readonly invoker: ToolInvoker,
    opts: JobRunnerOptions = {},
  ) {
    this.queue = new PQueue({ concurrency: opts.concurrency ?? 1 });
  }

  /**
   * Schedule a job for execution. Returns when the job is *queued* (within
   * microseconds), NOT when it completes. The async execution updates the
   * registry as it progresses so callers can observe via `wait_for_job`.
   *
   * Errors during execution are captured into the job's `error` field —
   * the queue itself never sees an unhandled rejection.
   */
  schedule(job: JobMetadata): void {
    void this.queue.add(() => this.execute(job));
  }

  /** Test helper — wait until the queue drains. */
  async waitIdle(): Promise<void> {
    await this.queue.onIdle();
  }

  private async execute(job: JobMetadata): Promise<void> {
    await this.registry.update(job.job_id, {
      status: 'running',
      started_at: new Date().toISOString(),
    });

    const { extra } = createProgressCapture(this.registry, job.job_id);

    try {
      // Inject thinking mode into args before invoking the wrapped tool,
      // so it sees the same `thinking` field a sync caller would have set.
      // Only set when the registry resolved a concrete on/off — leaves the
      // wrapped tool to its own registry default otherwise.
      //
      // Deep-clone via structuredClone to defend against the wrapped tool
      // mutating nested objects (e.g. an extract handler that mutates a
      // schema's properties dict). Adversarial review (gem/copilot/nv_pro)
      // flagged the prior shallow spread `{ ...job.args, thinking: ... }`
      // as race-prone when runner concurrency > 1 or when the same job is
      // re-read from disk; the deep clone shifts the immutability contract
      // from "trust the handler" to "enforce at the boundary".
      const baseArgs: Record<string, unknown> = structuredClone(job.args);
      const argsForInvoke: Record<string, unknown> =
        job.thinking_resolved !== undefined
          ? { ...baseArgs, thinking: job.thinking_resolved }
          : baseArgs;
      const result = await this.invoker(job.tool_name, argsForInvoke, extra);
      const text = result.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n');
      const footer = extractFooter(result.content);

      if (result.isError) {
        await this.registry.update(job.job_id, {
          status: 'failed',
          finished_at: new Date().toISOString(),
          error: text || 'tool returned isError',
          ...(footer !== undefined ? { footer } : {}),
        });
        return;
      }

      // Persist the result body as <id>.md
      await this.registry.store.writeResult(job.job_id, text);
      await this.registry.update(job.job_id, {
        status: 'done',
        finished_at: new Date().toISOString(),
        has_result_md: true,
        ...(footer !== undefined ? { footer } : {}),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.registry.update(job.job_id, {
        status: 'failed',
        finished_at: new Date().toISOString(),
        error: msg,
      });
    }
  }
}

/** Find the last `[bridge: …]` footer line in the content array, if any. */
function extractFooter(
  content: Array<{ type: string; text?: string }>,
): string | undefined {
  for (let i = content.length - 1; i >= 0; i--) {
    const c = content[i];
    if (c?.type === 'text' && typeof c.text === 'string' && c.text.startsWith('[bridge:')) {
      return c.text;
    }
  }
  return undefined;
}
