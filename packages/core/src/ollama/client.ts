import { Ollama, type Message } from 'ollama';

export const DEFAULT_OLLAMA_HOST = 'http://127.0.0.1:11434';

export interface InstalledModel {
  name: string;
  sizeBytes: number;
  modifiedAt: string;
}

export interface ChatOptions {
  model: string;
  system?: string;
  user: string;
  temperature?: number;
  /**
   * Whether to let the model emit a <think>…</think> chain before the answer.
   * Defaults to false — the bridge's whole point is fast, cheap delegation;
   * thinking models burn minutes on trivial tasks. Opt in per-call if needed.
   */
  think?: boolean | 'low' | 'medium' | 'high';
  /**
   * Ollama keep_alive parameter (seconds, duration string, or -1 for
   * forever). Controls how long the model stays loaded after the call.
   */
  keepAlive?: string | number;
  /**
   * JSON schema passed to Ollama `format:` field for grammar-constrained
   * structured output. Used by classify (enum schema) and extract (full
   * object schema). Callers must pre-sanitize with sanitizeSchemaForOllama()
   * to avoid GBNF crashes on pattern/format:email/format:uri constraints.
   */
  format?: object;
  /**
   * Maximum number of tokens the model may generate. Passed as
   * `options.num_predict` to Ollama. Default: unlimited.
   */
  numPredict?: number;
  signal?: AbortSignal;
}

/**
 * Result returned by OllamaClient.chat(). Includes the text content plus
 * token usage counters from Ollama (0 when the daemon doesn't report them).
 */
export interface ChatResult {
  text: string;
  /** Tokens used to encode the prompt (Ollama: prompt_eval_count). */
  promptTokens: number;
  /** Tokens generated in the completion (Ollama: eval_count). */
  completionTokens: number;
}

export class OllamaDaemonError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'OllamaDaemonError';
  }
}

export class OllamaClient {
  readonly host: string;
  private readonly ollama: Ollama;

  constructor(host: string = DEFAULT_OLLAMA_HOST) {
    this.host = host;
    this.ollama = new Ollama({ host });
  }

  async ping(): Promise<{ version: string }> {
    try {
      const res = await fetch(new URL('/api/version', this.host), {
        headers: { accept: 'application/json' },
      });
      if (!res.ok) {
        throw new OllamaDaemonError(
          `Daemon at ${this.host} returned ${res.status}`,
        );
      }
      return (await res.json()) as { version: string };
    } catch (err) {
      if (err instanceof OllamaDaemonError) throw err;
      throw new OllamaDaemonError(
        `Cannot reach Ollama daemon at ${this.host}. Is it running? (${(err as Error).message})`,
        err,
      );
    }
  }

  async listInstalled(): Promise<InstalledModel[]> {
    const { models } = await this.ollama.list();
    return models.map((m) => ({
      name: m.name,
      sizeBytes: m.size,
      modifiedAt: m.modified_at instanceof Date
        ? m.modified_at.toISOString()
        : String(m.modified_at),
    }));
  }

  async chat(opts: ChatOptions): Promise<ChatResult> {
    const messages: Message[] = [];
    if (opts.system) messages.push({ role: 'system', content: opts.system });
    messages.push({ role: 'user', content: opts.user });

    const ollamaOptions: Record<string, unknown> = {};
    if (opts.temperature !== undefined) ollamaOptions['temperature'] = opts.temperature;
    if (opts.numPredict !== undefined) ollamaOptions['num_predict'] = opts.numPredict;

    const res = await this.ollama.chat({
      model: opts.model,
      messages,
      stream: false,
      think: opts.think ?? false,
      keep_alive: opts.keepAlive,
      format: opts.format,
      options: Object.keys(ollamaOptions).length > 0 ? ollamaOptions : undefined,
    });

    return {
      text: res.message.content,
      promptTokens: res.prompt_eval_count ?? 0,
      completionTokens: res.eval_count ?? 0,
    };
  }
}
