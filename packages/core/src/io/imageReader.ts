/**
 * imageReader — resolves an image `source_uri` (file:// or http(s)://) into a
 * bounded base64 data URI for the VLM tier (tier V, Qwen3-VL).
 *
 * The whole point of the bridge: raw image bytes go LOCAL (bridge → oMLX over
 * HTTP) and NEVER traverse the frontier. This resolver does the fetch + cap +
 * downscale so the MCP tool handlers only ever hand a bounded data URI to the
 * vision backend. See docs/scope-memos/v0.8.0-multimodal-2026-06-16.md §4.
 *
 * Security:
 *   - file:// reads are UNRESTRICTED — same trust model as the text
 *     `sourceReader` (the bridge runs with the user's own FS access; the host
 *     app's trust boundary covers this). This intentionally deviates from the
 *     scope memo's F4 "confine file:// to workspace": confining only images
 *     while text stays unrestricted would be inconsistent, and the original
 *     "host trust boundary covers this" rationale applies equally to images.
 *   - http(s):// reuses sourceReader's SSRF host policy (`assertHostAllowed`)
 *     + timeout + byte cap.
 *   - MIME allowlist: png / jpeg / webp. PDF is rejected with a "deferred"
 *     message (multimodal v0.8.0 is image-only; PDF gets its own memo).
 *
 * Downscaling: macOS `sips -Z <maxEdge>` (zero new dependency — the bridge is
 * Apple-Silicon-only). Bounds prefill tokens + base64 size, keeps calls under
 * the 60 s MCP wall and the oMLX prefill memory guard (which rejects an image
 * needing > ~2.3 GB peak — see §0.6). `sips -Z` only shrinks (never upscales),
 * so it is a no-op on already-small images. If `sips` is unavailable or fails,
 * the original bytes are used (logged) rather than failing the call.
 *
 * Environment variables:
 *   OMCP_IMAGE_MAX_EDGE — downscale target for the longest edge (default 1568)
 *   (input byte cap + timeout reuse OMCP_URL_MAX_BYTES / OMCP_URL_TIMEOUT_MS)
 */

import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { type ReadSourceOptions, safeFetch, readCappedBody } from './sourceReader.js';

const execFileP = promisify(execFile);

/** Default longest-edge downscale target (px). Matches frontier vision norms. */
const DEFAULT_MAX_EDGE = 1568;

export interface ImageSourceResult {
  /** `data:image/<type>;base64,<…>` ready to drop into a chat `image_url`. */
  dataUri: string;
  /** Resolved MIME type: image/png, image/jpeg, or image/webp. */
  mimeType: string;
  /** Final byte size after any downscale. */
  bytes: number;
  /** Byte size before downscale (== bytes when no downscale happened). */
  originalBytes: number;
  /** True when `sips` actually shrank the image. */
  downscaled: boolean;
}

/** Resolve the longest-edge target from env, with the documented default. */
export function imageMaxEdgeFromEnv(): number {
  const raw = parseInt(process.env['OMCP_IMAGE_MAX_EDGE'] ?? String(DEFAULT_MAX_EDGE), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_EDGE;
}

/** Magic-byte MIME sniff for the supported image types. Returns null if none match. */
export function sniffImageMime(buf: Uint8Array): string | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'image/png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  // RIFF....WEBP
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

/** %PDF- magic — rejected with a "deferred" message. */
function isPdf(buf: Uint8Array): boolean {
  return (
    buf.length >= 5 &&
    buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46 && buf[4] === 0x2d
  );
}

const EXT_FOR_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/**
 * Classify raw bytes as a supported image, or throw a descriptive error.
 * `headerCt` (the http content-type, when available) is advisory only — the
 * magic-byte sniff is authoritative.
 */
export function resolveImageMime(buf: Uint8Array): string {
  if (isPdf(buf)) {
    throw new Error(
      'PDF is not supported in multimodal v0.8.0 (image-only). PDF support — ' +
        'render-to-image per page — is deferred to a later version.',
    );
  }
  const mime = sniffImageMime(buf);
  if (mime === null) {
    throw new Error(
      'Unsupported image format. Supported: PNG, JPEG, WebP. ' +
        '(The bytes did not match any known image magic number.)',
    );
  }
  return mime;
}

/**
 * Downscale `input` so its longest edge ≤ `maxEdge`, via macOS `sips -Z`.
 * Returns the (possibly shrunk) bytes. On any sips failure (not macOS, sips
 * missing, malformed image) returns the original bytes and logs to stderr —
 * the call still proceeds; an oMLX memory-guard rejection downstream is the
 * backstop for a too-large image.
 */
async function downscaleWithSips(
  input: Buffer,
  ext: string,
  maxEdge: number,
): Promise<{ bytes: Buffer; downscaled: boolean }> {
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), 'omcp-img-'));
    const inPath = join(dir, `in.${ext}`);
    await writeFile(inPath, input);

    // 1) Query dimensions WITHOUT re-encoding (`sips -g` is read-only). Critical:
    //    sips re-encodes on resize, and re-encoding an already-small, efficiently
    //    -compressed PNG can BLOAT it several-fold (observed 17 KB → 141 KB) and
    //    slightly degrade it. So only resize when a dimension actually exceeds the
    //    cap; otherwise pass the original bytes through untouched.
    const { stdout } = await execFileP(
      'sips',
      ['-g', 'pixelWidth', '-g', 'pixelHeight', inPath],
      { timeout: 10_000 },
    );
    const w = Number(/pixelWidth:\s*(\d+)/.exec(stdout)?.[1] ?? 0);
    const h = Number(/pixelHeight:\s*(\d+)/.exec(stdout)?.[1] ?? 0);
    const longest = Math.max(w, h);
    if (longest === 0 || longest <= maxEdge) {
      return { bytes: input, downscaled: false };
    }

    // 2) Resize: -Z (resampleHeightWidthMax) shrinks the longest edge to maxEdge,
    //    preserving aspect, never upscaling. --out writes a copy (input untouched).
    const outPath = join(dir, `out.${ext}`);
    await execFileP('sips', ['-Z', String(maxEdge), inPath, '--out', outPath], {
      timeout: 20_000,
    });
    const out = await readFile(outPath);
    return { bytes: out, downscaled: true };
  } catch (err) {
    process.stderr.write(
      `[bridge] imageReader: sips downscale skipped (${(err as Error).message}); ` +
        `sending original bytes.\n`,
    );
    return { bytes: input, downscaled: false };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Fetch + cap + downscale an image source_uri into a base64 data URI.
 * Throws a descriptive Error on any failure (bad scheme, SSRF blocked, size
 * exceeded, unsupported format, PDF); the caller surfaces it as isError: true.
 */
export async function readImageSource(
  uri: string,
  opts: ReadSourceOptions,
  maxEdge: number = imageMaxEdgeFromEnv(),
): Promise<ImageSourceResult> {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error(`Invalid URI: "${uri}". Expected file://, http://, or https://`);
  }

  let raw: Buffer;

  if (parsed.protocol === 'file:') {
    let filePath: string;
    try {
      filePath = fileURLToPath(parsed);
    } catch {
      throw new Error(`Cannot convert file URI to path: "${uri}"`);
    }
    raw = await readFile(filePath); // throws ENOENT / EACCES naturally
    if (raw.byteLength > opts.maxBytes) {
      throw new Error(
        `Image size ${raw.byteLength} bytes exceeds limit ${opts.maxBytes} bytes. ` +
          `Set OMCP_URL_MAX_BYTES to raise the limit.`,
      );
    }
  } else if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    // Host policy + per-hop-revalidated redirects + timeout (SSRF-safe), then a
    // STREAMING byte cap — never buffer the whole body before the size check
    // (an arrayBuffer() with no/lying Content-Length could exhaust memory).
    const res = await safeFetch(parsed.toString(), opts, {
      headers: { 'User-Agent': 'local-mcp-toolbelt/0.8.0' },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}: "${uri}"`);
    }
    raw = await readCappedBody(res, opts.maxBytes);
  } else {
    throw new Error(
      `Unsupported URI scheme "${parsed.protocol}". Supported: file://, http://, https://`,
    );
  }

  const mimeType = resolveImageMime(raw); // throws on PDF / unsupported
  const ext = EXT_FOR_MIME[mimeType] ?? 'png';
  const originalBytes = raw.byteLength;

  const { bytes, downscaled } = await downscaleWithSips(raw, ext, maxEdge);
  // Re-sniff after downscale: sips preserves format, but be defensive.
  const finalMime = sniffImageMime(bytes) ?? mimeType;
  const dataUri = `data:${finalMime};base64,${bytes.toString('base64')}`;

  return { dataUri, mimeType: finalMime, bytes: bytes.byteLength, originalBytes, downscaled };
}
