# CODE REVIEW (recall mode, xhigh) — find REAL bugs in the diff below

You are ONE independent adversarial reviewer. Surface up to 8 real bugs. For each:
`file:line` + one-sentence bug + concrete failure scenario (inputs/state → wrong output/crash).
Be concrete; mark uncertain leads [unverified]. No fabricated line numbers.

Context: local-mcp-toolbelt bridge (Node/TS). Two fixes:
(1) `MlxHttpBackend.chat` now THROWS on an empty completion (was: returned empty as success).
(2) `summarize-long` handler now `.catch`es that error and falls back to `chunkedSummarize`.

Hunt these angles (cover what you can):
- Line-by-line: the empty-check `text.trim()===''`; the recoverable regex
  `/EMPTY completion|memory[ -]?guard|prefill|exceeds? .*(limit|context)/i` (false matches? misses real guard errors?); `extra.signal?.aborted` handling.
- REMOVED behavior: the old "empty → graceful empty result" path is gone. Does ANY caller rely on chat() returning empty-success and now break?
- CROSS-FILE (key): `chat()` throwing on empty affects EVERY caller. `chunkedSummarize` calls chat per MAP chunk + REDUCE. If ONE chunk hits the guard and chat throws, does chunkedSummarize catch it / retry / skip — or does the WHOLE chunked summarize (and thus the new summarize-long fallback) abort? Trace it.
- The fallback: it calls `chunkedSummarize` with `src.text` (NOT the defender-wrapped `safeText`) and omits onProgress/temperature/maxOutputTokens. Security (spotlighting dropped)? UX (no progress)? Correctness?
- Efficiency/altitude/conventions: wasted ~56s failed prefill before fallback; right depth? CLAUDE.md rules (touches packages/core runtime).

[DIFF UNDER REVIEW]
diff --git a/packages/core/src/llm/mlx-http-backend.ts b/packages/core/src/llm/mlx-http-backend.ts
index 3f0260c..49c7da6 100644
--- a/packages/core/src/llm/mlx-http-backend.ts
+++ b/packages/core/src/llm/mlx-http-backend.ts
@@ -481,6 +481,23 @@ export class MlxHttpBackend implements LlmBackend {
     const promptTokens = data.usage?.prompt_tokens ?? 0;
     const completionTokens = data.usage?.completion_tokens ?? 0;
 
+    // An empty completion is NEVER a valid success. oMLX returns a 200 with
+    // empty content (and typically prompt_tokens=0/completion_tokens=0) when a
+    // decode aborts or the prefill memory guard soft-rejects — observed
+    // DETERMINISTICALLY on a ~9.9 K-token input under 16 GB pressure. Returning
+    // it as an empty-but-successful result silently corrupts EVERY downstream
+    // consumer (summarize/extract/classify/transform all funnel through here),
+    // so fail loudly instead. The `in=0 out=0` footer was the tell.
+    if (text.trim() === '') {
+      throw new Error(
+        `MlxHttpBackend: oMLX returned an EMPTY completion ` +
+          `(prompt_tokens=${promptTokens}, completion_tokens=${completionTokens}). ` +
+          `Likely a decode abort or a prefill memory-guard rejection under memory ` +
+          `pressure. For a large input use summarize-long-chunked or shrink it; ` +
+          `otherwise retry once the engine is idle.`,
+      );
+    }
+
     return { text, promptTokens, completionTokens };
   }
 
diff --git a/packages/core/src/mcp/server.ts b/packages/core/src/mcp/server.ts
index 2fc8235..cab3d51 100644
--- a/packages/core/src/mcp/server.ts
+++ b/packages/core/src/mcp/server.ts
@@ -609,17 +609,42 @@ export function buildBridgeServer(
         await sendProgress(extra, 2, 3, 'generating…');
         const user = style ? `Style override: ${style}\n\nSource:\n${safeText}` : `Source:\n${safeText}`;
         const backend = backendForTool(config, 'summarize-long');
-        const result = await backend.chat(
-          {
-            system: systemPrompt,
-            user,
-            temperature: 0.2,
-            maxInputTokens: tierCfg.numCtx ?? 8192,
-            maxOutputTokens: MAX_OUTPUT_TOKENS['summarize-long'],
-            disableThinking: resolveThinking('summarize-long', thinking) === 'off',
-          },
-          extra.signal,
-        );
+        let result = await backend
+          .chat(
+            {
+              system: systemPrompt,
+              user,
+              temperature: 0.2,
+              maxInputTokens: tierCfg.numCtx ?? 8192,
+              maxOutputTokens: MAX_OUTPUT_TOKENS['summarize-long'],
+              disableThinking: resolveThinking('summarize-long', thinking) === 'off',
+            },
+            extra.signal,
+          )
+          .catch(async (err: unknown) => {
+            // The single Tier-C call hit the oMLX prefill memory guard / returned an
+            // empty completion. This is PRESSURE-dependent on a one-hot 16 GB box, not a
+            // fixed size ceiling — and an error here is still a failure to the caller
+            // (an error IS a bug). So instead of surfacing it, TRANSPARENTLY fall back to
+            // the chunked map-reduce path: smaller per-chunk prefills fit under the guard,
+            // so the summary actually succeeds. (Genuinely huge inputs may still exceed the
+            // 60 s wall while chunking — that surfaces — but pressure rejections recover here.)
+            const msg = (err as Error)?.message ?? '';
+            const recoverable = /EMPTY completion|memory[ -]?guard|prefill|exceeds? .*(limit|context)/i.test(msg);
+            if (!recoverable || extra.signal?.aborted) throw err;
+            await sendProgress(extra, 2, 3, 'single call hit the memory guard — falling back to chunked map-reduce…');
+            return chunkedSummarize({
+              source: src.text,
+              style,
+              backend,
+              maxInputTokens: tierCfg.numCtx ?? 8192,
+              signal: extra.signal,
+              chunkSize: parseEnvInt('OMCP_CHUNK_SIZE'),
+              chunkOverlap: parseEnvInt('OMCP_CHUNK_OVERLAP'),
+              disableThinking: resolveThinking('summarize-long', thinking) === 'off',
+              concurrency: parseEnvInt('OMCP_CHUNK_CONCURRENCY'),
+            });
+          });
         const latencyMs = Date.now() - t0;
         const savedInputTokensEstimate = src.bytes !== undefined
           ? Math.max(0, Math.floor(src.bytes / 4) - result.completionTokens)
diff --git a/packages/core/tests/unit/mlx-http-backend.test.ts b/packages/core/tests/unit/mlx-http-backend.test.ts
index 9d80fb6..529b949 100644
--- a/packages/core/tests/unit/mlx-http-backend.test.ts
+++ b/packages/core/tests/unit/mlx-http-backend.test.ts
@@ -209,16 +209,28 @@ describe('MlxHttpBackend', () => {
     expect(body.max_tokens).toBeUndefined();
   });
 
-  it('handles empty completions gracefully (no choices)', async () => {
+  it('THROWS on an empty completion — no choices (silent-empty guard)', async () => {
+    // An empty completion must fail loudly, never return empty-success: oMLX
+    // returns a 200 with empty content on a decode-abort / prefill-guard reject,
+    // and passing that through silently corrupts every downstream tool.
+    // Regression: summarize-long deterministically returned in=0/out=0.
     const mockFetch = vi.fn().mockResolvedValue(
       makeOkResponse({ id: 'x', choices: [] }),
     );
     vi.stubGlobal('fetch', mockFetch);
 
-    const result = await backend.chat({ user: 'hi', maxInputTokens: 4096 });
-    expect(result.text).toBe('');
-    expect(result.promptTokens).toBe(0);
-    expect(result.completionTokens).toBe(0);
+    await expect(
+      backend.chat({ user: 'hi', maxInputTokens: 4096 }),
+    ).rejects.toThrow(/empty completion/i);
+  });
+
+  it('THROWS on an empty completion — choices present but blank content', async () => {
+    const mockFetch = vi.fn().mockResolvedValue(makeOkResponse(chatResponse('')));
+    vi.stubGlobal('fetch', mockFetch);
+
+    await expect(
+      backend.chat({ user: 'hi', maxInputTokens: 4096 }),
+    ).rejects.toThrow(/empty completion/i);
   });
 
   // ── error handling ────────────────────────────────────────────────────
diff --git a/packages/core/tests/unit/summarize-long-chunk-fallback.test.ts b/packages/core/tests/unit/summarize-long-chunk-fallback.test.ts
new file mode 100644
index 0000000..f48ea5d
--- /dev/null
+++ b/packages/core/tests/unit/summarize-long-chunk-fallback.test.ts
@@ -0,0 +1,115 @@
+/**
+ * Regression: `summarize-long` must NOT surface an error when its single
+ * Tier-C call hits the oMLX prefill memory guard (empty completion). An error
+ * to the caller is still a failure ("an error IS a bug"), so the handler
+ * transparently falls back to the chunked map-reduce path — which uses smaller
+ * per-chunk prefills that fit under the guard — and actually produces a summary.
+ *
+ * Driven through the real in-process MCP client/server with a backend whose
+ * FIRST chat() throws the empty-completion error and whose subsequent calls
+ * (the chunked MAP + REDUCE) succeed.
+ */
+
+import { afterEach, beforeEach, describe, expect, it } from 'vitest';
+import { mkdtemp, rm } from 'node:fs/promises';
+import { tmpdir } from 'node:os';
+import { join } from 'node:path';
+import { Client } from '@modelcontextprotocol/sdk/client/index.js';
+import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
+
+import { buildBridgeServer } from '../../src/mcp/server.js';
+import {
+  _installTestBackend,
+  _resetMlxHttpCacheForTests,
+} from '../../src/mcp/backend-factory.js';
+import { JobStore } from '../../src/jobs/store.js';
+import { JobRegistry } from '../../src/jobs/registry.js';
+import { JobRunner } from '../../src/jobs/runner.js';
+import type { LlmBackend, ChatOptions, ChatResult } from '../../src/llm/backend.js';
+
+/** Long enough to chunk into several pieces, but under summarize-long's
+ *  oversizeCheck floor (so the handler reaches the single chat call that
+ *  triggers the fallback rather than erroring proactively). */
+const LONG_TEXT =
+  'The quarterly report covered revenue, costs, headcount, and the forward outlook. '.repeat(
+    700,
+  );
+
+/** First chat() throws the empty-completion error (simulating the prefill
+ *  memory-guard rejection); every later call (chunk MAP + REDUCE) succeeds. */
+class FirstCallThrowsBackend implements LlmBackend {
+  calls = 0;
+  readonly modelId = 'first-throws-fake';
+  async chat(opts: ChatOptions, signal?: AbortSignal): Promise<ChatResult> {
+    void opts;
+    void signal;
+    this.calls += 1;
+    if (this.calls === 1) {
+      throw new Error(
+        'MlxHttpBackend: oMLX returned an EMPTY completion (prompt_tokens=0, completion_tokens=0). ' +
+          'Likely a decode abort or a prefill memory-guard rejection under memory pressure.',
+      );
+    }
+    return { text: `chunk-summary-${this.calls}`, promptTokens: 80, completionTokens: 12 };
+  }
+  async countTokens(text: string): Promise<number> {
+    return Math.ceil(text.length / 3.5);
+  }
+  async ping(): Promise<void> {
+    /* healthy */
+  }
+}
+
+describe('summarize-long → chunked fallback on memory-guard / empty completion', () => {
+  let client: Client;
+  let runner: JobRunner;
+  let tmpDir: string;
+  let backend: FirstCallThrowsBackend;
+
+  beforeEach(async () => {
+    tmpDir = await mkdtemp(join(tmpdir(), 'omcp-sl-fallback-'));
+    const store = new JobStore({ baseDir: tmpDir });
+    const registry = new JobRegistry(store);
+    await registry.initialize();
+    runner = new JobRunner(
+      registry,
+      async () => ({ isError: true, content: [{ type: 'text' as const, text: 'sync-only stub' }] }),
+      { concurrency: 1 },
+    );
+
+    _resetMlxHttpCacheForTests();
+    backend = new FirstCallThrowsBackend();
+    _installTestBackend(backend);
+
+    const server = buildBridgeServer({
+      defendUntrusted: false,
+      jobRegistry: registry,
+      jobRunner: runner,
+    });
+    const [serverT, clientT] = InMemoryTransport.createLinkedPair();
+    await server.connect(serverT);
+    client = new Client({ name: 'sl-fallback-test', version: '0.0.0' });
+    await client.connect(clientT);
+  });
+
+  afterEach(async () => {
+    await client.close();
+    await runner.waitIdle();
+    await rm(tmpDir, { recursive: true, force: true });
+  });
+
+  it('does NOT error — it falls back to chunked and returns a summary', async () => {
+    const result = (await client.callTool({
+      name: 'summarize-long',
+      arguments: { text: LONG_TEXT },
+    })) as { isError?: boolean; content?: Array<{ text?: string }> };
+
+    // An error here would be the bug. The guard rejection must recover via chunking.
+    expect(result.isError ?? false).toBe(false);
+    // Single call threw (#1); the chunked fallback then issued ≥1 more call.
+    expect(backend.calls).toBeGreaterThan(1);
+    // A real (non-empty) summary came back.
+    const text = result.content?.[0]?.text ?? '';
+    expect(text.length).toBeGreaterThan(0);
+  });
+});
