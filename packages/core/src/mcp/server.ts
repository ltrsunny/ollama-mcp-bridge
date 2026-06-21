import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  type BridgeConfig,
  type Tier,
  DEFAULT_CONFIG,
  tierForTool,
  tierModelLabel,
} from '../config/tiers.js';
import { buildMeta } from './meta.js';
import { buildFooter } from './footer.js';
import { BridgeDefense } from './defense.js';
import { sanitizeSchemaForStrictMode } from './sanitize.js';
import { readSource, readSourceOptionsFromEnv } from '../io/sourceReader.js';
import { readImageSource } from '../io/imageReader.js';
import { backendForTool } from './backend-factory.js';
import {
  resolveThinking,
  ThinkingInputSchema,
  type ThinkingMode,
} from '../config/thinking-defaults.js';
import { chunkedSummarize } from '../chunking/map-reduce.js';
import { parseDiffText, deriveTestCoverageHint, formatParsedDiffForPrompt } from '../diff/parse.js';
import type { JobRegistry } from '../jobs/registry.js';
import type { JobRunner } from '../jobs/runner.js';
import type { ProgressCaptureExtra } from '../jobs/progress-capture.js';

/** Loose-typed handler stored in the toolHandlers Map for the runner to invoke
 *  on async-job execution. ProgressCaptureExtra is a structural subset of the
 *  SDK's RequestHandlerExtra; handlers access only the fields it provides. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CapturedToolHandler = (args: any, extra: ProgressCaptureExtra) => Promise<any>;

export interface BridgeServerOptions {
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

  // ── async jobs ────────────────────────────────────────────────────────────
  /** When provided alongside jobRunner, registers the async-job MCP tools
   *  (enqueue-job, wait_for_job, read_job_result, check_progress). */
  jobRegistry?: JobRegistry;
  /** Workhorse for actually running enqueued jobs. Pair with jobRegistry. */
  jobRunner?: JobRunner;
  /** Optional pre-built Map for the runner's ToolInvoker. If omitted, a fresh
   *  Map is created and populated during tool registration. Tests can pass
   *  their own to inspect. */
  toolHandlers?: Map<string, CapturedToolHandler>;
}

// ── Shell helpers ──────────────────────────────────────────────────────────

/**
 * POSIX-safe single-quote shell escape. Wraps the input in single quotes
 * and escapes any embedded single quotes with the `'\''` close-reopen
 * sequence. Used by enqueue_job's `wait_command` to defend against spaces
 * and shell metacharacters in `result_path` (baseDir can be set via
 * OMCP_MEMORY_DIR which is user-controlled).
 *
 * Disables ALL parameter / command substitution inside the quoted region,
 * including $(...), backticks, $VAR, and globs. Safe across /bin/sh,
 * bash, zsh.
 *
 * Example: `/tmp/foo bar` → `'/tmp/foo bar'`
 * Example: `/tmp/it's/here` → `'/tmp/it'\''s/here'`
 */
function bashSingleQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
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

const DIFF_INDEX_SYSTEM =
  'Analyse the git diff and return JSON matching the schema. Be terse and concrete. ' +
  'summary: ≤ 20 words, what changed and why. ' +
  'change_type: best single category (feature/fix/refactor/docs/test/chore/mixed). ' +
  'files_touched: one entry per file; use the structured parse block provided before the raw diff. ' +
  'key_decisions: 3–7 architectural or design points visible in the diff; empty array if none. ' +
  'risk_callouts: breaking API changes, missing migrations, skipped tests; empty array if none. ' +
  'test_coverage_hint: tests_added/tests_modified/no_test_change/unclear.';

/**
 * Hardcoded JSON Schema for diff-semantic-index grammar-constrained output.
 * files_touched[].role uses a free-string (not enum) to avoid oMLX json_schema
 * strict-mode enum issues with enum-inside-array-items — values are coerced in the handler.
 */
const DIFF_INDEX_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    change_type: {
      type: 'string',
      enum: ['feature', 'fix', 'refactor', 'docs', 'test', 'chore', 'mixed'],
    },
    summary: { type: 'string' },
    files_touched: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          // free-string — coerced to union in the handler
          role: { type: 'string' },
          lines_changed: { type: 'integer' },
          role_in_change: { type: 'string' },
        },
        required: ['path', 'role', 'lines_changed'],
      },
    },
    key_decisions: { type: 'array', items: { type: 'string' } },
    risk_callouts: { type: 'array', items: { type: 'string' } },
    test_coverage_hint: {
      type: 'string',
      enum: ['tests_added', 'tests_modified', 'no_test_change', 'unclear'],
    },
  },
  required: [
    'change_type', 'summary', 'files_touched',
    'key_decisions', 'risk_callouts', 'test_coverage_hint',
  ],
};

// ── Per-tool output budgets ────────────────────────────────────────────────
//
// Caps `maxOutputTokens` so models cannot generate runaway outputs.
// Values are *semantic* — what the tool reasonably needs — not tier-driven.
//
// The 60s MCP wall-clock interacts with these as: budget × tier-decode-rate.
// Tier B (~80 tps) and Tier C (~50 tps) clear all
// budgets in <30 s.  Tier D (Qwen3-14B-MLX ~10-14 tps via oMLX) only fits
// classify (200 tok ≈ 15 s) and extract/transform with shorter inputs.
//
// Empirically (eval run 20260507094102-mlx-8000), uncapped 14B emits:
//   - summarize-long: 580 tok (85 s)   — exceeds 60 s wall already
//   - classify:       666 tok (49 s)   — verbose; cap to 200
//   - extract:       1456 tok (116 s)  — schema ignored; cap helps fail-fast
//   - transform:      669 tok (59 s)   — natural ~ cap target
//
// Tools that need higher budgets at Tier D should NOT be on Tier D.
// See docs/scope-memos/v0.5.0-tier-d-eval-2026-05-06.md.
const MAX_OUTPUT_TOKENS = {
  summarize: 600,
  'summarize-long': 1200,
  classify: 200,
  transform: 1200,
  extract: 2048,
  'diff-semantic-index': 1024,
} as const;

// ── Helpers ─────────────────────────────────────────────────────────────────

function toolCallError(err: unknown) {
  const raw = (err as Error)?.message ?? String(err);
  // Translate oMLX's opaque prefill memory-guard rejection (input overflows the
  // model context / KV memory) into an actionable message. Backstop for the
  // proactive oversizeCheck() below when the char/3.5 token proxy under-estimates
  // (e.g. CJK-dense input) — the sister flagged a ~2700-line file hitting this.
  if (/prefill[_ ]memory|memory guard/i.test(raw)) {
    return {
      isError: true as const,
      content: [{ type: 'text' as const, text:
        `Input too large for the local model's context/memory — oMLX's prefill memory guard rejected it. ` +
        `For long documents use \`summarize-long-chunked\` (map-reduce; needs a client with a >60 s timeout, ` +
        `or the async-job path via \`enqueue_job\`); otherwise split the input, or raise oMLX's ` +
        `memory_guard_tier (safe → balanced → aggressive) in ~/.omlx/settings.json.\n\n(engine: ${raw})` }],
    };
  }
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: `Backend chat failed: ${raw}` }],
  };
}

/**
 * Proactive size guard: reject an input that can't fit the tier's context
 * BEFORE sending it (so the caller gets an actionable message instead of the
 * opaque oMLX prefill_memory_exceeded 400 — sister bug report 2026-06-17).
 *
 * Uses the same `ceil(chars / 3.5)` token proxy as MlxHttpBackend.countTokens
 * and a 0.85 safety factor (matching the chunker) so the limit sits below where
 * the engine's memory guard trips. Returns an error result, or null to proceed.
 */
function oversizeCheck(
  text: string,
  numCtx: number,
  outputReserve: number,
  tierKey: Tier,
  opts: { chunked?: boolean } = {},
): { isError: true; content: Array<{ type: 'text'; text: string }> } | null {
  const estTokens = Math.ceil(text.length / 3.5);
  const limit = Math.floor(numCtx * 0.85) - outputReserve;
  if (estTokens <= limit) return null;
  const hint = opts.chunked
    ? 'Use `summarize-long-chunked` (map-reduce — needs a client with a >60 s timeout, or the async-job path via `enqueue_job`). '
    : 'Split the input into smaller pieces. ';
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text:
      `Input too large for Tier ${tierKey}: ~${estTokens} estimated tokens exceeds the safe single-call ` +
      `limit (~${limit}; model context ${numCtx}). ${hint}` +
      `Alternatively raise oMLX's memory_guard_tier (safe → balanced → aggressive) in ~/.omlx/settings.json.` }],
  };
}

/**
 * Parse a positive integer env var. Returns undefined when the var is unset
 * or its value is not a positive integer (so the caller falls back to its
 * own default rather than silently using a malformed value).
 */
function parseEnvInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return undefined;
  return n;
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
  /** AbortSignal threaded to backend.chat(). Provided by the MCP SDK for
   *  sync calls; provided by the runner's progress-capture shim in async
   *  mode. */
  signal: AbortSignal;
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

/** Routing knob for image-vs-text source resolution. */
export type Modality = 'auto' | 'image' | 'text';

/** Zod input schema fragment for the per-tool `modality` knob. */
const ModalityInputSchema = z
  .enum(['auto', 'image', 'text'])
  .optional()
  .describe(
    "How to treat source_uri: 'auto' (default) sniffs by file extension " +
      "(.png/.jpg/.jpeg/.webp → image, else text); 'image' forces the vision " +
      "(VLM) tier; 'text' forces text. Inline `text` is always treated as text.",
  );

type SourceResolved =
  | { ok: true; kind: 'text'; text: string; bytes?: number }
  | {
      ok: true;
      kind: 'image';
      dataUri: string;
      mimeType: string;
      bytes: number;
      originalBytes: number;
      downscaled: boolean;
    }
  | { ok: false; message: string };

/** Heuristic: does this source_uri look like an image by its path extension? */
function looksLikeImageUri(uri: string): boolean {
  return /\.(png|jpe?g|webp)(?:[?#].*)?$/i.test(uri);
}

/**
 * Resolve the caller's source input: either `text` (inline) or `source_uri`
 * (file/URL). Exactly one must be provided. Returns a discriminated union so
 * the handler can short-circuit on failure without throwing.
 *
 * `modality` decides text vs image for a `source_uri` (inline `text` is always
 * text): 'image' forces the image path (VLM), 'text' forces text, 'auto'
 * (default) sniffs by extension. The image path fetches + downscales the image
 * and returns a bounded base64 data URI; raw image bytes never reach frontier.
 */
async function resolveSource(
  text: string | undefined,
  sourceUri: string | undefined,
  modality: Modality = 'auto',
): Promise<SourceResolved> {
  if (!text && !sourceUri) {
    return { ok: false, message: 'Either text or source_uri must be provided.' };
  }
  if (text && sourceUri) {
    return { ok: false, message: 'Provide either text or source_uri, not both.' };
  }
  if (sourceUri) {
    const wantImage =
      modality === 'image' || (modality === 'auto' && looksLikeImageUri(sourceUri));
    try {
      const opts = readSourceOptionsFromEnv();
      if (wantImage) {
        const img = await readImageSource(sourceUri, opts);
        return {
          ok: true,
          kind: 'image',
          dataUri: img.dataUri,
          mimeType: img.mimeType,
          bytes: img.bytes,
          originalBytes: img.originalBytes,
          downscaled: img.downscaled,
        };
      }
      const r = await readSource(sourceUri, opts);
      return { ok: true, kind: 'text', text: r.text, bytes: r.bytes };
    } catch (err) {
      return { ok: false, message: `source_uri read failed: ${(err as Error).message}` };
    }
  }
  return { ok: true, kind: 'text', text: text! };
}

// ── Server builder ──────────────────────────────────────────────────────────

export function buildBridgeServer(
  options: BridgeServerOptions = {},
): McpServer {
  const config = options.config ?? DEFAULT_CONFIG;
  const defendUntrusted = options.defendUntrusted ?? true;
  const defense = defendUntrusted ? new BridgeDefense() : null;

  const server = new McpServer({
    name: options.name ?? 'local-mcp',
    version: options.version ?? '0.6.0',
  });

  // ── tool-handler capture ───────────────────────────────────────────────────
  // The async-job runner (when wired) invokes registered tool handlers via
  // this Map. Every registerCapturedTool call mirrors a server.registerTool
  // call AND records the handler reference for later invocation. Direct MCP
  // tool calls go through the SDK as always; the Map is populated as a side effect.
  const toolHandlers = options.toolHandlers ?? new Map<string, CapturedToolHandler>();
  const registerCapturedTool = (
    name: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    schema: any,
    // Args are intentionally `any` so destructuring patterns in handler
    // bodies type-check; runtime shape is enforced by the schema (Zod).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: (args: any, extra: ToolExtra) => Promise<unknown>,
  ): void => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    server.registerTool(name, schema, handler as any);
    toolHandlers.set(name, handler as CapturedToolHandler);
  };

  // ── summarize ─────────────────────────────────────────────────────────────
  registerCapturedTool(
    'summarize',
    {
      title: 'Summarize text via a local model',
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
        modality: ModalityInputSchema,
        thinking: ThinkingInputSchema,
      },
    },
    async ({ text, source_uri, style, modality, thinking }, extra: ToolExtra) => {
      const src = await resolveSource(text, source_uri, modality);
      if (!src.ok) {
        return { isError: true as const, content: [{ type: 'text' as const, text: src.message }] };
      }
      if (src.kind === 'image') {
        // IMAGE path → tier V (VLM). No text defender (no text to scan).
        const vKey: Tier = 'V';
        const vCfg = config.tiers[vKey];
        const ti = Date.now();
        await sendProgress(extra, 1, 2, `image → Tier ${vKey} (${tierModelLabel(vCfg)})…`);
        try {
          const vBackend = backendForTool(config, 'summarize', vKey);
          const vUser = style
            ? `Summarize the attached image. Style: ${style}.`
            : 'Summarize the attached image — what it shows and its key content.';
          const vres = await vBackend.chat(
            {
              system: SUMMARIZE_SYSTEM,
              user: vUser,
              images: [src.dataUri],
              temperature: 0.2,
              maxInputTokens: vCfg.numCtx ?? 32768,
              maxOutputTokens: MAX_OUTPUT_TOKENS.summarize,
              disableThinking: resolveThinking('summarize', thinking) === 'off',
            },
            extra.signal,
          );
          const vLatency = Date.now() - ti;
          const vFooter = buildFooter({ model: tierModelLabel(vCfg), tier: vKey, latencyMs: vLatency, promptTokens: vres.promptTokens, completionTokens: vres.completionTokens });
          const vMeta = buildMeta({ model: tierModelLabel(vCfg), tier: vKey, latencyMs: vLatency, result: vres });
          vMeta['dev.localmcptoolbelt/source_uri'] = source_uri;
          vMeta['dev.localmcptoolbelt/source_bytes'] = src.bytes;
          vMeta['dev.localmcptoolbelt/image_mime'] = src.mimeType;
          vMeta['dev.localmcptoolbelt/image_downscaled'] = src.downscaled;
          return {
            content: [
              { type: 'text' as const, text: vres.text.trim() },
              ...(vFooter ? [{ type: 'text' as const, text: vFooter }] : []),
            ],
            _meta: vMeta,
          };
        } catch (err) {
          return toolCallError(err);
        }
      }
      const tierKey = tierForTool(config, 'summarize');
      const tierCfg = config.tiers[tierKey];
      const sizeErr = oversizeCheck(src.text, tierCfg.numCtx ?? 8192, MAX_OUTPUT_TOKENS.summarize, tierKey, { chunked: true });
      if (sizeErr) return sizeErr;
      const t0 = Date.now();
      await sendProgress(extra, 0, 3, `routing to Tier ${tierKey} (${tierModelLabel(tierCfg)})`);
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
              _meta: buildMeta({ model: tierModelLabel(tierCfg), tier: tierKey, latencyMs: Date.now() - t0, result: { promptTokens: 0, completionTokens: 0 }, defender: defenderMeta }),
            };
          }
          safeText = dResult.wrappedText;
          systemPrompt = dResult.systemPrefix + '\n\n' + SUMMARIZE_SYSTEM;
        }
        await sendProgress(extra, 2, 3, 'generating…');
        const user = style ? `Style: ${style}\n\nSource:\n${safeText}` : `Source:\n${safeText}`;
        const backend = backendForTool(config, 'summarize');
        const result = await backend.chat(
          {
            system: systemPrompt,
            user,
            temperature: 0.2,
            maxInputTokens: tierCfg.numCtx ?? 8192,
            maxOutputTokens: MAX_OUTPUT_TOKENS.summarize,
            disableThinking: resolveThinking('summarize', thinking) === 'off',
          },
          extra.signal,
        );
        const latencyMs = Date.now() - t0;
        const savedInputTokensEstimate = src.bytes !== undefined
          ? Math.max(0, Math.floor(src.bytes / 4) - result.completionTokens)
          : undefined;
        const footerText = buildFooter({ model: tierModelLabel(tierCfg), tier: tierKey, latencyMs, promptTokens: result.promptTokens, completionTokens: result.completionTokens, savedTokensEstimate: savedInputTokensEstimate });
        const meta = buildMeta({ model: tierModelLabel(tierCfg), tier: tierKey, latencyMs, result, defender: defenderMeta, savedInputTokensEstimate });
        if (source_uri) { meta['dev.localmcptoolbelt/source_uri'] = source_uri; meta['dev.localmcptoolbelt/source_bytes'] = src.bytes; }
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
  registerCapturedTool(
    'summarize-long',
    {
      title: 'Summarize long documents via a local model (larger model)',
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
        thinking: ThinkingInputSchema,
      },
    },
    async ({ text, source_uri, style, thinking }, extra: ToolExtra) => {
      const src = await resolveSource(text, source_uri);
      if (!src.ok) {
        return { isError: true as const, content: [{ type: 'text' as const, text: src.message }] };
      }
      if (src.kind === 'image') {
        return {
          isError: true as const,
          content: [{ type: 'text' as const, text: 'summarize-long is text-only (long-context tier C). For images use the VLM path on `extract`.' }],
        };
      }
      const tierKey = tierForTool(config, 'summarize-long');
      const tierCfg = config.tiers[tierKey];
      const sizeErr = oversizeCheck(src.text, tierCfg.numCtx ?? 8192, MAX_OUTPUT_TOKENS['summarize-long'], tierKey, { chunked: true });
      if (sizeErr) return sizeErr;
      const t0 = Date.now();
      await sendProgress(extra, 0, 3, `routing to Tier ${tierKey} (${tierModelLabel(tierCfg)})`);
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
              _meta: buildMeta({ model: tierModelLabel(tierCfg), tier: tierKey, latencyMs: Date.now() - t0, result: { promptTokens: 0, completionTokens: 0 }, defender: defenderMeta }),
            };
          }
          safeText = dResult.wrappedText;
          systemPrompt = dResult.systemPrefix + '\n\n' + SUMMARIZE_LONG_SYSTEM;
        }
        await sendProgress(extra, 2, 3, 'generating…');
        const user = style ? `Style override: ${style}\n\nSource:\n${safeText}` : `Source:\n${safeText}`;
        const backend = backendForTool(config, 'summarize-long');
        const result = await backend.chat(
          {
            system: systemPrompt,
            user,
            temperature: 0.2,
            maxInputTokens: tierCfg.numCtx ?? 8192,
            maxOutputTokens: MAX_OUTPUT_TOKENS['summarize-long'],
            disableThinking: resolveThinking('summarize-long', thinking) === 'off',
          },
          extra.signal,
        );
        const latencyMs = Date.now() - t0;
        const savedInputTokensEstimate = src.bytes !== undefined
          ? Math.max(0, Math.floor(src.bytes / 4) - result.completionTokens)
          : undefined;
        const footerText = buildFooter({ model: tierModelLabel(tierCfg), tier: tierKey, latencyMs, promptTokens: result.promptTokens, completionTokens: result.completionTokens, savedTokensEstimate: savedInputTokensEstimate });
        const meta = buildMeta({ model: tierModelLabel(tierCfg), tier: tierKey, latencyMs, result, defender: defenderMeta, savedInputTokensEstimate });
        if (source_uri) { meta['dev.localmcptoolbelt/source_uri'] = source_uri; meta['dev.localmcptoolbelt/source_bytes'] = src.bytes; }
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

  // ── summarize-long-chunked ───────────────────────────────────────────────
  registerCapturedTool(
    'summarize-long-chunked',
    {
      title: 'Summarize long documents via map-reduce chunking (Tier C)',
      description:
        'DELEGATION GUIDANCE: delegate very long documents (anything past Tier C\'s ~25 000-word ceiling on a single call, e.g. full podcasts, long reports, multi-chapter excerpts). Splits the source into overlapping ~2 000-token chunks, summarizes each in parallel, then recursively combines the chunk summaries into one coherent output. Each individual model call stays under ~50 s so the tool returns within Claude Code\'s ~60 s MCP request timeout window. ' +
        'WHEN TO USE: prefer summarize-long for inputs that fit in one Tier C call (~25 K words) — it has lower latency. Use summarize-long-chunked when (a) you don\'t know the input length and want the safe-superset behavior, or (b) the input is known to exceed ~25 K words. ' +
        'TOKEN SAVINGS: real frontier-token savings require source_uri — the bridge reads the source directly so it never enters your context. Inline `text` saves nothing if the content is already in your context.',
      inputSchema: {
        text: z.string().min(1).optional().describe(
          'The document to summarize. Required if source_uri is not provided. ' +
          'Saves no frontier tokens if already in your context — source_uri is strongly preferred.',
        ),
        source_uri: z.string().min(1).optional().describe(
          'URI to read source from instead of text. Supports file:// and http(s)://. ' +
          'Required if text is not provided. Strongly preferred for long content — the only path that actually saves frontier tokens.',
        ),
        style: z.string().optional().describe(
          'Optional style hint forwarded to the final reduce prompt. Default is 1-2 sentence lead plus 3-6 bullets.',
        ),
        max_chunks: z.number().int().min(1).optional().describe(
          'Safety cap on chunk count. Default 100. Job errors out above this — raise OMCP_CHUNK_SIZE or split the source instead of raising this.',
        ),
        thinking: ThinkingInputSchema,
      },
    },
    async ({ text, source_uri, style, max_chunks, thinking }, extra: ToolExtra) => {
      const src = await resolveSource(text, source_uri);
      if (!src.ok) {
        return { isError: true as const, content: [{ type: 'text' as const, text: src.message }] };
      }
      if (src.kind === 'image') {
        return {
          isError: true as const,
          content: [{ type: 'text' as const, text: 'summarize-long-chunked is text-only (map-reduce over long text). For images use the VLM path on `extract`.' }],
        };
      }
      const tierKey = tierForTool(config, 'summarize-long-chunked');
      const tierCfg = config.tiers[tierKey];
      const t0 = Date.now();
      await sendProgress(extra, 0, 5, `routing to Tier ${tierKey} (${tierModelLabel(tierCfg)})`);
      try {
        let defenderMeta: Parameters<typeof buildMeta>[0]['defender'];
        if (defense) {
          const dResult = await defense.defend(src.text, 'summarize-long-chunked');
          defenderMeta = { tier: dResult.defenderTier, score: dResult.score, risk: dResult.risk };
          await sendProgress(extra, 1, 5, `defender passed (risk=${dResult.risk ?? 'low'})`);
          if (!dResult.allowed) {
            return {
              isError: true as const,
              content: [{ type: 'text' as const, text: `Prompt injection detected (risk=${dResult.risk}). Request blocked.` }],
              _meta: buildMeta({ model: tierModelLabel(tierCfg), tier: tierKey, latencyMs: Date.now() - t0, result: { promptTokens: 0, completionTokens: 0 }, defender: defenderMeta }),
            };
          }
          // Defender's allowed-vs-blocked decision is honored. We do NOT
          // forward `dResult.wrappedText` (Microsoft Spotlighting wrapping)
          // into the chunker because chunk boundaries would split the
          // unique-delimiter wrapping, defeating the spotlighting model.
          // The Tier-1 regex classifier (always-on) and NFKC normalization
          // already ran on the full source and pass/fail the call before
          // any chunking; we accept losing spotlighting on the per-chunk
          // model calls as an accepted trade-off.
        }
        const chunkSize = parseEnvInt('OMCP_CHUNK_SIZE');
        const chunkOverlap = parseEnvInt('OMCP_CHUNK_OVERLAP');
        const concurrency = parseEnvInt('OMCP_CHUNK_CONCURRENCY');
        const backend = backendForTool(config, 'summarize-long-chunked');
        const result = await chunkedSummarize({
          source: src.text,
          style,
          maxChunks: max_chunks,
          backend,
          maxInputTokens: tierCfg.numCtx ?? 8192,
          signal: extra.signal,
          chunkSize,
          chunkOverlap,
          disableThinking:
            resolveThinking('summarize-long-chunked', thinking) === 'off',
          concurrency,
          onProgress: async (msg, current, total) => {
            // Map chunked progress (variable phases) onto the 5-step bar.
            // Phases: 0=routing, 1=defender, 2=chunking-and-MAP, 3=REDUCE, 4=done.
            // We pass current/total straight through; the message text
            // carries the phase context.
            await sendProgress(extra, Math.min(current, 4), Math.max(total, 5), msg);
          },
        });
        const latencyMs = Date.now() - t0;
        const savedInputTokensEstimate = src.bytes !== undefined
          ? Math.max(0, Math.floor(src.bytes / 4) - result.completionTokens)
          : undefined;
        const footerText = buildFooter({
          model: tierModelLabel(tierCfg),
          tier: tierKey,
          latencyMs,
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          savedTokensEstimate: savedInputTokensEstimate,
          chunks: result.chunksProcessed,
          partial: result.partial,
        });
        const meta = buildMeta({
          model: tierModelLabel(tierCfg),
          tier: tierKey,
          latencyMs,
          result: {
            promptTokens: result.promptTokens,
            completionTokens: result.completionTokens,
          },
          defender: defenderMeta,
          savedInputTokensEstimate,
          chunked: {
            chunksProcessed: result.chunksProcessed,
            reduceDepth: result.reduceDepth,
            partial: result.partial,
            chunksFailed: result.chunksFailed,
            reduceFailed: result.reduceFailed,
          },
        });
        if (source_uri) {
          meta['dev.localmcptoolbelt/source_uri'] = source_uri;
          meta['dev.localmcptoolbelt/source_bytes'] = src.bytes;
        }
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
  registerCapturedTool(
    'classify',
    {
      title: 'Classify text into categories via a local model',
      description:
        'DELEGATION GUIDANCE: delegate text classification to a local model. ' +
        'The model is grammar-constrained to emit only labels from the provided category list — ' +
        'no hallucinated labels possible. Use for sentiment, intent, topic, priority, or any ' +
        'enum-typed labeling task. ' +
        'VALUE: reliability, not token savings. Grammar-constrained output guarantees every ' +
        'response is a valid member of your categories — something small local models cannot ' +
        'reliably self-enforce. Data stays local. Accepts inline `text` (typical — classify inputs ' +
        'are usually short and already in your context) OR a `source_uri` to an IMAGE (png/jpg/webp) ' +
        'to classify visually via the local VLM tier (raw image bytes never enter your context).',
      inputSchema: {
        text: z.string().min(1).optional().describe('The text to classify. Required if source_uri is not provided.'),
        source_uri: z.string().min(1).optional().describe(
          'URI to an IMAGE to classify (file:// or http(s)://, png/jpg/webp). Routes to the local VLM tier. ' +
          'Use modality to force image/text; defaults to sniff-by-extension.',
        ),
        categories: z.array(z.string()).min(2).describe(
          'Exhaustive list of valid labels. The model will pick only from this list.',
        ),
        allow_multiple: z.boolean().optional().describe(
          'If true, the model may assign more than one label. Default false (single label).',
        ),
        explain: z.boolean().optional().describe(
          'If true, include a short reason field in the output.',
        ),
        modality: ModalityInputSchema,
        thinking: ThinkingInputSchema,
      },
    },
    async ({ text, source_uri, categories, allow_multiple, explain, modality, thinking }, extra: ToolExtra) => {
      const src = await resolveSource(text, source_uri, modality);
      if (!src.ok) {
        return { isError: true as const, content: [{ type: 'text' as const, text: src.message }] };
      }
      // Grammar-constrained label schema — shared by text and image paths.
      const labelEnum = categories as [string, ...string[]];
      const labelsSchema = allow_multiple
        ? { type: 'array', items: { enum: labelEnum }, minItems: 1 }
        : { type: 'array', items: { enum: labelEnum }, minItems: 1, maxItems: 1 };
      const formatSchema = explain
        ? { type: 'object', properties: { labels: labelsSchema, reason: { type: 'string' } }, required: ['labels', 'reason'] }
        : { type: 'object', properties: { labels: labelsSchema }, required: ['labels'] };

      if (src.kind === 'image') {
        // IMAGE path → tier V (VLM). No text defender (no text to scan).
        const vKey: Tier = 'V';
        const vCfg = config.tiers[vKey];
        const ti = Date.now();
        await sendProgress(extra, 1, 2, `image → Tier ${vKey} (${tierModelLabel(vCfg)})…`);
        try {
          const vBackend = backendForTool(config, 'classify', vKey);
          const vres = await vBackend.chat(
            {
              system: CLASSIFY_SYSTEM,
              user: 'Classify the attached image into the provided categories.',
              images: [src.dataUri],
              temperature: 0.1,
              maxInputTokens: vCfg.numCtx ?? 32768,
              format: formatSchema,
              maxOutputTokens: MAX_OUTPUT_TOKENS.classify,
              disableThinking: resolveThinking('classify', thinking) === 'off',
            },
            extra.signal,
          );
          const vLatency = Date.now() - ti;
          const vFooter = buildFooter({ model: tierModelLabel(vCfg), tier: vKey, latencyMs: vLatency, promptTokens: vres.promptTokens, completionTokens: vres.completionTokens });
          const vMeta = buildMeta({ model: tierModelLabel(vCfg), tier: vKey, latencyMs: vLatency, result: vres });
          vMeta['dev.localmcptoolbelt/source_uri'] = source_uri;
          vMeta['dev.localmcptoolbelt/source_bytes'] = src.bytes;
          vMeta['dev.localmcptoolbelt/image_mime'] = src.mimeType;
          vMeta['dev.localmcptoolbelt/image_downscaled'] = src.downscaled;
          return {
            content: [
              { type: 'text' as const, text: vres.text },
              ...(vFooter ? [{ type: 'text' as const, text: vFooter }] : []),
            ],
            _meta: vMeta,
          };
        } catch (err) {
          return toolCallError(err);
        }
      }

      const inputText = src.text;
      const tierKey = tierForTool(config, 'classify');
      const tierCfg = config.tiers[tierKey];
      const t0 = Date.now();
      await sendProgress(extra, 0, 3, `routing to Tier ${tierKey} (${tierModelLabel(tierCfg)})`);
      try {
        let safeText = inputText;
        let systemPrompt = CLASSIFY_SYSTEM;
        let defenderMeta: Parameters<typeof buildMeta>[0]['defender'];
        if (defense) {
          const dResult = await defense.defend(inputText, 'classify');
          defenderMeta = { tier: dResult.defenderTier, score: dResult.score, risk: dResult.risk };
          await sendProgress(extra, 1, 3, `defender passed (risk=${dResult.risk ?? 'low'})`);
          if (!dResult.allowed) {
            return {
              isError: true as const,
              content: [{ type: 'text' as const, text: `Prompt injection detected (risk=${dResult.risk}). Request blocked.` }],
              _meta: buildMeta({ model: tierModelLabel(tierCfg), tier: tierKey, latencyMs: Date.now() - t0, result: { promptTokens: 0, completionTokens: 0 }, defender: defenderMeta }),
            };
          }
          safeText = dResult.wrappedText;
          systemPrompt = dResult.systemPrefix + '\n\n' + CLASSIFY_SYSTEM;
        }
        await sendProgress(extra, 2, 3, 'generating…');
        const backend = backendForTool(config, 'classify');
        const result = await backend.chat(
          {
            system: systemPrompt,
            user: safeText,
            temperature: 0.1, // lower temp for classification
            maxInputTokens: tierCfg.numCtx ?? 8192,
            format: formatSchema,
            maxOutputTokens: MAX_OUTPUT_TOKENS.classify,
            disableThinking: resolveThinking('classify', thinking) === 'off',
          },
          extra.signal,
        );
        const latencyMs = Date.now() - t0;
        const footerText = buildFooter({ model: tierModelLabel(tierCfg), tier: tierKey, latencyMs, promptTokens: result.promptTokens, completionTokens: result.completionTokens });
        return {
          content: [
            { type: 'text' as const, text: result.text },
            ...(footerText ? [{ type: 'text' as const, text: footerText }] : []),
          ],
          _meta: buildMeta({ model: tierModelLabel(tierCfg), tier: tierKey, latencyMs, result, defender: defenderMeta }),
        };
      } catch (err) {
        return toolCallError(err);
      }
    },
  );

  // ── extract (F2) ──────────────────────────────────────────────────────────
  registerCapturedTool(
    'extract',
    {
      title: 'Extract structured data from text via a local model',
      description:
        'DELEGATION GUIDANCE: delegate structured-data extraction to a local model. ' +
        'Pass a JSON Schema object; the model is grammar-constrained to produce output ' +
        'matching that schema. Supports flat objects, nested objects, arrays, enums, ' +
        'minLength/maxLength/minItems/maxItems, anyOf unions (structural only — for reliable ' +
        'branch selection prefer z.discriminatedUnion). ' +
        'Constraints rejected by the local model\'s strict json_schema mode (pattern, format:email/uri/date-time, ' +
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
          'Avoid z.email(), z.url(), z.string().regex() — they are rejected by the local model\'s strict json_schema mode.',
        ),
        modality: ModalityInputSchema,
        thinking: ThinkingInputSchema,
      },
    },
    async ({ text, source_uri, schema, modality, thinking }, extra: ToolExtra) => {
      const src = await resolveSource(text, source_uri, modality);
      if (!src.ok) {
        return { isError: true as const, content: [{ type: 'text' as const, text: src.message }] };
      }
      const tierKey = tierForTool(config, 'extract');
      const tierCfg = config.tiers[tierKey];
      const t0 = Date.now();
      await sendProgress(extra, 0, 3, `routing to Tier ${tierKey} (${tierModelLabel(tierCfg)})`);
      try {
        // Schema sanitation (F2 sanitizer)
        const sanitized = sanitizeSchemaForStrictMode(schema);
        if (!sanitized.ok) {
          return {
            isError: true as const,
            content: [{ type: 'text' as const, text: `Schema rejected: $ref is not supported (path: ${sanitized.path}). Resolve all $ref before calling extract.` }],
            _meta: buildMeta({ model: tierModelLabel(tierCfg), tier: tierKey, latencyMs: Date.now() - t0, result: { promptTokens: 0, completionTokens: 0 } }),
          };
        }

        // ── IMAGE path → tier V (Qwen3-VL). Self-contained early return; the
        // text path below is untouched. No text defender runs (there is no text
        // to scan — image-borne prompt injection is out of v0.8.0 scope). Schema
        // sanitation above is shared.
        if (src.kind === 'image') {
          const vKey: Tier = 'V';
          const vCfg = config.tiers[vKey];
          await sendProgress(extra, 2, 3, `image → Tier ${vKey} (${tierModelLabel(vCfg)})…`);
          const vBackend = backendForTool(config, 'extract', vKey);
          const vres = await vBackend.chat(
            {
              system: EXTRACT_SYSTEM,
              user:
                'Extract structured data from the attached image as JSON matching the schema. ' +
                'Transcribe text — including CJK — verbatim.',
              images: [src.dataUri],
              temperature: 0.2,
              maxInputTokens: vCfg.numCtx ?? 32768,
              format: sanitized.schema,
              maxOutputTokens: MAX_OUTPUT_TOKENS.extract,
              disableThinking: resolveThinking('extract', thinking) === 'off',
            },
            extra.signal,
          );
          const vLatency = Date.now() - t0;
          const vFooter = buildFooter({
            model: tierModelLabel(vCfg),
            tier: vKey,
            latencyMs: vLatency,
            promptTokens: vres.promptTokens,
            completionTokens: vres.completionTokens,
          });
          const vMeta = buildMeta({
            model: tierModelLabel(vCfg),
            tier: vKey,
            latencyMs: vLatency,
            result: vres,
            schemaValidation: 'passed',
            schemaStripped: sanitized.stripped,
          });
          vMeta['dev.localmcptoolbelt/source_uri'] = source_uri;
          vMeta['dev.localmcptoolbelt/source_bytes'] = src.bytes;
          vMeta['dev.localmcptoolbelt/image_mime'] = src.mimeType;
          vMeta['dev.localmcptoolbelt/image_downscaled'] = src.downscaled;
          return {
            content: [
              { type: 'text' as const, text: vres.text },
              ...(vFooter ? [{ type: 'text' as const, text: vFooter }] : []),
            ],
            _meta: vMeta,
          };
        }

        const sizeErr = oversizeCheck(src.text, tierCfg.numCtx ?? 8192, MAX_OUTPUT_TOKENS.extract, tierKey);
        if (sizeErr) return sizeErr;
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
              _meta: buildMeta({ model: tierModelLabel(tierCfg), tier: tierKey, latencyMs: Date.now() - t0, result: { promptTokens: 0, completionTokens: 0 }, defender: defenderMeta, schemaStripped: sanitized.stripped }),
            };
          }
          safeText = dResult.wrappedText;
          systemPrompt = dResult.systemPrefix + '\n\n' + EXTRACT_SYSTEM;
        }
        await sendProgress(extra, 2, 3, 'generating…');
        const backend = backendForTool(config, 'extract');
        const result = await backend.chat(
          {
            system: systemPrompt,
            user: safeText,
            temperature: 0.2,
            maxInputTokens: tierCfg.numCtx ?? 8192,
            format: sanitized.schema,
            maxOutputTokens: MAX_OUTPUT_TOKENS.extract,
            disableThinking: resolveThinking('extract', thinking) === 'off',
          },
          extra.signal,
        );
        const latencyMs = Date.now() - t0;
        const savedInputTokensEstimate = src.bytes !== undefined
          ? Math.max(0, Math.floor(src.bytes / 4) - result.completionTokens)
          : undefined;
        const footerText = buildFooter({ model: tierModelLabel(tierCfg), tier: tierKey, latencyMs, promptTokens: result.promptTokens, completionTokens: result.completionTokens, savedTokensEstimate: savedInputTokensEstimate });
        const meta = buildMeta({
          model: tierModelLabel(tierCfg),
          tier: tierKey,
          latencyMs,
          result,
          defender: defenderMeta,
          schemaValidation: 'passed',
          schemaStripped: sanitized.stripped,
          savedInputTokensEstimate,
        });
        if (source_uri) { meta['dev.localmcptoolbelt/source_uri'] = source_uri; meta['dev.localmcptoolbelt/source_bytes'] = src.bytes; }
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
  registerCapturedTool(
    'transform',
    {
      title: 'Rewrite or transform text via a local model',
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
        thinking: ThinkingInputSchema,
      },
    },
    async ({ text, source_uri, instruction, thinking }, extra: ToolExtra) => {
      const src = await resolveSource(text, source_uri);
      if (!src.ok) {
        return { isError: true as const, content: [{ type: 'text' as const, text: src.message }] };
      }
      if (src.kind === 'image') {
        return {
          isError: true as const,
          content: [{ type: 'text' as const, text: 'transform does not accept an image source_uri. For structured image extraction use `extract` with an image source_uri.' }],
        };
      }
      const tierKey = tierForTool(config, 'transform');
      const tierCfg = config.tiers[tierKey];
      const t0 = Date.now();
      await sendProgress(extra, 0, 3, `routing to Tier ${tierKey} (${tierModelLabel(tierCfg)})`);
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
              _meta: buildMeta({ model: tierModelLabel(tierCfg), tier: tierKey, latencyMs: Date.now() - t0, result: { promptTokens: 0, completionTokens: 0 }, defender: defenderMeta }),
            };
          }
          safeText = dResult.wrappedText;
          systemPrompt = dResult.systemPrefix + '\n\n' + TRANSFORM_SYSTEM;
        }
        await sendProgress(extra, 2, 3, 'generating…');
        const backend = backendForTool(config, 'transform');
        const result = await backend.chat(
          {
            system: systemPrompt,
            user: `Instruction: ${instruction}\n\nText:\n${safeText}`,
            temperature: 0.3,
            maxInputTokens: tierCfg.numCtx ?? 8192,
            maxOutputTokens: MAX_OUTPUT_TOKENS.transform,
            disableThinking: resolveThinking('transform', thinking) === 'off',
          },
          extra.signal,
        );
        const latencyMs = Date.now() - t0;
        const savedInputTokensEstimate = src.bytes !== undefined
          ? Math.max(0, Math.floor(src.bytes / 4) - result.completionTokens)
          : undefined;
        const footerText = buildFooter({ model: tierModelLabel(tierCfg), tier: tierKey, latencyMs, promptTokens: result.promptTokens, completionTokens: result.completionTokens, savedTokensEstimate: savedInputTokensEstimate });
        const meta = buildMeta({ model: tierModelLabel(tierCfg), tier: tierKey, latencyMs, result, defender: defenderMeta, savedInputTokensEstimate });
        if (source_uri) { meta['dev.localmcptoolbelt/source_uri'] = source_uri; meta['dev.localmcptoolbelt/source_bytes'] = src.bytes; }
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

  // ── diff-semantic-index ───────────────────────────────────────────────────
  registerCapturedTool(
    'diff-semantic-index',
    {
      title: 'Structured semantic index of a git diff',
      description:
        'Parse a `git diff` into a typed JSON summary: change_type, 1-sentence summary, ' +
        'per-file roles and line counts, key architectural decisions, risk callouts, and ' +
        'a test_coverage_hint. Tier B, schema-constrained output. ' +
        'TOKEN LIMIT: estimated input tokens > 7 000 returns isError with a hint to use ' +
        'enqueue-job + summarize-long-chunked to reduce the diff first. ' +
        'USAGE: pass diff_text for small diffs or source_uri=file:///tmp/my.diff for large ones ' +
        '(ARG_MAX on macOS is ~256 KB — always prefer source_uri for CI diffs).',
      inputSchema: {
        diff_text: z.string().optional().describe(
          'Raw git diff output. Required if source_uri is not provided. ' +
          'Caller is responsible for not exceeding ~28 KB (~7 K tokens).',
        ),
        source_uri: z.string().optional().describe(
          'file:// or http(s):// URI to read the diff from. Required if diff_text is not provided. ' +
          'Preferred for diffs > 4 KB to avoid ARG_MAX limits and save frontier tokens.',
        ),
        thinking: ThinkingInputSchema,
      },
    },
    async (
      {
        diff_text,
        source_uri,
        thinking,
      }: { diff_text?: string; source_uri?: string; thinking?: ThinkingMode },
      extra: ToolExtra,
    ) => {
      const src = await resolveSource(diff_text, source_uri);
      if (!src.ok) {
        return { isError: true as const, content: [{ type: 'text' as const, text: src.message }] };
      }

      if (src.kind === 'image') {
        return {
          isError: true as const,
          content: [{ type: 'text' as const, text: 'diff-semantic-index is text-only. Image input is not supported.' }],
        };
      }
      const diffText = src.text;

      // Token-budget guard: Tier B has num_ctx=8192; leave ~2K for output.
      const estimatedTokens = Math.ceil(diffText.length / 4);
      if (estimatedTokens > 7000) {
        return {
          isError: true as const,
          content: [{
            type: 'text' as const,
            text:
              `Diff is too large for Tier B context (~${estimatedTokens} estimated tokens, limit 7 000). ` +
              'Consider: (1) use --staged to index only staged changes, or (2) use enqueue-job with ' +
              'summarize-long-chunked to compress the diff text first, then call diff-semantic-index ' +
              'on the summary.',
          }],
        };
      }

      const tierKey = tierForTool(config, 'diff-semantic-index');
      const tierCfg = config.tiers[tierKey];
      const t0 = Date.now();
      await sendProgress(extra, 0, 3, `routing to Tier ${tierKey} (${tierModelLabel(tierCfg)})`);

      try {
        // Pre-parse the diff so the model gets a structured index + raw diff.
        const parsed = parseDiffText(diffText);
        const parsedSummary = formatParsedDiffForPrompt(parsed);
        const hintFromParse = deriveTestCoverageHint(parsed);

        let safeText = diffText;
        let systemPrompt = DIFF_INDEX_SYSTEM;
        let defenderMeta: Parameters<typeof buildMeta>[0]['defender'];
        if (defense) {
          const dResult = await defense.defend(diffText, 'diff-semantic-index');
          defenderMeta = { tier: dResult.defenderTier, score: dResult.score, risk: dResult.risk };
          await sendProgress(extra, 1, 3, `defender passed (risk=${dResult.risk ?? 'low'})`);
          if (!dResult.allowed) {
            return {
              isError: true as const,
              content: [{ type: 'text' as const, text: `Prompt injection detected (risk=${dResult.risk}). Request blocked.` }],
              _meta: buildMeta({ model: tierModelLabel(tierCfg), tier: tierKey, latencyMs: Date.now() - t0, result: { promptTokens: 0, completionTokens: 0 }, defender: defenderMeta }),
            };
          }
          safeText = dResult.wrappedText;
          systemPrompt = dResult.systemPrefix + '\n\n' + DIFF_INDEX_SYSTEM;
        }

        await sendProgress(extra, 2, 3, 'generating…');
        const sanitized = sanitizeSchemaForStrictMode(DIFF_INDEX_OUTPUT_SCHEMA);
        if (!sanitized.ok) {
          return {
            isError: true as const,
            content: [{ type: 'text' as const, text: `Internal schema error: ${sanitized.reason}` }],
          };
        }
        const backend = backendForTool(config, 'diff-semantic-index');
        const result = await backend.chat(
          {
            system: systemPrompt,
            user:
              '=== STRUCTURED DIFF PARSE ===\n' +
              parsedSummary +
              '\n\n=== RAW DIFF ===\n' +
              safeText,
            temperature: 0.1,
            maxInputTokens: tierCfg.numCtx ?? 8192,
            format: sanitized.schema,
            maxOutputTokens: MAX_OUTPUT_TOKENS['diff-semantic-index'],
            disableThinking: resolveThinking('diff-semantic-index', thinking) === 'off',
          },
          extra.signal,
        );
        const latencyMs = Date.now() - t0;

        // Parse and coerce LLM JSON output.
        let output: Record<string, unknown>;
        try {
          output = JSON.parse(result.text) as Record<string, unknown>;
        } catch {
          return {
            isError: true as const,
            content: [{ type: 'text' as const, text: `Model returned invalid JSON: ${result.text.slice(0, 200)}` }],
          };
        }

        // Coerce files_touched[].role to valid enum (free-string field may produce non-enum values).
        const VALID_ROLES = new Set(['added', 'modified', 'deleted', 'renamed']);
        if (Array.isArray(output['files_touched'])) {
          for (const f of output['files_touched'] as Array<Record<string, unknown>>) {
            if (typeof f['role'] === 'string' && !VALID_ROLES.has(f['role'])) {
              f['role'] = 'modified'; // safe fallback
            }
          }
        }

        // Prefer the parse-derived hint if the model returned 'unclear'.
        if (output['test_coverage_hint'] === 'unclear') {
          output['test_coverage_hint'] = hintFromParse;
        }

        const VALID_CHANGE_TYPES = new Set(['feature', 'fix', 'refactor', 'docs', 'test', 'chore', 'mixed']);
        if (typeof output['change_type'] === 'string' && !VALID_CHANGE_TYPES.has(output['change_type'])) {
          output['change_type'] = 'mixed';
        }

        const savedInputTokensEstimate = src.bytes !== undefined
          ? Math.max(0, Math.floor(src.bytes / 4) - result.completionTokens)
          : undefined;
        const footerText = buildFooter({
          model: tierModelLabel(tierCfg), tier: tierKey, latencyMs,
          promptTokens: result.promptTokens, completionTokens: result.completionTokens,
          savedTokensEstimate: savedInputTokensEstimate,
        });
        const meta = buildMeta({
          model: tierModelLabel(tierCfg), tier: tierKey, latencyMs, result,
          defender: defenderMeta, savedInputTokensEstimate,
        });
        if (source_uri) {
          meta['dev.localmcptoolbelt/source_uri'] = source_uri;
          meta['dev.localmcptoolbelt/source_bytes'] = src.bytes;
        }
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify(output, null, 2) },
            ...(footerText ? [{ type: 'text' as const, text: footerText }] : []),
          ],
          _meta: meta,
        };
      } catch (err) {
        return toolCallError(err);
      }
    },
  );

  // ── async-job tools ────────────────────────────────────────────────────────
  // Registered only when both jobRegistry AND jobRunner are provided. Tests
  // that don't need async machinery omit them.
  if (options.jobRegistry && options.jobRunner) {
    const jobRegistry = options.jobRegistry;
    const jobRunner = options.jobRunner;
    const ASYNC_TOOL_WHITELIST = [
      'summarize',
      'summarize-long',
      'summarize-long-chunked',
      'classify',
      'extract',
      'transform',
      'diff-semantic-index',
    ] as const;

    // ── wait_for_job (RFC 6202 long-poll) ─────────────────────────────────
    server.registerTool(
      'wait_for_job',
      {
        title: 'Long-poll for async job completion (v0.3.0; deprecated by check_progress in v0.6.0)',
        description:
          '[DEPRECATED in v0.6.0] Prefer `check_progress` (portable across MCP clients, instant return) or the `wait_command` Bash one-liner returned by `enqueue_job` when your client advertises bash. Still maintained for v0.3.0 callers through v0.6.x; planned removal in a future major. ' +
          'Block up to max_wait_ms (default and server-cap 45 s, OMCP_WAIT_CAP_MS overrides up to 50 s) for an enqueued job to finish. Returns immediately when the job becomes done/failed. If the cap is reached, returns status: running so the caller can call again. Cap is below the 60 s MCP wall to leave margin for transport round-trip + event-loop lag under heavy local model load. ' +
          'Client-disconnect resilience: if the calling MCP client aborts mid-wait, the underlying job continues — re-attach via another wait_for_job(same_id) or read_job_result.',
        inputSchema: {
          job_id: z.string().min(1).describe('The job_id returned from enqueue-job.'),
          max_wait_ms: z.number().int().min(100).max(50000).optional().describe(
            'Max ms to block. Default 45000. Server caps at 45 000 (or OMCP_WAIT_CAP_MS up to 50 000).',
          ),
        },
      },
      async (
        { job_id, max_wait_ms }: { job_id: string; max_wait_ms?: number },
        extra: ToolExtra,
      ) => {
        const cap = Math.min(parseEnvInt('OMCP_WAIT_CAP_MS') ?? 45000, 50000);
        const wait = Math.min(max_wait_ms ?? cap, cap);

        const formatResponse = (
          status: 'running' | 'done' | 'failed' | 'unknown',
          extras: Record<string, unknown> = {},
        ): { content: Array<{ type: 'text'; text: string }> } => ({
          content: [
            { type: 'text' as const, text: JSON.stringify({ status, ...extras }, null, 2) },
          ],
        });

        const meta = await jobRegistry.getMeta(job_id);
        if (!meta) return formatResponse('unknown', { reason: 'never_existed' });

        if (meta.status === 'done') {
          return formatResponse('done', {
            result_path: jobRegistry.store.resultPath(meta.job_id),
            ...(meta.footer !== undefined ? { footer: meta.footer } : {}),
          });
        }
        if (meta.status === 'failed') {
          return formatResponse('failed', { error: meta.error ?? 'unknown error' });
        }

        // Still queued/running — long-poll up to `wait` ms or until update.
        const finalMeta = await new Promise<typeof meta>((resolve) => {
          let timer: NodeJS.Timeout | undefined;
          const unsub = jobRegistry.onUpdate(job_id, (e) => {
            if (e.status === 'done' || e.status === 'failed') {
              if (timer) clearTimeout(timer);
              unsub();
              cleanup();
              resolve(e.meta);
            }
          });
          const onAbort = (): void => {
            if (timer) clearTimeout(timer);
            unsub();
            cleanup();
            // On abort, return current state so the response shape stays valid.
            // The job itself continues running; the caller can re-attach later.
            void jobRegistry.getMeta(job_id).then((m) => resolve(m ?? meta));
          };
          const cleanup = (): void => {
            extra.signal?.removeEventListener('abort', onAbort);
          };
          extra.signal?.addEventListener('abort', onAbort);
          timer = setTimeout(() => {
            unsub();
            cleanup();
            void jobRegistry.getMeta(job_id).then((m) => resolve(m ?? meta));
          }, wait);
        });

        if (finalMeta.status === 'done') {
          return formatResponse('done', {
            result_path: jobRegistry.store.resultPath(finalMeta.job_id),
            ...(finalMeta.footer !== undefined ? { footer: finalMeta.footer } : {}),
          });
        }
        if (finalMeta.status === 'failed') {
          return formatResponse('failed', { error: finalMeta.error ?? 'unknown error' });
        }
        // Still running after the wait window — caller should call again.
        return formatResponse('running', {
          ...(finalMeta.progress ? { progress: finalMeta.progress } : {}),
        });
      },
    );

    // ── read_job_result ───────────────────────────────────────────────────
    server.registerTool(
      'read_job_result',
      {
        title: 'Read the persisted result of a completed async job',
        description:
          'Returns the .md result body for a job whose status is done. The body includes the trailing footer line. Returns isError: true with reason if the job is unknown, expired, or not yet done. Result files persist in .memory/jobs/ for ttl_days (default 7) after enqueue.',
        inputSchema: {
          job_id: z.string().min(1).describe('The job_id returned from enqueue-job.'),
        },
      },
      async ({ job_id }: { job_id: string }) => {
        const meta = await jobRegistry.getMeta(job_id);
        if (!meta) {
          return {
            isError: true as const,
            content: [
              {
                type: 'text' as const,
                text: `Job ${job_id} not found (never existed or expired).`,
              },
            ],
          };
        }
        if (meta.status === 'failed') {
          return {
            isError: true as const,
            content: [
              {
                type: 'text' as const,
                text: `Job ${job_id} failed: ${meta.error ?? 'unknown error'}`,
              },
            ],
          };
        }
        if (meta.status !== 'done') {
          return {
            isError: true as const,
            content: [
              {
                type: 'text' as const,
                text: `Job ${job_id} not done yet (status: ${meta.status}). Use wait_for_job to wait for completion.`,
              },
            ],
          };
        }
        const body = await jobRegistry.store.readResult(job_id);
        if (body === null) {
          return {
            isError: true as const,
            content: [
              {
                type: 'text' as const,
                text: `Job ${job_id} reports done but result file is missing (.md not found).`,
              },
            ],
          };
        }
        // Inline-content is the primary path (works on sandboxed clients that
        // can't read file://). For very large results (e.g. chunked summaries
        // of book-length sources) the bridge returns the file path instead.
        // Threshold defaults to 1 MB; configurable via OMCP_INLINE_RESULT_MAX_BYTES.
        const inlineMaxBytes = (() => {
          const raw = process.env['OMCP_INLINE_RESULT_MAX_BYTES'];
          const parsed = raw !== undefined ? Number(raw) : NaN;
          return Number.isFinite(parsed) && parsed > 0 ? parsed : 1_048_576;
        })();
        const bodyBytes = Buffer.byteLength(body, 'utf-8');
        if (bodyBytes > inlineMaxBytes) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  {
                    file_path: jobRegistry.store.resultPath(job_id),
                    bytes: bodyBytes,
                    inline_max_bytes: inlineMaxBytes,
                    note:
                      'Result exceeds inline threshold; read the file via your client\'s ' +
                      'Read tool, or raise OMCP_INLINE_RESULT_MAX_BYTES if the client can ' +
                      'accept larger inline payloads.',
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
        return { content: [{ type: 'text' as const, text: body }] };
      },
    );

    // ── check_progress ────────────────────────────────────────────────────
    // Lightweight cross-client status poll. Each call is one MCP roundtrip,
    // returns instantly (<100 ms). Use when the caller is not on Claude Code
    // (which can use the wait_command Bash one-liner from enqueue_job)
    // and wants to avoid wait_for_job's 45 s long-poll semantics.
    // Suggested cadence: every 2 s for the first 60 s, every 5 s thereafter.
    server.registerTool(
      'check_progress',
      {
        title: 'Lightweight non-blocking status check for an async job',
        description:
          'Cross-client universal poll: returns the current status of a job ' +
          'without blocking. Each call is one MCP roundtrip, instant (<100 ms). ' +
          'Suggested cadence: every 2 s for the first 60 s, every 5 s thereafter. ' +
          'COMPARE WITH: wait_for_job (long-poll, blocks up to 45 s, v0.3.0 deprecated) ' +
          '— use check_progress unless you specifically need long-poll. ' +
          'COMPARE WITH: wait_command (POSIX one-liner from enqueue_job, Claude-Code only).',
        inputSchema: {
          job_id: z.string().min(1).describe('The job_id returned from enqueue_job / enqueue-job.'),
        },
      },
      async ({ job_id }: { job_id: string }) => {
        const meta = await jobRegistry.getMeta(job_id);
        if (!meta) {
          return {
            isError: true as const,
            content: [
              {
                type: 'text' as const,
                text: `Job ${job_id} not found (never existed or expired).`,
              },
            ],
          };
        }
        const out: Record<string, unknown> = { status: meta.status };
        // Progress: convert {current, total} to 0-100 percentage when total > 0.
        // Only chunked tools emit progress; for monolithic tools the field is
        // omitted from the response (caller treats absence as "no progress data").
        // Clamp to [0, 100] — adversarial review (3/3 voices) flagged that
        // current > total (possible via chunking bugs or out-of-order updates)
        // could produce >100% or even negative values.
        if (meta.progress && meta.progress.total > 0) {
          const raw = Math.round(
            (meta.progress.current / meta.progress.total) * 100,
          );
          out.progress = Math.max(0, Math.min(raw, 100));
          if (meta.progress.message) {
            out.message = meta.progress.message;
          }
        }
        if (meta.status === 'failed' && meta.error) {
          out.error = meta.error;
        }
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify(out, null, 2) },
          ],
        };
      },
    );

    server.registerTool(
      'enqueue-job',
      {
        title: 'Enqueue a long-running tool call as a background job (v0.3.0; deprecated by enqueue_job in v0.6.0)',
        description:
          '[DEPRECATED in v0.6.0] Prefer `enqueue_job` (snake-case sister, strict superset: returns `result_uri` + `thinking_resolved`, accepts per-call `thinking` mode, ships `wait_command` Bash fast-path when client advertises bash capability). Still maintained for v0.3.0 callers through v0.6.x; planned removal in a future major. ' +
          'DELEGATION GUIDANCE: use this when a regular tool call would exceed your MCP client request timeout (Claude Code: ~60 s). The job is persisted to .memory/jobs/ and runs in the background; you receive a job_id immediately. Then use wait_for_job to long-poll for completion or read_job_result to fetch the persisted result. ' +
          'TYPICAL USE: summarize-long-chunked on documents > 25 K words; any extract/transform on large source_uri inputs. ' +
          'Idempotency: enqueue-job dedupes by hash(tool_name + args) — repeated calls with identical args while a prior job is still queued/running return the existing job_id, not a fresh one.',
        inputSchema: {
          tool_name: z.enum(ASYNC_TOOL_WHITELIST).describe(
            'Which tool to run as a job. Whitelisted to prevent recursion or self-reference.',
          ),
          args: z.record(z.string(), z.unknown()).describe(
            'Args object forwarded verbatim to the wrapped tool. Validated by the wrapped tool at execution time (errors surface in job status, not at enqueue).',
          ),
          ttl_days: z.number().int().min(1).max(30).optional().describe(
            'How many days the result stays in .memory/jobs/ before GC. Default 7. Capped at 30.',
          ),
        },
      },
      async ({ tool_name, args, ttl_days }: {
        tool_name: typeof ASYNC_TOOL_WHITELIST[number];
        args: Record<string, unknown>;
        ttl_days?: number;
      }) => {
        try {
          const meta = await jobRegistry.enqueue(tool_name, args, ttl_days ?? 7);
          jobRunner.schedule(meta);
          const expiresAt = new Date(
            new Date(meta.enqueued_at).getTime() + meta.ttl_days * 86400_000,
          ).toISOString();
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  {
                    job_id: meta.job_id,
                    enqueued_at: meta.enqueued_at,
                    expires_at: expiresAt,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (err) {
          return toolCallError(err);
        }
      },
    );

    // ── enqueue_job ──────────────────────────────────────────────────────
    // New snake-case tool name matches sister tools (wait_for_job /
    // read_job_result). Strict superset of `enqueue-job`:
    //  - Accepts `thinking?: 'on'|'off'|'auto'`
    //  - Computes `thinking_resolved` via resolveThinking(); the runner
    //    injects it into args before invoking the wrapped tool, so the
    //    wrapped tool runs under the caller's intended thinking mode.
    //  - Returns `result_uri` (file:// of the eventual <id>.md result body)
    //    and, when the client advertises bash capability, a `wait_command`
    //    Claude-Code-friendly one-liner.
    //
    // `enqueue-job` stays registered for backward compat (deprecated in
    // description). Forward-compat note: this triad is a temporary compat
    // layer for clients that don't yet support MCP Tasks SEP-2663. When
    // SEP stabilizes + a major client ships native task return, the entire
    // triad sunsets.
    server.registerTool(
      'enqueue_job',
      {
        title: 'Enqueue a long-running tool call as a background job',
        description:
          'DELEGATION GUIDANCE: use this when a regular tool call would exceed your MCP ' +
          'client request timeout (Claude Code: ~60 s). The job runs in the background; ' +
          'you receive a job_id + result_uri immediately. ' +
          'POLLING: use check_progress(job_id) to check status or wait_for_job ' +
          '(v0.3.0 long-poll, deprecated). Fetch the body with read_job_result(job_id). ' +
          'BASH FAST-PATH: when the server returns wait_command (env OMCP_ASSUME_BASH_CLIENT=1 ' +
          'or future MCP capability handshake), Claude Code clients can paste it into Bash ' +
          'to collapse poll+read into one call (10-minute cap, well above any oMLX task). ' +
          'THINKING: pass thinking="on"|"off"|"auto" to override the per-tool default the ' +
          'wrapped tool would otherwise use; the chosen value is persisted in job metadata ' +
          'and threaded back into the tool call. ' +
          'Idempotency: dedupes by hash(tool + args + thinking_resolved) — repeated calls ' +
          'with identical inputs while a prior job is still queued/running return the ' +
          'existing job_id, not a fresh one.',
        inputSchema: {
          tool: z.enum(ASYNC_TOOL_WHITELIST).describe(
            'Which tool to run as a job. Whitelisted to prevent recursion or self-reference.',
          ),
          args: z.record(z.string(), z.unknown()).describe(
            'Args object forwarded verbatim to the wrapped tool. The runner additionally ' +
              'merges `thinking: thinking_resolved` before invocation when applicable.',
          ),
          thinking: ThinkingInputSchema,
          ttl_days: z.number().int().min(1).max(30).optional().describe(
            'How many days the result stays in `~/.local-mcp/jobs/` before GC. Default 7.',
          ),
        },
      },
      async ({
        tool,
        args,
        thinking,
        ttl_days,
      }: {
        tool: typeof ASYNC_TOOL_WHITELIST[number];
        args: Record<string, unknown>;
        thinking?: ThinkingMode;
        ttl_days?: number;
      }) => {
        try {
          const thinking_resolved = resolveThinking(tool, thinking);
          const meta = await jobRegistry.enqueue(
            tool,
            args,
            ttl_days ?? 7,
            thinking_resolved,
          );
          jobRunner.schedule(meta);
          const resultPath = jobRegistry.store.resultPath(meta.job_id);
          const result_uri = `file://${resultPath}`;
          const expiresAt = new Date(
            new Date(meta.enqueued_at).getTime() + meta.ttl_days * 86400_000,
          ).toISOString();
          // Capability detection: env var stub today; future: MCP handshake.
          // POSIX-only one-liner (no [[, no zsh-isms) — portable across
          // /bin/sh, bash, zsh that Claude Code might invoke.
          //
          // Path is wrapped in single quotes with single-quote escaping
          // (bashSingleQuote helper) to defend against spaces, $, `, ", and
          // other shell metacharacters that could appear in a user's
          // OMCP_MEMORY_DIR override. nanoid(10) job_ids are path-safe,
          // but baseDir is user-controlled. Single-quote wrapping disables
          // ALL parameter / command substitution inside the quotes; the
          // closing-quote escape sequence `'\''` lets a literal quote
          // appear without breaking out of the wrap. Adversarial review
          // (gem/copilot/nv_pro) all flagged unquoted interpolation as
          // revert-worthy.
          const bashCapable = process.env['OMCP_ASSUME_BASH_CLIENT'] === '1';
          const wait_command = bashCapable
            ? `while [ ! -f ${bashSingleQuote(resultPath)} ]; do sleep 5; done; cat ${bashSingleQuote(resultPath)}`
            : undefined;
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  {
                    job_id: meta.job_id,
                    enqueued_at: meta.enqueued_at,
                    expires_at: expiresAt,
                    result_uri,
                    thinking_resolved,
                    ...(wait_command !== undefined ? { wait_command } : {}),
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (err) {
          return toolCallError(err);
        }
      },
    );
  }

  return server;
}

export async function runBridgeServerStdio(
  options: BridgeServerOptions = {},
): Promise<void> {
  // Lazy connection: the bridge does NOT ping the oMLX server at startup.
  // If oMLX isn't running yet, tool invocations surface a clear error via
  // MlxHttpBackend's fetch failure path; the bridge process itself stays
  // up so MCP clients can list tools and retry once the user starts oMLX
  // (`brew services start jundot/omlx/omlx`).

  // ── async-job machinery ───────────────────────────────────────────────────
  // Construct store + registry + runner before the server so they can be
  // injected via options. The toolHandlers Map is shared by reference: the
  // server populates it during registerCapturedTool calls, the runner reads
  // from it via the ToolInvoker closure built below.
  const { JobStore } = await import('../jobs/store.js');
  const { JobRegistry } = await import('../jobs/registry.js');
  const { JobRunner } = await import('../jobs/runner.js');

  // Use $HOME as the base — process.cwd() is '/' when Claude Desktop
  // spawns the bridge process with no working directory set.
  const memoryDir =
    process.env['OMCP_MEMORY_DIR'] ??
    `${process.env['HOME'] ?? process.cwd()}/.local-mcp/jobs`;
  const jobStore = new JobStore({ baseDir: memoryDir });
  const jobRegistry = new JobRegistry(jobStore);
  const orphanReport = await jobRegistry.initialize();
  if (orphanReport.orphansFailed > 0) {
    process.stderr.write(
      `bridge: marked ${orphanReport.orphansFailed} orphaned job(s) as failed (bridge restart)\n`,
    );
  }

  const toolHandlers = new Map<string, CapturedToolHandler>();
  // ToolInvoker closes over the toolHandlers Map. By the time enqueue_job (or
  // enqueue-job) schedules a call, the Map is fully populated by buildBridgeServer.
  const jobRunner = new JobRunner(
    jobRegistry,
    async (toolName, args, extra) => {
      const handler = toolHandlers.get(toolName);
      if (!handler) {
        return {
          isError: true,
          content: [
            { type: 'text' as const, text: `Unknown tool in async job: ${toolName}` },
          ],
        };
      }
      return (await handler(args, extra)) as { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
    },
    { concurrency: parseEnvInt('OMCP_JOB_CONCURRENCY') ?? 1 },
  );

  const server = buildBridgeServer({
    ...options,
    jobRegistry,
    jobRunner,
    toolHandlers,
  });

  // F4: warm up Tier-2 ONNX model at startup if enabled, so the first tool
  // call doesn't pay the 1-2 s load cost.
  if (options.defendUntrusted !== false && process.env['OMCP_DEFENDER_TIER2'] === '1') {
    const tempDefense = new BridgeDefense({ enableTier2: true });
    await tempDefense.warmup();
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
