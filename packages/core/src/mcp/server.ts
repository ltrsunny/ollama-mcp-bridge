import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { OllamaClient, OllamaDaemonError } from '../ollama/client.js';
import {
  type BridgeConfig,
  DEFAULT_CONFIG,
  tierForTool,
} from '../config/tiers.js';
import { buildMeta } from './meta.js';
import { buildFooter } from './footer.js';
import { BridgeDefense } from './defense.js';
import { sanitizeSchemaForOllama } from './sanitize.js';
import { readSource, readSourceOptionsFromEnv } from '../io/sourceReader.js';

export interface BridgeServerOptions {
  ollamaHost?: string;
  config?: BridgeConfig;
  name?: string;
  version?: string;
  /**
   * Override whether prompt-injection defense (F4) is enabled.
   * Default: true. When true, Layer 1 (Spotlighting + NFKC) and Layer 2
   * (@stackone/defender Tier 1) run on every untrusted text input.
   * Tier 2 (MiniLM ONNX) additionally requires OMCP_DEFENDER_TIER2=1.
   */
  defendUntrusted?: boolean;
}

// ── System prompts ──────────────────────────────────────────────────────────

const SUMMARIZE_SYSTEM =
  'You are a precise summarizer. Produce a single-paragraph summary in plain prose. ' +
  'Do not editorialize. Do not add information not in the source. Match the language of the source text. ' +
  'If a style hint is provided, honor it (e.g. "one sentence", "for a non-technical reader", "bullet points").';

const SUMMARIZE_LONG_SYSTEM =
  'You are a careful summarizer of long documents. Produce a structured ' +
  'summary: first 1-2 sentences giving the core claim, then 3-6 short bullet points covering the supporting ' +
  'detail. Preserve the source language. Do not invent facts. If the source is very long, prioritize the ' +
  'opening, any explicit conclusion, and named entities / numbers. ' +
  'If the source is itself bullet-structured, collapse related bullets into themes — never mirror the source structure. ' +
  'Never exceed 6 bullets in the output regardless of source length.';

const CLASSIFY_SYSTEM =
  'You are a precise classifier. Given a text and a list of categories, ' +
  'assign the correct label(s) and reply with JSON matching the schema exactly. ' +
  'If a reason field is requested, write ONE brief sentence explaining your choice, ' +
  'in the same language as the source text.';

const EXTRACT_SYSTEM =
  'Extract the requested fields from the user text. Reply with JSON matching ' +
  'the schema exactly. Preserve source language inside string values. ' +
  'SCHEMA GUIDANCE: prefer z.discriminatedUnion over bare z.union when branches ' +
  'overlap on output shape — structural grammar enforcement does not guarantee ' +
  'the model picks the intended branch for bare unions.';

const TRANSFORM_SYSTEM =
  'Apply the instruction to the text. Return ONLY the transformed text, with ' +
  'no commentary, no preamble, no explanation. Preserve the source language ' +
  'unless the instruction explicitly says otherwise.';

// ── Helpers ─────────────────────────────────────────────────────────────────

function toolCallError(err: unknown) {
  const msg =
    err instanceof OllamaDaemonError
      ? err.message
      : `Ollama chat failed: ${(err as Error).message}`;
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: msg }],
  };
}

/**
 * Minimal structural type for the MCP RequestHandlerExtra we need.
 * Using a structural type avoids the two-generic-param requirement of the
 * SDK's RequestHandlerExtra<ServerRequest, ServerNotification>.
 */
interface ToolExtra {
  _meta?: { progressToken?: string | number };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendNotification: (notification: any) => Promise<void>;
}

/** Send a notifications/progress if the caller supplied a progressToken. */
async function sendProgress(
  extra: ToolExtra,
  progress: number,
  total: number,
  message: string,
): Promise<void> {
  const token = extra._meta?.progressToken;
  if (token === undefined) return;
  await extra.sendNotification({
    method: 'notifications/progress',
    params: { progressToken: token, progress, total, message },
  }).catch(() => {/* ignore — progress is advisory */});
}

// ── Source resolution helper (F2) ────────────────────────────────────────────

type SourceResolved =
  | { ok: true; text: string; bytes?: number }
  | { ok: false; message: string };

/**
 * Resolve the caller's source input: either `text` (inline) or `source_uri`
 * (file/URL). Exactly one must be provided. Returns a discriminated union so
 * the handler can short-circuit on failure without throwing.
 */
async function resolveSource(
  text: string | undefined,
  sourceUri: string | undefined,
): Promise<SourceResolved> {
  if (!text && !sourceUri) {
    return { ok: false, message: 'Either text or source_uri must be provided.' };
  }
  if (text && sourceUri) {
    return { ok: false, message: 'Provide either text or source_uri, not both.' };
  }
  if (sourceUri) {
    try {
      const opts = readSourceOptionsFromEnv();
      const r = await readSource(sourceUri, opts);
      return { ok: true, text: r.text, bytes: r.bytes };
    } catch (err) {
      return { ok: false, message: `source_uri read failed: ${(err as Error).message}` };
    }
  }
  return { ok: true, text: text! };
}

// ── Server builder ──────────────────────────────────────────────────────────

export function buildBridgeServer(
  client: OllamaClient,
  options: BridgeServerOptions = {},
): McpServer {
  const config = options.config ?? DEFAULT_CONFIG;
  const defendUntrusted = options.defendUntrusted ?? true;
  const defense = defendUntrusted ? new BridgeDefense() : null;

  const server = new McpServer({
    name: options.name ?? 'ollama-mcp-bridge',
    version: options.version ?? '0.1.2',
  });

  // ── summarize ─────────────────────────────────────────────────────────────
  server.registerTool(
    'summarize',
    {
      title: 'Summarize text via local Ollama',
      description:
        'DELEGATION GUIDANCE: delegate short-to-medium summarization (up to ~2000 words) ' +
        'to a local model. Produces plain-prose output. Data stays local. ' +
        'For documents longer than ~2000 words prefer summarize-long. ' +
        'TOKEN SAVINGS: real frontier-token savings require source_uri — the bridge reads ' +
        'the source directly so it never enters your context. Inline `text` saves no tokens ' +
        'if the content is already in your context (you already paid for it).',
      inputSchema: {
        text: z.string().min(1).optional().describe(
          'The text to summarize. Required if source_uri is not provided. ' +
          'Saves no frontier tokens if the content is already in your context — prefer source_uri in that case.',
        ),
        source_uri: z.string().min(1).optional().describe(
          'URI to read source from instead of text. Supports file:// and http(s)://. ' +
          'Required if text is not provided. This is the only path that actually saves frontier tokens.',
        ),
        style: z.string().optional().describe(
          'Optional style hint, e.g. "one sentence", "three bullet points", "for a non-technical reader".',
        ),
      },
    },
    async ({ text, source_uri, style }, extra) => {
      const src = await resolveSource(text, source_uri);
      if (!src.ok) {
        return { isError: true as const, content: [{ type: 'text' as const, text: src.message }] };
      }
      const tierKey = tierForTool(config, 'summarize');
      const tierCfg = config.tiers[tierKey];
      const t0 = Date.now();
      await sendProgress(extra, 0, 3, `routing to Tier ${tierKey} (${tierCfg.model})`);
      try {
        let safeText = src.text;
        let systemPrompt = SUMMARIZE_SYSTEM;
        let defenderMeta: Parameters<typeof buildMeta>[0]['defender'];
        if (defense) {
          const dResult = await defense.defend(src.text, 'summarize');
          defenderMeta = { tier: dResult.defenderTier, score: dResult.score, risk: dResult.risk };
          await sendProgress(extra, 1, 3, `defender passed (risk=${dResult.risk ?? 'low'})`);
          if (!dResult.allowed) {
            return {
              isError: true as const,
              content: [{ type: 'text' as const, text: `Prompt injection detected (risk=${dResult.risk}). Request blocked.` }],
              _meta: buildMeta({ model: tierCfg.model, tier: tierKey, latencyMs: Date.now() - t0, result: { promptTokens: 0, completionTokens: 0 }, defender: defenderMeta }),
            };
          }
          safeText = dResult.wrappedText;
          systemPrompt = dResult.systemPrefix + '\n\n' + SUMMARIZE_SYSTEM;
        }
        await sendProgress(extra, 2, 3, 'generating…');
        const user = style ? `Style: ${style}\n\nSource:\n${safeText}` : `Source:\n${safeText}`;
        const result = await client.chat({
          model: tierCfg.model,
          keepAlive: tierCfg.keepAlive,
          numCtx: tierCfg.numCtx,
          system: systemPrompt,
          user,
          temperature: 0.2,
        });
        const latencyMs = Date.now() - t0;
        const savedInputTokensEstimate = src.bytes !== undefined
          ? Math.max(0, Math.floor(src.bytes / 4) - result.completionTokens)
          : undefined;
        const footerText = buildFooter({ model: tierCfg.model, tier: tierKey, latencyMs, promptTokens: result.promptTokens, completionTokens: result.completionTokens, savedTokensEstimate: savedInputTokensEstimate });
        const meta = buildMeta({ model: tierCfg.model, tier: tierKey, latencyMs, result, defender: defenderMeta, savedInputTokensEstimate });
        if (source_uri) { meta['dev.ollamamcpbridge/source_uri'] = source_uri; meta['dev.ollamamcpbridge/source_bytes'] = src.bytes; }
        return {
          content: [
            { type: 'text' as const, text: result.text.trim() },
            ...(footerText ? [{ type: 'text' as const, text: footerText }] : []),
          ],
          _meta: meta,
        };
      } catch (err) {
        return toolCallError(err);
      }
    },
  );

  // ── summarize-long ────────────────────────────────────────────────────────
  server.registerTool(
    'summarize-long',
    {
      title: 'Summarize long documents via local Ollama (larger model)',
      description:
        'DELEGATION GUIDANCE: delegate long-document summarization (~2000+ words) to a ' +
        'larger local model (Tier C). Produces 1-2 sentence lead + 3-6 bullet points. ' +
        'Higher latency than summarize. Prefer summarize for anything under ~2000 words. ' +
        'TOKEN SAVINGS: strongly prefer source_uri for long documents — it is the only ' +
        'path that actually saves frontier tokens. Passing inline `text` that is already ' +
        'in your context saves nothing; for long documents that waste is largest here.',
      inputSchema: {
        text: z.string().min(1).optional().describe(
          'The document to summarize. Can be several thousand words. Required if source_uri is not provided. ' +
          'Saves no frontier tokens if already in your context — source_uri is strongly preferred for long content.',
        ),
        source_uri: z.string().min(1).optional().describe(
          'URI to read source from instead of text. Supports file:// and http(s)://. ' +
          'Required if text is not provided. Strongly preferred for long content — the only path that saves frontier tokens.',
        ),
        style: z.string().optional().describe(
          'Optional style hint. Default is 1-2 sentence lead plus 3-6 bullets.',
        ),
      },
    },
    async ({ text, source_uri, style }, extra) => {
      const src = await resolveSource(text, source_uri);
      if (!src.ok) {
        return { isError: true as const, content: [{ type: 'text' as const, text: src.message }] };
      }
      const tierKey = tierForTool(config, 'summarize-long');
      const tierCfg = config.tiers[tierKey];
      const t0 = Date.now();
      await sendProgress(extra, 0, 3, `routing to Tier ${tierKey} (${tierCfg.model})`);
      try {
        let safeText = src.text;
        let systemPrompt = SUMMARIZE_LONG_SYSTEM;
        let defenderMeta: Parameters<typeof buildMeta>[0]['defender'];
        if (defense) {
          const dResult = await defense.defend(src.text, 'summarize-long');
          defenderMeta = { tier: dResult.defenderTier, score: dResult.score, risk: dResult.risk };
          await sendProgress(extra, 1, 3, `defender passed (risk=${dResult.risk ?? 'low'})`);
          if (!dResult.allowed) {
            return {
              isError: true as const,
              content: [{ type: 'text' as const, text: `Prompt injection detected (risk=${dResult.risk}). Request blocked.` }],
              _meta: buildMeta({ model: tierCfg.model, tier: tierKey, latencyMs: Date.now() - t0, result: { promptTokens: 0, completionTokens: 0 }, defender: defenderMeta }),
            };
          }
          safeText = dResult.wrappedText;
          systemPrompt = dResult.systemPrefix + '\n\n' + SUMMARIZE_LONG_SYSTEM;
        }
        await sendProgress(extra, 2, 3, 'generating…');
        const user = style ? `Style override: ${style}\n\nSource:\n${safeText}` : `Source:\n${safeText}`;
        const result = await client.chat({
          model: tierCfg.model,
          keepAlive: tierCfg.keepAlive,
          numCtx: tierCfg.numCtx,
          system: systemPrompt,
          user,
          temperature: 0.2,
        });
        const latencyMs = Date.now() - t0;
        const savedInputTokensEstimate = src.bytes !== undefined
          ? Math.max(0, Math.floor(src.bytes / 4) - result.completionTokens)
          : undefined;
        const footerText = buildFooter({ model: tierCfg.model, tier: tierKey, latencyMs, promptTokens: result.promptTokens, completionTokens: result.completionTokens, savedTokensEstimate: savedInputTokensEstimate });
        const meta = buildMeta({ model: tierCfg.model, tier: tierKey, latencyMs, result, defender: defenderMeta, savedInputTokensEstimate });
        if (source_uri) { meta['dev.ollamamcpbridge/source_uri'] = source_uri; meta['dev.ollamamcpbridge/source_bytes'] = src.bytes; }
        return {
          content: [
            { type: 'text' as const, text: result.text.trim() },
            ...(footerText ? [{ type: 'text' as const, text: footerText }] : []),
          ],
          _meta: meta,
        };
      } catch (err) {
        return toolCallError(err);
      }
    },
  );

  // ── classify (F1) ─────────────────────────────────────────────────────────
  server.registerTool(
    'classify',
    {
      title: 'Classify text into categories via local Ollama',
      description:
        'DELEGATION GUIDANCE: delegate text classification to a local model. ' +
        'The model is grammar-constrained to emit only labels from the provided category list — ' +
        'no hallucinated labels possible. Use for sentiment, intent, topic, priority, or any ' +
        'enum-typed labeling task. ' +
        'VALUE: reliability, not token savings. Grammar-constrained output guarantees every ' +
        'response is a valid member of your categories — something small local models cannot ' +
        'reliably self-enforce. Data stays local. This tool does not accept source_uri because ' +
        'classification inputs are typically already short and in your context.',
      inputSchema: {
        text: z.string().min(1).describe('The text to classify.'),
        categories: z.array(z.string()).min(2).describe(
          'Exhaustive list of valid labels. The model will pick only from this list.',
        ),
        allow_multiple: z.boolean().optional().describe(
          'If true, the model may assign more than one label. Default false (single label).',
        ),
        explain: z.boolean().optional().describe(
          'If true, include a short reason field in the output.',
        ),
      },
    },
    async ({ text, categories, allow_multiple, explain }, extra) => {
      const tierKey = tierForTool(config, 'classify');
      const tierCfg = config.tiers[tierKey];
      const t0 = Date.now();
      await sendProgress(extra, 0, 3, `routing to Tier ${tierKey} (${tierCfg.model})`);
      try {
        let safeText = text;
        let systemPrompt = CLASSIFY_SYSTEM;
        let defenderMeta: Parameters<typeof buildMeta>[0]['defender'];
        if (defense) {
          const dResult = await defense.defend(text, 'classify');
          defenderMeta = { tier: dResult.defenderTier, score: dResult.score, risk: dResult.risk };
          await sendProgress(extra, 1, 3, `defender passed (risk=${dResult.risk ?? 'low'})`);
          if (!dResult.allowed) {
            return {
              isError: true as const,
              content: [{ type: 'text' as const, text: `Prompt injection detected (risk=${dResult.risk}). Request blocked.` }],
              _meta: buildMeta({ model: tierCfg.model, tier: tierKey, latencyMs: Date.now() - t0, result: { promptTokens: 0, completionTokens: 0 }, defender: defenderMeta }),
            };
          }
          safeText = dResult.wrappedText;
          systemPrompt = dResult.systemPrefix + '\n\n' + CLASSIFY_SYSTEM;
        }
        // Build grammar-constrained schema: labels must be members of categories
        const labelEnum = categories as [string, ...string[]];
        const labelsSchema = allow_multiple
          ? { type: 'array', items: { enum: labelEnum }, minItems: 1 }
          : { type: 'array', items: { enum: labelEnum }, minItems: 1, maxItems: 1 };
        const formatSchema = explain
          ? { type: 'object', properties: { labels: labelsSchema, reason: { type: 'string' } }, required: ['labels', 'reason'] }
          : { type: 'object', properties: { labels: labelsSchema }, required: ['labels'] };

        await sendProgress(extra, 2, 3, 'generating…');
        const result = await client.chat({
          model: tierCfg.model,
          keepAlive: tierCfg.keepAlive,
          numCtx: tierCfg.numCtx,
          system: systemPrompt,
          user: safeText,
          temperature: 0.1, // lower temp for classification
          format: formatSchema,
        });
        const latencyMs = Date.now() - t0;
        const footerText = buildFooter({ model: tierCfg.model, tier: tierKey, latencyMs, promptTokens: result.promptTokens, completionTokens: result.completionTokens });
        return {
          content: [
            { type: 'text' as const, text: result.text },
            ...(footerText ? [{ type: 'text' as const, text: footerText }] : []),
          ],
          _meta: buildMeta({ model: tierCfg.model, tier: tierKey, latencyMs, result, defender: defenderMeta }),
        };
      } catch (err) {
        return toolCallError(err);
      }
    },
  );

  // ── extract (F2) ──────────────────────────────────────────────────────────
  server.registerTool(
    'extract',
    {
      title: 'Extract structured data from text via local Ollama',
      description:
        'DELEGATION GUIDANCE: delegate structured-data extraction to a local model. ' +
        'Pass a JSON Schema object; the model is grammar-constrained to produce output ' +
        'matching that schema. Supports flat objects, nested objects, arrays, enums, ' +
        'minLength/maxLength/minItems/maxItems, anyOf unions (structural only — for reliable ' +
        'branch selection prefer z.discriminatedUnion). ' +
        'Constraints that crash the grammar compiler (pattern, format:email/uri/date-time, ' +
        'multipleOf) are automatically stripped and surfaced in _meta.schema_stripped. ' +
        'Data stays local. ' +
        'TOKEN SAVINGS: real frontier-token savings require source_uri — inline `text` that ' +
        'is already in your context saves no tokens. The grammar-constrained output is the ' +
        'primary value regardless of input mode.',
      inputSchema: {
        text: z.string().min(1).optional().describe(
          'The source text to extract from. Required if source_uri is not provided. ' +
          'Saves no frontier tokens if the content is already in your context — prefer source_uri in that case.',
        ),
        source_uri: z.string().min(1).optional().describe(
          'URI to read source from instead of text. Supports file:// and http(s)://. ' +
          'Required if text is not provided. This is the only path that actually saves frontier tokens.',
        ),
        schema: z.record(z.string(), z.unknown()).describe(
          'JSON Schema object describing the desired output. Obtain via z.toJSONSchema(yourSchema). ' +
          'Avoid z.email(), z.url(), z.string().regex() — they crash Ollama\'s grammar compiler.',
        ),
      },
    },
    async ({ text, source_uri, schema }, extra) => {
      const src = await resolveSource(text, source_uri);
      if (!src.ok) {
        return { isError: true as const, content: [{ type: 'text' as const, text: src.message }] };
      }
      const tierKey = tierForTool(config, 'extract');
      const tierCfg = config.tiers[tierKey];
      const t0 = Date.now();
      await sendProgress(extra, 0, 3, `routing to Tier ${tierKey} (${tierCfg.model})`);
      try {
        // Schema sanitation (F2 sanitizer)
        const sanitized = sanitizeSchemaForOllama(schema);
        if (!sanitized.ok) {
          return {
            isError: true as const,
            content: [{ type: 'text' as const, text: `Schema rejected: $ref is not supported (path: ${sanitized.path}). Resolve all $ref before calling extract.` }],
            _meta: buildMeta({ model: tierCfg.model, tier: tierKey, latencyMs: Date.now() - t0, result: { promptTokens: 0, completionTokens: 0 } }),
          };
        }

        let safeText = src.text;
        let systemPrompt = EXTRACT_SYSTEM;
        let defenderMeta: Parameters<typeof buildMeta>[0]['defender'];
        if (defense) {
          const dResult = await defense.defend(src.text, 'extract');
          defenderMeta = { tier: dResult.defenderTier, score: dResult.score, risk: dResult.risk };
          await sendProgress(extra, 1, 3, `defender passed (risk=${dResult.risk ?? 'low'})`);
          if (!dResult.allowed) {
            return {
              isError: true as const,
              content: [{ type: 'text' as const, text: `Prompt injection detected (risk=${dResult.risk}). Request blocked.` }],
              _meta: buildMeta({ model: tierCfg.model, tier: tierKey, latencyMs: Date.now() - t0, result: { promptTokens: 0, completionTokens: 0 }, defender: defenderMeta, schemaStripped: sanitized.stripped }),
            };
          }
          safeText = dResult.wrappedText;
          systemPrompt = dResult.systemPrefix + '\n\n' + EXTRACT_SYSTEM;
        }
        await sendProgress(extra, 2, 3, 'generating…');
        const result = await client.chat({
          model: tierCfg.model,
          keepAlive: tierCfg.keepAlive,
          numCtx: tierCfg.numCtx,
          system: systemPrompt,
          user: safeText,
          temperature: 0.2,
          format: sanitized.schema,
          numPredict: 2048,
        });
        const latencyMs = Date.now() - t0;
        const savedInputTokensEstimate = src.bytes !== undefined
          ? Math.max(0, Math.floor(src.bytes / 4) - result.completionTokens)
          : undefined;
        const footerText = buildFooter({ model: tierCfg.model, tier: tierKey, latencyMs, promptTokens: result.promptTokens, completionTokens: result.completionTokens, savedTokensEstimate: savedInputTokensEstimate });
        const meta = buildMeta({
          model: tierCfg.model,
          tier: tierKey,
          latencyMs,
          result,
          defender: defenderMeta,
          schemaValidation: 'passed',
          schemaStripped: sanitized.stripped,
          savedInputTokensEstimate,
        });
        if (source_uri) { meta['dev.ollamamcpbridge/source_uri'] = source_uri; meta['dev.ollamamcpbridge/source_bytes'] = src.bytes; }
        return {
          content: [
            { type: 'text' as const, text: result.text },
            ...(footerText ? [{ type: 'text' as const, text: footerText }] : []),
          ],
          _meta: meta,
        };
      } catch (err) {
        return toolCallError(err);
      }
    },
  );

  // ── transform (F3) ────────────────────────────────────────────────────────
  server.registerTool(
    'transform',
    {
      title: 'Rewrite or transform text via local Ollama',
      description:
        'DELEGATION GUIDANCE: delegate text rewriting to a local model. ' +
        'Apply any natural-language instruction: translate, summarize into a different format, ' +
        'fix grammar, change tone, convert markdown to plain text, etc. ' +
        'Returns only the transformed text, no commentary. Data stays local. ' +
        'TOKEN SAVINGS: real frontier-token savings require source_uri — inline `text` that ' +
        'is already in your context saves no tokens. Inline mode is still useful for ' +
        'transforming content you just generated or small test snippets; be aware it is not delegation in the token-saving sense.',
      inputSchema: {
        text: z.string().min(1).optional().describe(
          'The source text to transform. Required if source_uri is not provided. ' +
          'Saves no frontier tokens if the content is already in your context — prefer source_uri in that case.',
        ),
        source_uri: z.string().min(1).optional().describe(
          'URI to read source from instead of text. Supports file:// and http(s)://. ' +
          'Required if text is not provided. This is the only path that actually saves frontier tokens.',
        ),
        instruction: z.string().min(1).describe(
          'The transformation instruction, e.g. "Translate to Spanish", "Fix grammar", "Make it more formal".',
        ),
      },
    },
    async ({ text, source_uri, instruction }, extra) => {
      const src = await resolveSource(text, source_uri);
      if (!src.ok) {
        return { isError: true as const, content: [{ type: 'text' as const, text: src.message }] };
      }
      const tierKey = tierForTool(config, 'transform');
      const tierCfg = config.tiers[tierKey];
      const t0 = Date.now();
      await sendProgress(extra, 0, 3, `routing to Tier ${tierKey} (${tierCfg.model})`);
      try {
        let safeText = src.text;
        let systemPrompt = TRANSFORM_SYSTEM;
        let defenderMeta: Parameters<typeof buildMeta>[0]['defender'];
        if (defense) {
          const dResult = await defense.defend(src.text, 'transform');
          defenderMeta = { tier: dResult.defenderTier, score: dResult.score, risk: dResult.risk };
          await sendProgress(extra, 1, 3, `defender passed (risk=${dResult.risk ?? 'low'})`);
          if (!dResult.allowed) {
            return {
              isError: true as const,
              content: [{ type: 'text' as const, text: `Prompt injection detected (risk=${dResult.risk}). Request blocked.` }],
              _meta: buildMeta({ model: tierCfg.model, tier: tierKey, latencyMs: Date.now() - t0, result: { promptTokens: 0, completionTokens: 0 }, defender: defenderMeta }),
            };
          }
          safeText = dResult.wrappedText;
          systemPrompt = dResult.systemPrefix + '\n\n' + TRANSFORM_SYSTEM;
        }
        await sendProgress(extra, 2, 3, 'generating…');
        const result = await client.chat({
          model: tierCfg.model,
          keepAlive: tierCfg.keepAlive,
          numCtx: tierCfg.numCtx,
          system: systemPrompt,
          user: `Instruction: ${instruction}\n\nText:\n${safeText}`,
          temperature: 0.3,
        });
        const latencyMs = Date.now() - t0;
        const savedInputTokensEstimate = src.bytes !== undefined
          ? Math.max(0, Math.floor(src.bytes / 4) - result.completionTokens)
          : undefined;
        const footerText = buildFooter({ model: tierCfg.model, tier: tierKey, latencyMs, promptTokens: result.promptTokens, completionTokens: result.completionTokens, savedTokensEstimate: savedInputTokensEstimate });
        const meta = buildMeta({ model: tierCfg.model, tier: tierKey, latencyMs, result, defender: defenderMeta, savedInputTokensEstimate });
        if (source_uri) { meta['dev.ollamamcpbridge/source_uri'] = source_uri; meta['dev.ollamamcpbridge/source_bytes'] = src.bytes; }
        return {
          content: [
            { type: 'text' as const, text: result.text.trim() },
            ...(footerText ? [{ type: 'text' as const, text: footerText }] : []),
          ],
          _meta: meta,
        };
      } catch (err) {
        return toolCallError(err);
      }
    },
  );

  return server;
}

export async function runBridgeServerStdio(
  options: BridgeServerOptions = {},
): Promise<void> {
  const client = new OllamaClient(options.ollamaHost);
  await client.ping();

  const server = buildBridgeServer(client, options);

  // F4: warm up Tier-2 ONNX model at startup if enabled, so the first tool
  // call doesn't pay the 1-2 s load cost.
  if (options.defendUntrusted !== false && process.env['OMCP_DEFENDER_TIER2'] === '1') {
    const tempDefense = new BridgeDefense({ enableTier2: true });
    await tempDefense.warmup();
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
