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
  /**
   * Ollama `num_ctx` — context window size in tokens.
   * Ollama's runtime default is 4096 regardless of the model's maximum.
   * Without this field the model silently left-truncates inputs that exceed
   * 4096 tokens. Set explicitly per tier to prevent data loss.
   *
   * Tier B → 8192 (fast 4B model; fits comfortably on 16 GB Mac)
   * Tier C → 16384 (7B model; benchmarked VRAM during implementation)
   */
  numCtx?: number;
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
      // 10 minutes idle: on a 16 GB Mac, -1 (forever) pins ~3.5 GB VRAM even
      // when the bridge is quiet. 10 min trades one cold start per idle hour
      // for headroom; tighten via OMCP_TIER_B_KEEPALIVE if the host is roomy.
      keepAlive: '10m',
      // 8192 tokens: doubles the default 4096 without stressing VRAM on 16 GB
      // Macs (~0.5 GB additional KV-cache for qwen3:4b at Q4_K_M).
      numCtx: 8192,
    },
    C: {
      // 5 minutes idle — Tier C is explicitly on-demand; no reason to hold
      // the larger weights when the long-summarize tool isn't being called.
      model: 'qwen2.5:7b',
      keepAlive: 300,
      // 16384 tokens: supports ~12 000-word documents. On a 16 GB Mac the
      // qwen2.5:7b Q4_K_M model uses ~4.7 GB weights + ~1 GB KV-cache at
      // this context size — total ~5.7 GB, well within budget.
      numCtx: 16384,
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
