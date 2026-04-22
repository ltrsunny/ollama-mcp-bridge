import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { OllamaClient, OllamaDaemonError } from '../ollama/client.js';

export interface BridgeServerOptions {
  model: string;
  ollamaHost?: string;
  name?: string;
  version?: string;
}

const SUMMARIZE_SYSTEM = `You are a precise summarizer. Produce a single-paragraph summary in plain prose. \
Do not editorialize. Do not add information not in the source. Match the language of the source text. \
If a style hint is provided, honor it (e.g. "one sentence", "for a non-technical reader", "bullet points").`;

export function buildBridgeServer(
  client: OllamaClient,
  options: BridgeServerOptions,
): McpServer {
  const server = new McpServer({
    name: options.name ?? 'ollama-mcp-bridge',
    version: options.version ?? '0.1.0',
  });

  server.registerTool(
    'summarize',
    {
      title: 'Summarize text via local Ollama',
      description:
        'Delegate a summarization task to a local Ollama model. Use this when the caller wants ' +
        'a plain-prose summary of a chunk of text and does not need frontier-model quality. ' +
        'Saves tokens and keeps data on the local machine.',
      inputSchema: {
        text: z.string().min(1).describe('The text to summarize.'),
        style: z
          .string()
          .optional()
          .describe(
            'Optional style hint, e.g. "one sentence", "three bullet points", "for a non-technical reader".',
          ),
      },
    },
    async ({ text, style }) => {
      const user = style
        ? `Style: ${style}\n\nSource:\n${text}`
        : `Source:\n${text}`;
      try {
        const output = await client.chat({
          model: options.model,
          system: SUMMARIZE_SYSTEM,
          user,
          temperature: 0.2,
        });
        return {
          content: [{ type: 'text', text: output.trim() }],
        };
      } catch (err) {
        const msg =
          err instanceof OllamaDaemonError
            ? err.message
            : `Ollama chat failed: ${(err as Error).message}`;
        return {
          isError: true,
          content: [{ type: 'text', text: msg }],
        };
      }
    },
  );

  return server;
}

export async function runBridgeServerStdio(
  options: BridgeServerOptions,
): Promise<void> {
  const client = new OllamaClient(options.ollamaHost);
  await client.ping();

  const server = buildBridgeServer(client, options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
