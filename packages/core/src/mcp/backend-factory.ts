/**
 * Backend factory — turns a (BridgeConfig, toolName) pair into a concrete
 * `LlmBackend` instance.
 *
 * Single backend (`MlxHttpBackend`). All tiers route through a local oMLX
 * server. See `docs/scope-memos/v0.5.0-tier-d-eval-2026-05-06.md` and
 * `docs/notes/v0.5.0-omlx-overlap-2026-05-07.md` for integration rationale.
 *
 * `MlxHttpBackend` instances are memoized per `(mlxUrl, mlxModelName)` so
 * Tier B / C / D pointing at the same oMLX endpoint share the same backend
 * instance. Construction is cheap (no connection held); the cache exists for
 * API parity and to coalesce model-name auto-detection roundtrips.
 *
 * Tool handlers should call this once per invocation; the returned backend
 * is safe to use for that single call (and for the lifetime of the process).
 */

import type { LlmBackend } from '../llm/backend.js';
import { MlxHttpBackend } from '../llm/mlx-http-backend.js';
import { type BridgeConfig, tierForTool } from '../config/tiers.js';

/**
 * Process-wide cache of MlxHttpBackend instances, keyed by
 * `${mlxUrl}::${mlxModelName ?? 'auto'}`. Different tiers pointing at the
 * same (URL, model) pair share an instance.
 */
const mlxHttpCache = new Map<string, MlxHttpBackend>();

export function backendForTool(
  config: BridgeConfig,
  toolName: string,
): LlmBackend {
  // Test injection: when a wildcard backend is installed, return it for any
  // tier. Lets snapshot/integration tests capture all chat() calls without
  // running oMLX.
  const testBackend = _getTestBackend();
  if (testBackend !== undefined) return testBackend;

  const tier = tierForTool(config, toolName);
  const tcfg = config.tiers[tier];

  if (tcfg.mlxUrl === undefined) {
    throw new Error(
      `Tier ${tier} has no mlxUrl configured (toolName: ${toolName}). ` +
        `Set tiers.${tier}.mlxUrl to your oMLX endpoint, e.g. ` +
        `"http://127.0.0.1:8000". Start oMLX with: ` +
        `\`brew services start jundot/omlx/omlx\`.`,
    );
  }

  const cacheKey = `${tcfg.mlxUrl}::${tcfg.mlxModelName ?? 'auto'}`;
  let cached = mlxHttpCache.get(cacheKey);
  if (cached === undefined) {
    cached = new MlxHttpBackend({
      baseUrl: tcfg.mlxUrl,
      numCtx: tcfg.numCtx,
      modelName: tcfg.mlxModelName,
    });
    mlxHttpCache.set(cacheKey, cached);
  }
  return cached;
}

/**
 * Test-only: clear the MlxHttp cache so a unit test can re-seed it.
 * Production code never calls this.
 */
export function _resetMlxHttpCacheForTests(): void {
  mlxHttpCache.clear();
}

/**
 * Test-only: install a test-double LlmBackend so every tier resolves to it
 * regardless of (mlxUrl, mlxModelName). Use with RecorderBackend in
 * migration-snapshot tests to capture all chat() calls without spinning up
 * a real oMLX server. Production code never calls this.
 *
 * Implementation: registers the backend under all currently-cached keys AND
 * monkey-patches a wildcard sentinel key so future cache lookups also return
 * it. Reset via `_resetMlxHttpCacheForTests` between tests.
 */
const WILDCARD_KEY = '__test_wildcard__';
export function _installTestBackend(backend: LlmBackend): void {
  mlxHttpCache.set(WILDCARD_KEY, backend as MlxHttpBackend);
}

/** Internal: read the wildcard test backend, if installed. */
function _getTestBackend(): LlmBackend | undefined {
  return mlxHttpCache.get(WILDCARD_KEY);
}
