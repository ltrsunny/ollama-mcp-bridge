/**
 * Unit tests for imageReader's pure classification helpers.
 *
 * Deterministic + dependency-free: no oMLX, no `sips`, no filesystem, no
 * network — just magic-byte buffers. The fetch/downscale/end-to-end path is
 * exercised manually against a live engine (see scope memo §6.5).
 */

import { describe, it, expect } from 'vitest';
import { sniffImageMime, resolveImageMime } from '../../src/io/imageReader.js';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const WEBP = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);
const PDF = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]); // %PDF-1
const GARBAGE = Uint8Array.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);

describe('imageReader.sniffImageMime', () => {
  it('detects PNG by magic bytes', () => {
    expect(sniffImageMime(PNG)).toBe('image/png');
  });
  it('detects JPEG by magic bytes', () => {
    expect(sniffImageMime(JPEG)).toBe('image/jpeg');
  });
  it('detects WebP (RIFF....WEBP)', () => {
    expect(sniffImageMime(WEBP)).toBe('image/webp');
  });
  it('returns null for PDF (not an image)', () => {
    expect(sniffImageMime(PDF)).toBeNull();
  });
  it('returns null for unknown bytes', () => {
    expect(sniffImageMime(GARBAGE)).toBeNull();
  });
  it('returns null for too-short buffers', () => {
    expect(sniffImageMime(Uint8Array.from([0x89, 0x50]))).toBeNull();
  });
});

describe('imageReader.resolveImageMime', () => {
  it('returns the MIME for supported images', () => {
    expect(resolveImageMime(PNG)).toBe('image/png');
    expect(resolveImageMime(JPEG)).toBe('image/jpeg');
    expect(resolveImageMime(WEBP)).toBe('image/webp');
  });
  it('rejects PDF with a deferred-support message', () => {
    expect(() => resolveImageMime(PDF)).toThrow(/PDF.*not supported|deferred/i);
  });
  it('rejects unknown formats with a clear message', () => {
    expect(() => resolveImageMime(GARBAGE)).toThrow(/Unsupported image format/i);
  });
});
