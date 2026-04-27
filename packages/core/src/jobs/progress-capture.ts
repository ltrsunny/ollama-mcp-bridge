/**
 * Progress-capture shim for the runner — solves the "how do existing tool
 * handlers report progress when there's no MCP client to receive it"
 * problem (Gemini Auditor finding #7 from Draft 1 → Draft 2).
 *
 * The bridge's v0.2.0 tool handlers all call
 *   `await sendProgress(extra, current, total, message)`
 * which internally calls `extra.sendNotification(...)` with a
 * `notifications/progress` payload. In synchronous (direct) mode that
 * notification reaches the calling MCP client. In async (job) mode
 * there's no client listening — the runner instead substitutes this
 * shim's `extra` so progress events flow into the job's state via
 * `registry.setProgress`. Other notification types are dropped.
 *
 * Important: NO existing tool handler needs to change. They keep calling
 * `sendProgress(extra, ...)` exactly as before; the runner just hands them
 * a different `extra`.
 */

import type { JobRegistry } from './registry.js';

/**
 * Minimal structural subset of MCP SDK's RequestHandlerExtra that all v0.2.0
 * tool handlers use. Matching `ToolExtra` in `src/mcp/server.ts`.
 */
export interface ProgressCaptureExtra {
  /** Always present — the registry's per-job AbortController.signal. */
  signal: AbortSignal;
  /** Receives notifications from the wrapped tool. Progress events are
   *  routed to the registry; other notifications are dropped. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendNotification: (notification: any) => Promise<void>;
  /** A progress token so the wrapped tool's `sendProgress` helper triggers. */
  _meta: { progressToken: string };
}

/** Build the shim plus an AbortController the runner can fire if needed. */
export function createProgressCapture(
  registry: JobRegistry,
  job_id: string,
): { extra: ProgressCaptureExtra; controller: AbortController } {
  const controller = new AbortController();

  const extra: ProgressCaptureExtra = {
    signal: controller.signal,
    _meta: { progressToken: `job:${job_id}` },
    sendNotification: async (notification): Promise<void> => {
      if (notification?.method === 'notifications/progress') {
        const params = notification.params ?? {};
        await registry.setProgress(job_id, {
          current: typeof params.progress === 'number' ? params.progress : 0,
          total: typeof params.total === 'number' ? params.total : 0,
          message: typeof params.message === 'string' ? params.message : '',
        });
      }
      // Other notification kinds are dropped — there's no transport to
      // forward them to in async mode.
    },
  };

  return { extra, controller };
}
