/**
 * Prompts used by the map-reduce chunked summarizer.
 *
 * MAP phase: each chunk gets its own per-chunk summary.
 * REDUCE phase: chunk summaries (or bucketed reduce outputs) are combined.
 * FAST_PATH: when the entire source fits in a single LLM call, no chunking.
 *
 * See docs/scope-memos/v0.2.0-backend-abstraction-and-chunked-summarize.md §5.4.
 */

export const MAP_SYSTEM = `You are summarizing a fragment of a longer document. Produce a concise summary of just this fragment — NOT the whole document. Preserve concrete facts, specific numbers, named entities, and any explicit claims. Do not speculate beyond the fragment. Output 3-5 short sentences in the same language as the source.`;

export const REDUCE_SYSTEM = `You are combining ordered fragment summaries from one document into a single coherent summary of the whole document. Requirements:
1. Do NOT mirror the fragment-list structure — collapse related points into themes.
2. Deduplicate — if multiple fragments make the same point, say it once.
3. Preserve specific facts, numbers, and named entities from the fragments.
4. Output: 1-2 sentence lead, then 3-6 themed bullets.
5. Reply in the same language as the source.`;

/**
 * Fast-path system prompt — used when the entire source fits in a single
 * LLM call (no chunking). Mirrors `summarize-long`'s prompt shape so the
 * fast-path output is comparable to the existing tool's output.
 */
export const FAST_PATH_SYSTEM = `You are summarizing a document. Produce a 1-2 sentence lead followed by 3-6 themed bullets that cover the document's main points. Preserve specific facts, numbers, and named entities. Do not exceed 6 bullets. Reply in the same language as the source.`;

/**
 * MAP user prompt template — labels the fragment with its index and total
 * so the model knows it's seeing a partial document.
 */
export function mapUserPrompt(chunk: string, index: number, total: number): string {
  return `Fragment ${index} of ${total}:

<fragment>
${chunk}
</fragment>

Summary of this fragment:`;
}

/**
 * REDUCE user prompt template — `joinedSummaries` is the chunk summaries
 * concatenated with [Chunk N] markers. `style` is an optional override
 * appended to the default 1-2-sentence-lead + bullets format.
 */
export function reduceUserPrompt(joinedSummaries: string, style?: string): string {
  const styleLine = style ? `Style override: ${style}\n\n` : '';
  return `${styleLine}Document fragment summaries:

${joinedSummaries}

Final coherent summary:`;
}

/**
 * Fast-path user prompt — same structure as MAP_USER but without fragment
 * labels (the model is seeing the whole document).
 */
export function fastPathUserPrompt(source: string, style?: string): string {
  const styleLine = style ? `Style override: ${style}\n\n` : '';
  return `${styleLine}Source:
${source}`;
}
