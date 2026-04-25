/**
 * Token-aware text chunker — wraps `@langchain/textsplitters`'
 * `RecursiveCharacterTextSplitter` with the backend's own tokenizer
 * (so chunks fit the actual model in use, not OpenAI's cl100k as a proxy
 * baked into the splitter).
 *
 * `RecursiveCharacterTextSplitter` cuts by descending semantic separators
 * (paragraphs → sentences → words → characters) until each chunk is below
 * the size budget. We supply `lengthFunction` = backend.countTokens so the
 * "size" is in real backend tokens.
 *
 * The caller should already have applied any safety margin (e.g. × 0.85 for
 * proxy-tokenizer drift) to `chunkSize` before calling here.
 */

import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';

export interface SplitOptions {
  /** Target tokens per chunk (caller-applied safety margin already included). */
  chunkSize: number;
  /** Token overlap between adjacent chunks. */
  chunkOverlap: number;
  /** Token-counting function — typically `(t) => backend.countTokens(t)`. */
  countTokens: (text: string) => Promise<number>;
}

/**
 * Split `source` into token-bounded chunks.
 *
 * Empty input returns an empty array. A single short input that fits in
 * one chunk returns `[source]` (callers may detect this n==1 case via
 * `result.length` — typically the orchestrator will instead pre-empt via
 * a token-budget check before calling this function).
 */
export async function splitToChunks(
  source: string,
  opts: SplitOptions,
): Promise<string[]> {
  if (source.length === 0) return [];
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: opts.chunkSize,
    chunkOverlap: opts.chunkOverlap,
    lengthFunction: opts.countTokens,
  });
  return splitter.splitText(source);
}
