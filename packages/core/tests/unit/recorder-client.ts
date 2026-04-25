/**
 * RecorderClient — test double for OllamaClient that captures every
 * `chat()` invocation's args verbatim and returns a fixed ChatResult.
 *
 * Used by migration-snapshot.test.ts to verify that the migration of
 * each tool handler from `client.chat(...)` direct calls to
 * `backend.chat(...)` indirection does not change the args that
 * actually reach OllamaClient. If the recorded args are byte-identical
 * before and after migration, the migration is provably non-behavioral.
 *
 * Not part of the runtime — tests/unit/* is excluded from the published
 * dist via tsconfig include rules.
 */

import { OllamaClient, type ChatOptions, type ChatResult } from '../../src/ollama/client.js';

export interface RecordedCall {
  /** The full ChatOptions passed to chat() for this call. */
  args: ChatOptions;
  /** Wall-clock order; useful when a single test triggers multiple chat calls. */
  index: number;
}

/**
 * Fixed ChatResult returned for every recorded call. Token counts are
 * arbitrary but non-zero so any caller that propagates them to telemetry
 * doesn't blow up on division-by-zero.
 */
export const FAKE_CHAT_RESULT: ChatResult = {
  text: '<<recorder fake response>>',
  promptTokens: 100,
  completionTokens: 20,
};

export class RecorderClient extends OllamaClient {
  readonly recorded: RecordedCall[] = [];

  override async chat(opts: ChatOptions): Promise<ChatResult> {
    // Deep-clone the args so subsequent mutations by the caller (if any)
    // don't retroactively change the recording. Spread is shallow but
    // ChatOptions is a flat record of primitives + a Buffer-free `format`
    // object, so a JSON round-trip is safe and readable in snapshots.
    const cloned = JSON.parse(JSON.stringify(opts)) as ChatOptions;
    this.recorded.push({ args: cloned, index: this.recorded.length });
    return FAKE_CHAT_RESULT;
  }

  override async ping(): Promise<{ version: string }> {
    return { version: 'recorder-fake' };
  }

  reset(): void {
    this.recorded.length = 0;
  }
}
