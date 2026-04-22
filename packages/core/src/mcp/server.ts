import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { OllamaClient, OllamaDaemonError } from '../ollama/client.js';
import {
  type BridgeConfig,
  DEFAULT_CONFIG,
  modelForTool,
} from '../config/tiers.js';

export interface BridgeServerOptions {
  ollamaHost?: string;
  config?: BridgeConfig;
  name?: string;
  version?: string;
}

const SUMMARIZE_SYSTEM = `You are a precise summarizer. Produce a single-paragraph summary in plain prose. \
Do not editorialize. Do not add information not in the source. Match the language of the source text. \
If a style hint is provided, honor it (e.g. "one sentence", "for a non-technical reader", "bullet points").`;

const SUMMARIZE_LONG_SYSTEM = `You are a careful summarizer of long documents. Produce a structured \
summary: first 1-2 sentences giving the core claim, then 3-6 short bullet points covering the supporting \
detail. Preserve the source language. Do not invent facts. If the source is very long, prioritize the \
opening, any explicit conclusion, and named entities / numbers.`;

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

export function buildBridgeServer(
  client: OllamaClient,
  options: BridgeServerOptions = {},
): McpServer {
  const config = options.config ?? DEFAULT_CONFIG;
  const server = new McpServer({
    name: options.name ?? 'ollama-mcp-bridge',
    version: options.version ?? '0.1.0',
  });

  // --- summarize (Tier B by default) -------------------------------------
  server.registerTool(
    'summarize',
    {
      title: 'Summarize text via local Ollama',
      description:
        'Delegate a short-to-medium summarization task to a local model. ' +
        'Use this for chunks of text up to a few thousand words where the ' +
        'caller wants plain prose. Saves frontier tokens, keeps data local.',
      inputSchema: {
        text: z.string().min(1).describe('The text to summarize.'),
        style: z
          .string()
          .optional()
          .describe(
            'Optional style hint, e.g. "one sentence", "three bullet points", ' +
              '"for a non-technical reader".',
          ),
      },
    },
    async ({ text, style }) => {
      const tier = modelForTool(config, 'summarize');
      const user = style ? `Style: ${style}\n\nSource:\n${text}` : `Source:\n${text}`;
      try {
        const output = await client.chat({
          model: tier.model,
          keepAlive: tier.keepAlive,
          system: SUMMARIZE_SYSTEM,
          user,
          temperature: 0.2,
        });
        return { content: [{ type: 'text', text: output.trim() }] };
      } catch (err) {
        return toolCallError(err);
      }
    },
  );

  // --- summarize-long (Tier C by default) --------------------------------
  server.registerTool(
    'summarize-long',
    {
      title: 'Summarize long documents via local Ollama (larger model)',
      description:
        'Delegate a long-document summarization task. Uses a larger local ' +
        'model (Tier C) for better coverage of structure, named entities, ' +
        'and numbers. Higher latency than summarize. Prefer summarize for ' +
        'anything under ~2000 words.',
      inputSchema: {
        text: z
          .string()
          .min(1)
          .describe('The document to summarize. Can be several thousand words.'),
        style: z
          .string()
          .optional()
          .describe(
            'Optional style hint. Default is 1-2 sentence lead plus 3-6 bullets.',
          ),
      },
    },
    async ({ text, style }) => {
      const tier = modelForTool(config, 'summarize-long');
      const user = style
        ? `Style override: ${style}\n\nSource:\n${text}`
        : `Source:\n${text}`;
      try {
        const output = await client.chat({
          model: tier.model,
          keepAlive: tier.keepAlive,
          system: SUMMARIZE_LONG_SYSTEM,
          user,
          temperature: 0.2,
        });
        return { content: [{ type: 'text', text: output.trim() }] };
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
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
