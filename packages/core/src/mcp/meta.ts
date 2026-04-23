/**
 * _meta emission for ollama-mcp-bridge tool responses.
 *
 * Keys are namespaced under the reverse-DNS prefix `dev.ollamamcpbridge/*`,
 * matching the MCP SDK's own convention (`io.modelcontextprotocol/related-task`
 * in types.d.ts L6/L40). This avoids collision with future MCP spec additions
 * or other MCP servers mounted side-by-side.
 *
 * Always-emitted keys (every tool call):
 *   dev.ollamamcpbridge/model            — resolved Ollama model tag
 *   dev.ollamamcpbridge/tier             — tier key: "B" | "C"
 *   dev.ollamamcpbridge/latency_ms       — end-to-end wall-clock ms
 *   dev.ollamamcpbridge/prompt_tokens    — from Ollama prompt_eval_count
 *   dev.ollamamcpbridge/completion_tokens — from Ollama eval_count
 *
 * Conditional keys (set only when the relevant feature ran):
 *   dev.ollamamcpbridge/defender/tier    — "1" | "1+2" | "off"
 *   dev.ollamamcpbridge/defender/score   — Tier-2 float score (if ran)
 *   dev.ollamamcpbridge/defender/risk    — Tier-1 risk level (if flagged)
 *   dev.ollamamcpbridge/schema_validation — "passed" | "failed" (F2 only)
 *   dev.ollamamcpbridge/schema_stripped  — string[] of stripped constraints
 */

import type { ChatResult } from '../ollama/client.js';
import type { Tier } from '../config/tiers.js';

export const META_NS = 'dev.ollamamcpbridge' as const;

/** Input for buildMeta(). Always-required fields + optional conditional ones. */
export interface MetaInput {
  /** Resolved Ollama model tag (e.g. "qwen3:4b-instruct-2507-q4_K_M"). */
  model: string;
  /** Tier key used for routing ("B" | "C"). */
  tier: Tier;
  /** End-to-end wall-clock latency in milliseconds. */
  latencyMs: number;
  /** Token counts from the Ollama response. */
  result: Pick<ChatResult, 'promptTokens' | 'completionTokens'>;

  // ── F4 defender (optional) ──────────────────────────────────────────────
  defender?: {
    /** Which tiers of @stackone/defender ran. */
    tier: '1' | '1+2' | 'off';
    /** Tier-2 MiniLM float confidence score (0-1), if Tier-2 ran. */
    score?: number;
    /** Tier-1 risk level string if an injection was detected. */
    risk?: string;
  };

  // ── F2 schema sanitizer (optional) ──────────────────────────────────────
  /** Whether the sanitized-schema output passed a full Zod safeParse. */
  schemaValidation?: 'passed' | 'failed';
  /** List of JSON schema constraint keys that were stripped before forwarding. */
  schemaStripped?: string[];
}

/**
 * Build the `_meta` record for a tool response.
 * Returns a plain object with string keys; caller spreads it into the MCP
 * response as `{ content: [...], _meta: buildMeta(input) }`.
 */
export function buildMeta(input: MetaInput): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    [`${META_NS}/model`]: input.model,
    [`${META_NS}/tier`]: input.tier,
    [`${META_NS}/latency_ms`]: input.latencyMs,
    [`${META_NS}/prompt_tokens`]: input.result.promptTokens,
    [`${META_NS}/completion_tokens`]: input.result.completionTokens,
  };

  if (input.defender) {
    meta[`${META_NS}/defender/tier`] = input.defender.tier;
    if (input.defender.score !== undefined) {
      meta[`${META_NS}/defender/score`] = input.defender.score;
    }
    if (input.defender.risk !== undefined) {
      meta[`${META_NS}/defender/risk`] = input.defender.risk;
    }
  }

  if (input.schemaValidation !== undefined) {
    meta[`${META_NS}/schema_validation`] = input.schemaValidation;
  }
  if (input.schemaStripped && input.schemaStripped.length > 0) {
    meta[`${META_NS}/schema_stripped`] = input.schemaStripped;
  }

  return meta;
}
