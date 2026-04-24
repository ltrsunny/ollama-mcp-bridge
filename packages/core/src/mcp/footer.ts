/**
 * Telemetry footer injected as the last content[] item in every tool response.
 *
 * Purpose: the frontier LLM only sees content[], not _meta. Without a footer
 * the model has no way to know whether delegation was fast/slow, cheap/expensive,
 * or whether context was truncated — so it can't course-correct. A terse footer
 * gives the frontier just enough signal to self-improve its delegation strategy.
 *
 * Format (all on one line, ~10–14 tokens):
 *   [bridge: <model> <tier> <latency>ms in=<prompt> out=<completion>]
 *   [bridge: <model> <tier> <latency>ms in=<prompt> out=<completion> saved~=+<N>]
 *
 * Opt-out: set env OMCP_TELEMETRY_FOOTER=0 to suppress (telemetry still in _meta).
 */

export interface FooterOptions {
  model: string;
  tier: string;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  /** Only present when source_uri was used (F2). Omit for text-arg calls. */
  savedTokensEstimate?: number;
}

/**
 * Build the footer string. Returns empty string when OMCP_TELEMETRY_FOOTER=0.
 */
export function buildFooter(opts: FooterOptions): string {
  if (process.env['OMCP_TELEMETRY_FOOTER'] === '0') return '';

  const base =
    `[bridge: ${opts.model} ${opts.tier} ${opts.latencyMs}ms` +
    ` in=${opts.promptTokens} out=${opts.completionTokens}`;

  if (opts.savedTokensEstimate !== undefined && opts.savedTokensEstimate > 0) {
    return base + ` saved~=+${opts.savedTokensEstimate}]`;
  }
  return base + ']';
}
