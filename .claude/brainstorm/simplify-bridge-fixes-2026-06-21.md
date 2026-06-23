# SIMPLIFY (quality cleanup, NOT bug-hunting) — review the diff below

You are ONE independent reviewer. Find QUALITY cleanups only (NOT correctness bugs). Up to 6 findings.
Each: `file:line` + one-line summary + the concrete cost (duplicated / wasted / harder-to-maintain).

Angles (cover what you can):
- REUSE: new code re-implementing something the codebase already has. (Verified candidate: the
  summarize-long FALLBACK builds a `chunkedSummarize({...})` options block that DUPLICATES the
  `summarize-long-chunked` handler's near-identical call — extract a shared helper?)
- SIMPLIFICATION: redundant/derivable state, copy-paste-with-variation, deep nesting, dead code,
  an inline regex/string literal that wants a named const.
- EFFICIENCY: wasted/repeated work, sequential-when-parallel, closures keeping large scope alive.
- ALTITUDE: right depth, or a fragile special-case layered on shared infra that should be generalized?

Context: local-mcp-toolbelt bridge (Node/TS). Diff adds (1) an empty-completion guard in
MlxHttpBackend.chat; (2) a `.catch` fallback in the summarize-long handler calling chunkedSummarize.
Keep findings to genuine quality wins; do not invent.

[DIFF]
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
index 2fc8235..2f482c8 100644
--- a/packages/core/src/mcp/server.ts
+++ b/packages/core/src/mcp/server.ts
@@ -609,17 +609,48 @@ export function buildBridgeServer(
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
+              onProgress: async (msg) => {
+                // Forward the chunked map-reduce progress so the bar doesn't freeze
+                // at 'falling back…' during a (potentially long) fallback — the
+                // message carries the phase; stays within summarize-long's step 2/3.
+                await sendProgress(extra, 2, 3, `fallback: ${msg}`);
+              },
+            });
+          });
         const latencyMs = Date.now() - t0;
         const savedInputTokensEstimate = src.bytes !== undefined
           ? Math.max(0, Math.floor(src.bytes / 4) - result.completionTokens)
