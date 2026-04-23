import { describe, it, expect } from 'vitest';
import { sanitizeSchemaForOllama } from '../../src/mcp/sanitize.js';

describe('sanitizeSchemaForOllama', () => {
  // ── Pass-through cases ────────────────────────────────────────────────────
  it('leaves a clean flat schema untouched', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'number' },
      },
      required: ['name', 'age'],
    };
    const r = sanitizeSchemaForOllama(schema);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stripped).toHaveLength(0);
    expect(r.schema).toMatchObject(schema);
  });

  it('leaves minLength / maxLength / minItems / maxItems untouched', () => {
    const schema = {
      type: 'object',
      properties: {
        code: { type: 'string', minLength: 3, maxLength: 6 },
        tags: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 5 },
      },
    };
    const r = sanitizeSchemaForOllama(schema);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stripped).toHaveLength(0);
    expect((r.schema.properties as Record<string, unknown>)['code']).toHaveProperty('minLength', 3);
  });

  it('leaves enum values untouched', () => {
    const schema = {
      type: 'object',
      properties: {
        sentiment: { enum: ['positive', 'neutral', 'negative'] },
      },
    };
    const r = sanitizeSchemaForOllama(schema);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stripped).toHaveLength(0);
  });

  // ── pattern stripping ─────────────────────────────────────────────────────
  it('strips pattern on a top-level string property', () => {
    const schema = {
      type: 'object',
      properties: {
        phone: { type: 'string', pattern: '^\\d{4}$' },
      },
    };
    const r = sanitizeSchemaForOllama(schema);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stripped).toContain('#/properties/phone/pattern');
    const phone = (r.schema.properties as Record<string, unknown>)['phone'] as Record<string, unknown>;
    expect(phone['pattern']).toBeUndefined();
    expect(phone['type']).toBe('string'); // other props untouched
  });

  it('strips pattern nested inside array items', () => {
    const schema = {
      type: 'array',
      items: { type: 'string', pattern: '^[A-Z]+$' },
    };
    const r = sanitizeSchemaForOllama(schema);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stripped).toContain('#/items/pattern');
  });

  it('strips pattern nested 3 levels deep (object inside array inside object)', () => {
    const schema = {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              code: { type: 'string', pattern: '^\\w+$' },
            },
          },
        },
      },
    };
    const r = sanitizeSchemaForOllama(schema);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stripped).toContain('#/properties/items/items/properties/code/pattern');
  });

  // ── format stripping ──────────────────────────────────────────────────────
  it('strips format: email', () => {
    const schema = { type: 'string', format: 'email' };
    const r = sanitizeSchemaForOllama(schema);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stripped).toContain('#/format');
    expect(r.schema['format']).toBeUndefined();
  });

  it('strips format: uri', () => {
    const schema = { type: 'string', format: 'uri' };
    const r = sanitizeSchemaForOllama(schema);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stripped).toContain('#/format');
  });

  it('strips format: date-time', () => {
    const schema = { type: 'string', format: 'date-time' };
    const r = sanitizeSchemaForOllama(schema);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stripped).toContain('#/format');
  });

  it('does NOT strip an unrecognised format (e.g. "uuid")', () => {
    const schema = { type: 'string', format: 'uuid' };
    const r = sanitizeSchemaForOllama(schema);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stripped).toHaveLength(0);
    expect(r.schema['format']).toBe('uuid');
  });

  // ── multipleOf stripping ──────────────────────────────────────────────────
  it('strips multipleOf', () => {
    const schema = { type: 'number', multipleOf: 0.01 };
    const r = sanitizeSchemaForOllama(schema);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stripped).toContain('#/multipleOf');
    expect(r.schema['multipleOf']).toBeUndefined();
  });

  // ── $ref hard reject ─────────────────────────────────────────────────────
  it('returns ok=false when $ref is present at root', () => {
    const schema = { $ref: '#/$defs/Address' };
    const r = sanitizeSchemaForOllama(schema);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('ref-detected');
  });

  it('returns ok=false when $ref is nested inside properties', () => {
    const schema = {
      type: 'object',
      properties: {
        address: { $ref: '#/$defs/Address' },
      },
    };
    const r = sanitizeSchemaForOllama(schema);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('ref-detected');
    expect(r.path).toContain('$ref');
  });

  // ── anyOf / oneOf / allOf recursion ──────────────────────────────────────
  it('strips pattern inside anyOf branches', () => {
    const schema = {
      anyOf: [
        { type: 'string', pattern: '^\\d+$' },
        { type: 'number' },
      ],
    };
    const r = sanitizeSchemaForOllama(schema);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stripped).toContain('#/anyOf/0/pattern');
  });

  // ── Multiple strips in one schema ─────────────────────────────────────────
  it('reports all stripped paths when multiple constraints are removed', () => {
    const schema = {
      type: 'object',
      properties: {
        email: { type: 'string', format: 'email', pattern: '^.+@.+$' },
        price: { type: 'number', multipleOf: 0.01 },
      },
    };
    const r = sanitizeSchemaForOllama(schema);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stripped).toHaveLength(3);
    expect(r.stripped).toContain('#/properties/email/format');
    expect(r.stripped).toContain('#/properties/email/pattern');
    expect(r.stripped).toContain('#/properties/price/multipleOf');
  });

  // ── Does not mutate the original ────────────────────────────────────────
  it('does not mutate the original schema object', () => {
    const schema = { type: 'string', format: 'email', pattern: '^.+$' };
    sanitizeSchemaForOllama(schema);
    expect(schema['format']).toBe('email');
    expect(schema['pattern']).toBe('^.+$');
  });
});
