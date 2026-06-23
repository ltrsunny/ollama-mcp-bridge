/**
 * token-estimate.test.ts — the CJK-aware token proxy shared by
 * MlxHttpBackend.countTokens and the server's oversizeCheck. The old flat
 * `chars/3.5` proxy under-counted CJK ~3×, letting CJK-dense input slip past
 * the size guard into oMLX's prefill memory guard.
 */

import { describe, it, expect } from 'vitest';
import { estimateTokens } from '../../src/llm/token-estimate.js';

describe('estimateTokens (CJK-aware)', () => {
  it('Latin/ASCII stays at ceil(chars/3.5) — unchanged from the old proxy (no chunker churn)', () => {
    const latin = 'hello world this is plain ascii text'; // 36 chars
    expect(estimateTokens(latin)).toBe(11);
    expect(estimateTokens(latin)).toBe(Math.ceil(latin.length / 3.5));
  });

  it('CJK counts ~1 token/char (the old chars/3.5 proxy under-counted ~3×)', () => {
    const cjk = '你好世界这是中文测试'; // 10 CJK chars
    expect(estimateTokens(cjk)).toBe(10);
    expect(estimateTokens(cjk)).toBeGreaterThan(Math.ceil(cjk.length / 3.5));
  });

  it('mixed input: CJK ~1:1, the rest at /3.5', () => {
    // 'key: 密钥' = 7 chars, 2 CJK → ceil(2 + 5/3.5) = ceil(3.43) = 4
    expect(estimateTokens('key: 密钥')).toBe(4);
  });

  it('covers kana / Hangul / full-width forms, not just Han', () => {
    expect(estimateTokens('あいう')).toBe(3); // hiragana
    expect(estimateTokens('한국어')).toBe(3); // Hangul
    expect(estimateTokens('ＡＢＣ')).toBe(3); // full-width Latin
  });

  it('empty string → 0', () => {
    expect(estimateTokens('')).toBe(0);
  });
});
