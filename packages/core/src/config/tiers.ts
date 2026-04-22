/**
 * Tier-based model routing.
 *
 * The bridge routes each MCP tool invocation to a model tier. Tiers are
 * size/latency buckets, not capability buckets — the tool decides which
 * tier it wants based on expected workload (short classify vs long summary).
 *
 * The default set of models comes from the audit trail in the project notes:
 * - Tier B (primary) = qwen3:4b-instruct-2507-q4_K_M
 *   Chosen because it is the only commercially-licensed (Apache 2.0),
 *   Chinese-capable, native-tool-calling, non-thinking 3-4B model on
 *   ollama.com as of 2026-04. Bare `qwen3:4b` is a separate hybrid-reasoning
 *   model whose thinking mode cannot be disabled reliably — do NOT substitute.
 * - Tier C (optional) = qwen2.5:7b
 *   Apache 2.0, Chinese explicitly listed on the Ollama library page,
 *   ~4.7 GB weights, fits 16 GB Macs comfortably for long-form summarize.
 *
 * Users who only touch English content can opt into `llama3.2:3b` as Tier B,
 * which Ollama's library page literally recommends for "Summarization,
 * Prompt rewriting, Tool use".
 */

export type Tier = 'B' | 'C';

export interface TierConfig {
  /** Ollama model tag, e.g. "qwen3:4b-instruct-2507-q4_K_M". */
  model: string;
  /**
   * Ollama `keep_alive` parameter. Number = seconds, string = duration,
   * `-1` = forever. The primary tier should use -1 to eliminate cold-start
   * on every call; on-demand tiers use a shorter window (e.g. 300).
   */
  keepAlive?: string | number;
}

export interface BridgeConfig {
  tiers: Record<Tier, TierConfig>;
  /** Fallback tier when a tool has no explicit mapping. */
  defaultTier: Tier;
  /** Per-tool tier assignment. Absent keys fall back to defaultTier. */
  toolTierMap?: Record<string, Tier>;
}

export const DEFAULT_CONFIG: BridgeConfig = {
  tiers: {
    B: {
      model: 'qwen3:4b-instruct-2507-q4_K_M',
      keepAlive: -1,
    },
    C: {
      model: 'qwen2.5:7b',
      keepAlive: 300,
    },
  },
  defaultTier: 'B',
  toolTierMap: {
    summarize: 'B',
    'summarize-long': 'C',
  },
};

export interface ResolveOptions {
  /** Override the model for a specific tier (e.g. via CLI flag). */
  tierOverrides?: Partial<Record<Tier, Partial<TierConfig>>>;
}

/**
 * Apply overrides on top of a base config. Leaves unspecified fields alone.
 */
export function withOverrides(
  base: BridgeConfig,
  opts: ResolveOptions = {},
): BridgeConfig {
  if (!opts.tierOverrides) return base;

  const tiers = { ...base.tiers };
  for (const key of Object.keys(opts.tierOverrides) as Tier[]) {
    const override = opts.tierOverrides[key];
    if (!override) continue;
    tiers[key] = { ...tiers[key], ...override };
  }
  return { ...base, tiers };
}

export function tierForTool(config: BridgeConfig, toolName: string): Tier {
  return config.toolTierMap?.[toolName] ?? config.defaultTier;
}

export function modelForTool(config: BridgeConfig, toolName: string): TierConfig {
  return config.tiers[tierForTool(config, toolName)];
}
