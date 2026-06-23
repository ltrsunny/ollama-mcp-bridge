/**
 * CJK-aware token estimate.
 *
 * Latin / code tokenize at roughly `chars / 3.5`; CJK codepoints tokenize closer
 * to 1:1, which a flat `chars / 3.5` proxy badly UNDER-counts. That under-count let
 * CJK-dense input slip past the proactive size guard into oMLX's prefill memory
 * guard (sister bug report: a ~2700-line CJK file). Counting CJK glyphs ~1:1 and the
 * rest at `/3.5` closes that gap, and is shared by `MlxHttpBackend.countTokens`
 * (so the chunker splits CJK correctly too) and the server's `oversizeCheck`.
 *
 * Still an estimate (the real Qwen tokenizer is not exposed over HTTP); the chunker's
 * 0.85 safety margin absorbs the residual drift. Non-BMP codepoints (CJK ext-B+, emoji)
 * skew `rest` slightly via the UTF-16 length, which is acceptable under that margin.
 */
function isCjk(c: number): boolean {
  return (
    (c >= 0x3000 && c <= 0x9fff) || // CJK symbols/punctuation, kana, CJK unified ideographs
    (c >= 0xac00 && c <= 0xd7af) || // Hangul syllables
    (c >= 0xf900 && c <= 0xfaff) || // CJK compatibility ideographs
    (c >= 0xff00 && c <= 0xffef)    // full-width / half-width forms
  );
}

export function estimateTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) {
    if (isCjk(ch.codePointAt(0) ?? 0)) cjk++;
  }
  const rest = text.length - cjk;
  return Math.ceil(cjk + rest / 3.5);
}
