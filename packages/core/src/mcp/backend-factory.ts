/**
 * Backend factory — turns a (BridgeConfig, toolName) pair into a concrete
 * `LlmBackend` instance.
 *
 * v0.2.0 always returns `OllamaBackend` because Ollama is the only shipped
 * backend. v0.3.0 will branch on a backend-selector env var (or per-tier
 * config field) to return either `OllamaBackend` or `LlamaCppBackend`.
 *
 * Tool handlers should call this once per invocation and use the returned
 * backend for that single call. Constructing a backend instance is cheap
 * (no network, no resource bind) so we don't memoize.
 */

import type { LlmBackend } from '../llm/backend.js';
import { OllamaBackend } from '../llm/ollama-backend.js';
import type { OllamaClient } from '../ollama/client.js';
import { type BridgeConfig, tierForTool } from '../config/tiers.js';

export function backendForTool(
  client: OllamaClient,
  config: BridgeConfig,
  toolName: string,
): LlmBackend {
  const tier = tierForTool(config, toolName);
  const tcfg = config.tiers[tier];
  return new OllamaBackend(client, {
    modelTag: tcfg.model,
    keepAlive: tcfg.keepAlive,
    // `think` is not currently surfaced in TierConfig — the existing tools
    // all default to think:false (the bridge thesis). When a tier needs to
    // opt in, add a `think` field to TierConfig and pass it through here.
  });
}
