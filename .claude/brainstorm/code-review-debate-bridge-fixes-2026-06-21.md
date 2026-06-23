# CODE-REVIEW DEBATE — attack the verdicts (recall mode; no preset)

A prior pass produced these VERDICTS on a 2-commit bridge fix (diff below). DEBATE them
adversarially and independently. Recall mode: a wrongly-DISMISSED bug SHIPS — so attack the
REFUTATIONS hardest. Don't defer to the prior pass.

## VERDICTS UNDER DEBATE
KEPT (CONFIRMED/PLAUSIBLE) — 5 findings:
1. mlx-http-backend.ts:491 — empty-guard `text.trim()===''` too broad: throws on a LEGITIMATELY-empty completion (e.g. a `transform` 'output only the FATAL lines' on clean input → model correctly emits ''). Proposed FIX: `text.trim()==='' && promptTokens===0`.
2. server.ts:633 — recoverable regex `/EMPTY completion|memory[ -]?guard|prefill|exceeds? .*(limit|context)/i` too broad → false fallback on generic/transient/rate-limit errors.
3. server.ts:636 — fallback omits `onProgress` → frozen progress UI during the chunked fallback.
4. server.ts:637 — fallback passes raw `src.text` (drops Spotlighting wrapping); judged LOW because the defender allow/BLOCK still runs on src.text pre-chat and this matches the chunked tool's own documented trade-off.
5. test — only the happy fallback is covered; no test for chunked-also-fails or for a non-recoverable error correctly NOT firing the fallback.

REFUTED (dismissed — ATTACK THESE; which is a real bug?):
- R1: `text` null/undefined → `.trim()` crash. Dismissed: `data.choices?.[0]?.message?.content ?? ''` guarantees a string.
- R2: one chunk hitting the guard ABORTS the whole chunked fallback. Dismissed: map-reduce catches per-chunk/reduce errors (lines 367/446/517) → substitute placeholder + chunksFailed++ → degrades to PARTIAL, no abort.
- R3: `(err as Error)?.message` crashes on a non-Error rejection. Dismissed: TS cast is erased + optional chaining → undefined, no throw.
- R4: abort race (signal aborts AFTER the check, before chunked). Dismissed: chunkedSummarize re-checks the signal via throwIfAborted at entry.
- R5: chunkedSummarize return-type mismatch → `result.completionTokens` undefined → NaN telemetry. Dismissed: tsc type-checked the call compatible.
- R6: `style` not forwarded to chunkedSummarize. Dismissed: `style` IS passed in the options object.
- R7: fallback drops `temperature`. Dismissed: chunkedSummarize hardcodes `temperature: 0.2` internally (matches the primary call's 0.2).

## Debate — each voice, independently:
1. Which REFUTED item (R1–R7) is actually a REAL bug wrongly dismissed? Give the exact trigger + wrong output. (Attack hardest here.)
2. Is finding-1's FIX correct? Specifically: does `&& promptTokens===0` REINTRODUCE the silent-empty bug for a decode-abort that happens AFTER prefill (so prompt_tokens>0 but content='')? What is the RIGHT discriminator / design (e.g. throw on empty always + let specific tools opt into empty)?
3. Which of findings 1–5 is OVER-stated (not a real bug)?
4. Any real bug still MISSED by both passes?
End with: your corrected verified set + the single highest-value fix.

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
