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
  /**
   * Only present for `summarize-long-chunked` (v0.2.0+). Number of chunks
   * the source was split into in the MAP phase. 1 means the fast-path was
   * taken (no chunking).
   */
  chunks?: number;
  /** Only set true when `summarize-long-chunked` returned a partial result. */
  partial?: boolean;
}

/**
 * Build the footer string. Returns empty string when OMCP_TELEMETRY_FOOTER=0.
 *
 * Format examples:
 *   [bridge: qwen3:4b B 1240ms in=230 out=85]
 *   [bridge: qwen2.5:7b C 11240ms in=519 out=136 saved~=+220]
 *   [bridge: qwen2.5:7b C 187340ms in=12500 out=1200 chunks=24]
 *   [bridge: qwen2.5:7b C 187340ms in=12500 out=1200 chunks=24 partial]
 */
export function buildFooter(opts: FooterOptions): string {
  if (process.env['OMCP_TELEMETRY_FOOTER'] === '0') return '';

  let s =
    `[bridge: ${opts.model} ${opts.tier} ${opts.latencyMs}ms` +
    ` in=${opts.promptTokens} out=${opts.completionTokens}`;

  if (opts.chunks !== undefined) {
    s += ` chunks=${opts.chunks}`;
  }
  if (opts.savedTokensEstimate !== undefined && opts.savedTokensEstimate > 0) {
    s += ` saved~=+${opts.savedTokensEstimate}`;
  }
  if (opts.partial) {
    s += ` partial`;
  }
  return s + ']';
}
