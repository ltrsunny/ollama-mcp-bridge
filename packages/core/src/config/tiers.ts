/**
 * Tier-based model routing.
 *
 * The bridge routes each MCP tool invocation to a model tier. Tiers are
 * size/latency buckets, not capability buckets — the tool decides which
 * tier it wants based on expected workload (short classify vs long summary).
 *
 * All tiers route through `MlxHttpBackend` to a local oMLX
 * (https://github.com/jundot/omlx) inference server. Single backend, single
 * inference engine, KV-cache persistence across requests, schema strictness
 * via OpenAI Structured Outputs (`response_format: { type: "json_schema",
 * strict: true }`).
 *
 * Default models (mlx-community on Hugging Face):
 * - Tier B: `Qwen3-4B-Instruct-2507-4bit` (~2.5 GB) — non-thinking variant.
 *   The "Instruct-2507" suffix matters: bare `Qwen3-4B`/`Qwen3-8B` are
 *   thinking models that emit `<think>...</think>` traces by default and
 *   burn the per-tool MAX_OUTPUT_TOKENS cap before producing real output.
 *   Instruct-2507 is the explicitly-non-thinking line.
 * - Tier C: `Qwen3-8B-4bit` (~5 GB) — thinking variant; bridge injects
 *   `/no_think` into user messages to disable reasoning at call time.
 *   Long-form summarize at numCtx=32 768.
 * - Tier D: `Qwen3-14B-4bit` (~8 GB) — also thinking; same `/no_think`
 *   injection. Hardest tasks (classify subtle, transform on dense input).
 *
 * All Apache-2.0. Download into `~/.omlx/models/<dirname>` via:
 *   npm run download-models
 * Start oMLX:
 *   brew services start jundot/omlx/omlx
 */

export type Tier = 'B' | 'C' | 'D';

export interface TierConfig {
  /**
   * Base URL of the oMLX (or any OpenAI-compatible) inference server.
   * Default: `"http://127.0.0.1:8000"` (oMLX's default port).
   */
  mlxUrl?: string;
  /**
   * Model name sent in the OpenAI `model` field — must match a directory name
   * under `~/.omlx/models/`. oMLX serves multiple models from one process and
   * routes requests by this name.
   *
   * Example: `"Qwen3-4B-Instruct-2507-4bit"`
   */
  mlxModelName?: string;
  /**
   * Context window size in tokens.
   *
   * Informational for `MlxHttpBackend` — the server-side model's max context
   * is fixed at load time. Used for the chunker's safety margin and tool
   * `maxInputTokens`.
   *
   * Tier B → 8192   (fast 4B model)
   * Tier C → 32768  (8B model with longer context)
   * Tier D → 16384  (14B model; ~9-10 GB at this context size)
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

/** Default oMLX endpoint (LAN unreachable, localhost only). */
const DEFAULT_MLX_URL = 'http://127.0.0.1:8000';

export const DEFAULT_CONFIG: BridgeConfig = {
  tiers: {
    B: {
      mlxUrl: DEFAULT_MLX_URL,
      // Qwen3-4B-Instruct-2507 (Apache-2.0, non-thinking, native tool-calling).
      // 4-bit MLX ≈ 2.5 GB resident. Fast for short classify / summarize /
      // transform. No `/no_think` needed (already non-thinking variant).
      mlxModelName: 'Qwen3-4B-Instruct-2507-4bit',
      numCtx: 8192,
    },
    C: {
      mlxUrl: DEFAULT_MLX_URL,
      // Qwen3-8B (Apache-2.0). 4-bit MLX ≈ 5 GB resident. Long-form summarize
      // over ~25 000 words at numCtx=32 768. Thinking model — bridge injects
      // `/no_think` automatically at the MlxHttpBackend layer so summary
      // output isn't preceded by a reasoning trace.
      mlxModelName: 'Qwen3-8B-4bit',
      numCtx: 32768,
    },
    D: {
      mlxUrl: DEFAULT_MLX_URL,
      // Qwen3-14B (Apache-2.0). 4-bit MLX ≈ 8 GB resident. For hardest tasks
      // (transform on dense input, classify on subtle distinctions). At
      // numCtx=16384 with 14B + KV: ~9-10 GB total. Cannot run alongside C
      // (8B) on a 16 GB Mac without swapping; users typically configure
      // toolTierMap so only one of C/D is hot per session.
      mlxModelName: 'Qwen3-14B-4bit',
      numCtx: 16384,
    },
  },
  defaultTier: 'B',
  toolTierMap: {
    summarize: 'B',
    'summarize-long': 'C',
    // Same Tier C as summarize-long — chunked variant uses the same model,
    // just adds map-reduce orchestration on top.
    'summarize-long-chunked': 'C',
    // classify / extract / transform default to Tier B (defaultTier).
    // Tier D (`Qwen3-14B-4bit`) is opt-in — 4-bit 14B (~7-8 GB) +
    // 6 GB hot_cache is OOM-prone on 16 GB Mac target hardware. Routable
    // via a user-supplied `toolTierMap` override (24+ GB Mac power-user
    // path) but not mapped here.
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

/**
 * Display/telemetry identifier for a tier. Prefers the explicit model name
 * when set; falls back to the URL. Always returns a non-empty string so
 * footers/_meta never carry undefined.
 */
export function tierModelLabel(tcfg: TierConfig): string {
  if (tcfg.mlxModelName !== undefined && tcfg.mlxModelName.length > 0) {
    return tcfg.mlxModelName;
  }
  if (tcfg.mlxUrl !== undefined && tcfg.mlxUrl.length > 0) {
    return tcfg.mlxUrl;
  }
  return 'unconfigured';
}
