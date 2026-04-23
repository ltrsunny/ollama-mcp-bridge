/**
 * sanitizeSchemaForOllama — strip JSON Schema constraints that crash the
 * llama.cpp GBNF grammar compiler used by Ollama's `format:` feature.
 *
 * Known-crash causes (Run C, eval-adversarial.mjs):
 *   - `pattern` on string fields → GBNF regex compilation error
 *   - `format: "email"` → same
 *   - `format: "uri"` → same
 *
 * Conservatively stripped (untested regime per Unknown #3):
 *   - `format: "date-time"` — assume risky until tested
 *   - `multipleOf` on numbers — untested; strip proactively
 *
 * Hard reject (cannot resolve, out-of-scope for v0.1.1):
 *   - `$ref` anywhere in the schema → returns { ok: false, reason: 'ref-detected' }
 *
 * Callers receive a `stripped` list of JSON Pointer paths to each removed
 * constraint. The extract tool surfaces these via
 * `_meta[dev.ollamamcpbridge/schema_stripped]` so callers can re-validate
 * using their original Zod schema on the bridge's output.
 *
 * Unit tests: tests/unit/sanitize.test.ts
 */

/** Minimal JSON Schema node type used internally. */
type JsonSchemaNode = Record<string, unknown>;

const CRASH_FORMATS = new Set(['email', 'uri']);
const RISKY_FORMATS = new Set(['date-time']);

export type SanitizeResult =
  | { ok: true; schema: JsonSchemaNode; stripped: string[] }
  | { ok: false; reason: 'ref-detected'; path: string };

/**
 * Walk a JSON Schema object and strip constraints known or assumed to crash
 * the Ollama GBNF compiler. Mutates a deep clone; does not modify the input.
 *
 * @param schema  The JSON Schema object (e.g. from z.toJSONSchema()).
 * @returns       SanitizeResult — ok=true with sanitized schema and stripped
 *                paths, or ok=false if a `$ref` was encountered.
 */
export function sanitizeSchemaForOllama(schema: unknown): SanitizeResult {
  const clone = structuredClone(schema) as JsonSchemaNode;
  const stripped: string[] = [];
  const result = walkNode(clone, '#', stripped);
  if (!result.ok) return result;
  return { ok: true, schema: clone, stripped };
}

function walkNode(
  node: unknown,
  path: string,
  stripped: string[],
): { ok: true } | { ok: false; reason: 'ref-detected'; path: string } {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return { ok: true };
  const obj = node as JsonSchemaNode;

  // ── Hard reject: $ref ───────────────────────────────────────────────────
  if ('$ref' in obj) {
    return { ok: false, reason: 'ref-detected', path: `${path}/$ref` };
  }

  // ── Strip: pattern ───────────────────────────────────────────────────────
  if ('pattern' in obj) {
    stripped.push(`${path}/pattern`);
    delete obj['pattern'];
  }

  // ── Strip: format (crash or risky) ───────────────────────────────────────
  if (typeof obj['format'] === 'string') {
    const fmt = obj['format'];
    if (CRASH_FORMATS.has(fmt) || RISKY_FORMATS.has(fmt)) {
      stripped.push(`${path}/format`);
      delete obj['format'];
    }
  }

  // ── Strip: multipleOf ────────────────────────────────────────────────────
  if ('multipleOf' in obj) {
    stripped.push(`${path}/multipleOf`);
    delete obj['multipleOf'];
  }

  // ── Recurse: properties ──────────────────────────────────────────────────
  if (obj['properties'] && typeof obj['properties'] === 'object') {
    for (const [key, val] of Object.entries(obj['properties'] as Record<string, unknown>)) {
      const r = walkNode(val, `${path}/properties/${key}`, stripped);
      if (!r.ok) return r;
    }
  }

  // ── Recurse: items ───────────────────────────────────────────────────────
  if ('items' in obj) {
    const r = walkNode(obj['items'], `${path}/items`, stripped);
    if (!r.ok) return r;
  }

  // ── Recurse: anyOf / oneOf / allOf ───────────────────────────────────────
  for (const keyword of ['anyOf', 'oneOf', 'allOf'] as const) {
    if (Array.isArray(obj[keyword])) {
      for (let i = 0; i < (obj[keyword] as unknown[]).length; i++) {
        const r = walkNode((obj[keyword] as unknown[])[i], `${path}/${keyword}/${i}`, stripped);
        if (!r.ok) return r;
      }
    }
  }

  // ── Recurse: $defs / definitions ─────────────────────────────────────────
  for (const defsKey of ['$defs', 'definitions'] as const) {
    if (obj[defsKey] && typeof obj[defsKey] === 'object') {
      for (const [key, val] of Object.entries(obj[defsKey] as Record<string, unknown>)) {
        const r = walkNode(val, `${path}/${defsKey}/${key}`, stripped);
        if (!r.ok) return r;
      }
    }
  }

  return { ok: true };
}
