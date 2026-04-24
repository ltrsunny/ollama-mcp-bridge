/**
 * sourceReader — reads source text from a file:// or http(s):// URI.
 *
 * Used by the bridge tools when the caller provides source_uri instead of
 * passing the full text as a tool argument. Reading source directly means
 * the raw content never traverses the frontier LLM's context window, which
 * is the only regime where the bridge actually saves frontier tokens.
 *
 * Security:
 *   - file:// reads are unrestricted (bridge runs with the user's own
 *     filesystem access; the host app's trust boundary covers this).
 *   - http(s):// reads enforce a size cap, a timeout, a content-type
 *     allowlist, and an optional SSRF denylist for private IP ranges.
 *
 * Environment variables:
 *   OMCP_URL_MAX_BYTES   — max response body (default 10 485 760 = 10 MB)
 *   OMCP_URL_TIMEOUT_MS  — fetch timeout in ms (default 30 000)
 *   OMCP_URL_DENY_PRIVATE — '0' to disable private-IP block (default on)
 *   OMCP_URL_HOSTS       — comma-separated allowlist of hostnames; if set,
 *                          only requests to matching hosts are allowed
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ReadSourceOptions {
  /** Maximum bytes to read from an http(s) response. Default 10 MB. */
  maxBytes: number;
  /** Fetch timeout in milliseconds. Default 30 000. */
  timeoutMs: number;
  /** Deny requests to private/loopback hosts. Default true. */
  denyPrivate: boolean;
  /** If set, only requests whose hostname matches an entry are allowed. */
  allowedHosts?: string[];
}

export interface SourceReadResult {
  /** Decoded UTF-8 text content. */
  text: string;
  /** Raw byte size of the content (before text decoding). */
  bytes: number;
  /** MIME content-type as reported by the source (or 'text/plain' for files). */
  contentType: string;
}

// ── Env-var helpers ──────────────────────────────────────────────────────────

/** Build ReadSourceOptions from environment variables with documented defaults. */
export function readSourceOptionsFromEnv(): ReadSourceOptions {
  return {
    maxBytes: parseInt(process.env['OMCP_URL_MAX_BYTES'] ?? '10485760', 10),
    timeoutMs: parseInt(process.env['OMCP_URL_TIMEOUT_MS'] ?? '30000', 10),
    denyPrivate: process.env['OMCP_URL_DENY_PRIVATE'] !== '0',
    allowedHosts: process.env['OMCP_URL_HOSTS']
      ?.split(',')
      .map((h) => h.trim())
      .filter(Boolean),
  };
}

// ── Content-type allowlist ────────────────────────────────────────────────────

const ALLOWED_CT_PREFIXES = [
  'text/',
  'application/json',
  'application/xml',
  'application/xhtml+xml',
];

function isAllowedContentType(raw: string): boolean {
  const ct = raw.split(';')[0].trim().toLowerCase();
  return ALLOWED_CT_PREFIXES.some((p) => ct === p || ct.startsWith(p));
}

// ── SSRF: private-IP detection (hostname-level, pre-DNS) ─────────────────────
//
// Note: this protects against naive SSRF. A DNS-rebinding attack (public
// hostname that resolves to a private IP) bypasses this check. For the
// v0.1.2 scope this is considered acceptable; OMCP_URL_HOSTS allowlist
// mode provides stronger mitigation if needed.

const LOCALHOST_NAMES = new Set(['localhost', '::1', '0.0.0.0', '']);

function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (LOCALHOST_NAMES.has(h)) return true;
  // IPv4 loopback / private / link-local ranges
  const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 127) return true;                            // 127.0.0.0/8
    if (a === 10) return true;                             // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true;     // 172.16.0.0/12
    if (a === 192 && b === 168) return true;               // 192.168.0.0/16
    if (a === 169 && b === 254) return true;               // 169.254.0.0/16 link-local
    if (a === 0) return true;                              // 0.0.0.0/8
  }
  return false;
}

// ── Core read function ────────────────────────────────────────────────────────

/**
 * Read text from a URI. Supports file://, http://, https://.
 * Throws a descriptive Error on any failure (scheme unsupported, SSRF blocked,
 * size exceeded, timeout, non-2xx HTTP, disallowed content-type, etc.).
 * The caller should surface the error message to the user as isError: true.
 */
export async function readSource(
  uri: string,
  opts: ReadSourceOptions,
): Promise<SourceReadResult> {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error(`Invalid URI: "${uri}". Expected file://, http://, or https://`);
  }

  // ── file:// ───────────────────────────────────────────────────────────────
  if (parsed.protocol === 'file:') {
    let filePath: string;
    try {
      filePath = fileURLToPath(parsed);
    } catch {
      throw new Error(`Cannot convert file URI to path: "${uri}"`);
    }
    const buf = await readFile(filePath); // throws ENOENT / EACCES naturally
    if (buf.byteLength > opts.maxBytes) {
      throw new Error(
        `File size ${buf.byteLength} bytes exceeds limit ${opts.maxBytes} bytes. ` +
          `Set OMCP_URL_MAX_BYTES to raise the limit.`,
      );
    }
    return { text: buf.toString('utf-8'), bytes: buf.byteLength, contentType: 'text/plain' };
  }

  // ── http(s):// ────────────────────────────────────────────────────────────
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    const { hostname } = parsed;

    // Host policy: allowlist takes priority; falls back to private-IP denylist
    if (opts.allowedHosts && opts.allowedHosts.length > 0) {
      const allowed = opts.allowedHosts.some(
        (h) => hostname === h || hostname.endsWith('.' + h),
      );
      if (!allowed) {
        throw new Error(
          `Host "${hostname}" is not in the OMCP_URL_HOSTS allowlist ` +
            `(${opts.allowedHosts.join(', ')}). Add the host to allow access.`,
        );
      }
    } else if (opts.denyPrivate && isPrivateHost(hostname)) {
      throw new Error(
        `Access to private/loopback host "${hostname}" is blocked (SSRF protection). ` +
          `Set OMCP_URL_DENY_PRIVATE=0 to disable (not recommended), or ` +
          `use OMCP_URL_HOSTS to allowlist specific internal hosts.`,
      );
    }

    // Fetch with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), opts.timeoutMs);
    let res: Response;
    try {
      res = await fetch(parsed.toString(), {
        signal: controller.signal,
        headers: { 'User-Agent': 'ollama-mcp-bridge/0.1.2' },
      });
    } catch (err) {
      const isAbort = (err as Error).name === 'AbortError';
      throw new Error(
        isAbort
          ? `Request timed out after ${opts.timeoutMs}ms: "${uri}"`
          : `Fetch failed: ${(err as Error).message}`,
      );
    } finally {
      clearTimeout(timeoutId);
    }

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}: "${uri}"`);
    }

    // Content-type gate
    const rawCt = res.headers.get('content-type') ?? 'application/octet-stream';
    if (!isAllowedContentType(rawCt)) {
      throw new Error(
        `Content-Type "${rawCt}" is not supported. ` +
          `Allowed: text/*, application/json, application/xml. ` +
          `PDF support is deferred to a future version.`,
      );
    }

    // Preflight size check via Content-Length header
    const clHeader = res.headers.get('content-length');
    if (clHeader) {
      const cl = parseInt(clHeader, 10);
      if (!isNaN(cl) && cl > opts.maxBytes) {
        throw new Error(
          `Content-Length ${cl} bytes exceeds limit ${opts.maxBytes} bytes. ` +
            `Set OMCP_URL_MAX_BYTES to raise the limit.`,
        );
      }
    }

    // Stream body with hard byte cap
    if (!res.body) throw new Error('Response body is null or not readable.');
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          totalBytes += value.byteLength;
          if (totalBytes > opts.maxBytes) {
            await reader.cancel();
            throw new Error(
              `Response body exceeded size limit ${opts.maxBytes} bytes. ` +
                `Set OMCP_URL_MAX_BYTES to raise the limit.`,
            );
          }
          chunks.push(value);
        }
      }
    } finally {
      reader.releaseLock();
    }

    const text = Buffer.concat(chunks).toString('utf-8');
    return { text, bytes: totalBytes, contentType: rawCt };
  }

  // ── Unsupported scheme ────────────────────────────────────────────────────
  throw new Error(
    `Unsupported URI scheme "${parsed.protocol}". ` +
      `Supported schemes: file://, http://, https://`,
  );
}
