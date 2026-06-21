/**
 * Regression tests for the 2026-06-17 code-review fixes:
 *   1. safeFetch re-validates the host on EVERY redirect hop (SSRF).
 *   2. readCappedBody streams + cancels at the byte cap (no unbounded buffer / OOM).
 *   3. backendForTool fails cleanly when a forced tier is unconfigured (no TypeError crash).
 *   4. The backend cache key includes thinkingMode (no cross-tier suppression leak).
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  safeFetch,
  readCappedBody,
  type ReadSourceOptions,
} from '../../src/io/sourceReader.js';
import {
  backendForTool,
  _resetMlxHttpCacheForTests,
} from '../../src/mcp/backend-factory.js';
import { DEFAULT_CONFIG, type BridgeConfig } from '../../src/config/tiers.js';

const OPTS: ReadSourceOptions = {
  maxBytes: 1000,
  timeoutMs: 5000,
  denyPrivate: true,
};

function headers(map: Record<string, string>): Headers {
  return { get: (k: string) => map[k.toLowerCase()] ?? null } as unknown as Headers;
}

afterEach(() => vi.unstubAllGlobals());

describe('safeFetch — SSRF redirect re-validation', () => {
  it('rejects a redirect that points at a private/loopback host', async () => {
    // hop 0: public host OK → 302 Location: http://127.0.0.1/internal
    const mockFetch = vi.fn().mockResolvedValueOnce({
      status: 302,
      ok: false,
      headers: headers({ location: 'http://127.0.0.1/internal' }),
    });
    vi.stubGlobal('fetch', mockFetch);
    await expect(safeFetch('http://public.example/img.png', OPTS)).rejects.toThrow(
      /private|loopback|SSRF/i,
    );
    // It must NOT have fetched the internal URL (rejected before the 2nd hop).
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('follows an allowed-host redirect and returns the final response', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({ status: 301, ok: false, headers: headers({ location: 'http://other.example/x' }) })
      .mockResolvedValueOnce({ status: 200, ok: true, headers: headers({}) });
    vi.stubGlobal('fetch', mockFetch);
    const res = await safeFetch('http://public.example/x', OPTS);
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('caps redirect chains', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 302,
      ok: false,
      headers: headers({ location: 'http://public.example/loop' }),
    });
    vi.stubGlobal('fetch', mockFetch);
    await expect(safeFetch('http://public.example/start', OPTS)).rejects.toThrow(/redirect/i);
  });

  it('refuses a non-HTTP(S) redirect (file://, data:, …)', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      status: 302,
      ok: false,
      headers: headers({ location: 'file:///etc/passwd' }),
    });
    vi.stubGlobal('fetch', mockFetch);
    await expect(safeFetch('http://public.example/x', OPTS)).rejects.toThrow(/non-HTTP/i);
    expect(mockFetch).toHaveBeenCalledTimes(1); // never fetched the file:// target
  });
});

describe('readCappedBody — streaming byte cap', () => {
  function streamOf(chunks: Uint8Array[], cl?: string): Response {
    let i = 0;
    const body = {
      getReader: () => ({
        read: async () =>
          i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined },
        cancel: async () => {},
        releaseLock: () => {},
      }),
    };
    return { headers: headers(cl ? { 'content-length': cl } : {}), body } as unknown as Response;
  }

  it('rejects via Content-Length preflight before reading the body', async () => {
    await expect(readCappedBody(streamOf([], '99999'), 1000)).rejects.toThrow(/Content-Length/);
  });

  it('cancels mid-stream when cumulative bytes exceed the cap (no Content-Length)', async () => {
    const chunk = new Uint8Array(600);
    await expect(readCappedBody(streamOf([chunk, chunk, chunk]), 1000)).rejects.toThrow(
      /exceeded size limit/,
    );
  });

  it('returns the buffer when under the cap', async () => {
    const buf = await readCappedBody(streamOf([new Uint8Array(100), new Uint8Array(50)]), 1000);
    expect(buf.byteLength).toBe(150);
  });
});

describe('backendForTool — tier guard + cache key', () => {
  beforeEach(() => _resetMlxHttpCacheForTests());

  it('throws a clean error (not TypeError) when a forced tier is unconfigured', () => {
    const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as BridgeConfig;
    // Simulate a legacy/text-only config lacking tier V.
    delete (cfg.tiers as Record<string, unknown>)['V'];
    expect(() => backendForTool(cfg, 'extract', 'V')).toThrow(/not configured/i);
  });

  it('cache key includes thinkingMode — same (url, model) but different suppression → distinct backends', () => {
    const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as BridgeConfig;
    cfg.tiers.B = { mlxUrl: 'http://127.0.0.1:8000', mlxModelName: 'M', thinkingMode: 'no_think' };
    cfg.tiers.V = { mlxUrl: 'http://127.0.0.1:8000', mlxModelName: 'M', thinkingMode: 'chat_template' };
    const a = backendForTool(cfg, 'x', 'B');
    const b = backendForTool(cfg, 'x', 'V');
    expect(a).not.toBe(b); // would collide to the same instance if thinkingMode were absent from the key
  });
});
