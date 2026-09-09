import assert from 'node:assert/strict';
import test from 'node:test';
import { validate } from '../src/jsonschema.js';

/**
 * The repair schema in miniature: every keyword the adapter is allowed to use
 * appears here, and nothing else does. `validate` throws on any other keyword
 * so a later step cannot quietly rely on a rule this validator ignores.
 */
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['entries'],
  properties: {
    entries: {
      type: 'array',
      minItems: 1,
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['position', 'artist', 'format'],
        properties: {
          position: { type: 'integer' },
          artist: { type: ['string', 'null'] },
          format: { enum: ['LP', 'MLP', 'SP', 'EP', null] },
        },
      },
    },
  },
};

/** One document holding a single entry with the given overrides. */
function doc(overrides) {
  return { entries: [{ position: 1, artist: 'The Black Keys', format: 'LP', ...overrides }] };
}

test('a document that satisfies the schema has no errors', () => {
  assert.deepEqual(validate(SCHEMA, doc({})), []);
  assert.deepEqual(validate(SCHEMA, doc({ artist: null, format: null })), []);
  assert.deepEqual(validate(SCHEMA, { entries: [doc({}).entries[0], doc({}).entries[0]] }), []);
});

test('an error names the offending value by JSON pointer', () => {
  const errors = validate(SCHEMA, doc({ position: '1' }));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^\/entries\/0\/position: /);
  assert.match(errors[0], /integer/);
});

test('integer is stricter than number and null is a type of its own', () => {
  assert.equal(validate(SCHEMA, doc({ position: 1.5 })).length, 1);
  assert.equal(validate(SCHEMA, doc({ position: null })).length, 1);
  assert.deepEqual(validate({ type: 'number' }, 1.5), []);
  assert.deepEqual(validate({ type: 'null' }, null), []);
  assert.equal(validate({ type: 'null' }, 0).length, 1);
  assert.equal(validate({ type: 'integer' }, '3').length, 1);
});

test('an enum error lists the values it would have accepted', () => {
  assert.deepEqual(validate(SCHEMA, doc({ format: 'CD' })), [
    '/entries/0/format: expected one of LP, MLP, SP, EP, null',
  ]);
});

test('a missing required property and an unexpected one are both reported', () => {
  const missing = validate(SCHEMA, { entries: [{ position: 1, format: 'LP' }] });
  assert.equal(missing.length, 1);
  assert.match(missing[0], /artist/);

  const extra = validate(SCHEMA, doc({ bogus: 'x' }));
  assert.equal(extra.length, 1);
  assert.match(extra[0], /bogus/);

  assert.equal(validate(SCHEMA, {}).length, 1, 'entries itself is required');
});

test('array bounds and item schemas are both enforced', () => {
  const empty = validate(SCHEMA, { entries: [] });
  assert.equal(empty.length, 1);
  assert.match(empty[0], /^\/entries: /);

  const tooMany = validate(SCHEMA, { entries: [1, 2, 3, 4].map(() => doc({}).entries[0]) });
  assert.equal(tooMany.length, 1);
  assert.match(tooMany[0], /^\/entries: /);

  assert.equal(validate(SCHEMA, { entries: 'not-an-array' }).length, 1);
  const second = validate(SCHEMA, { entries: [doc({}).entries[0], { position: 2 }] });
  assert.ok(second.every((message) => message.startsWith('/entries/1')));
});

test('every failing property is reported, not just the first', () => {
  const errors = validate(SCHEMA, doc({ position: '1', format: 'CD' }));
  assert.equal(errors.length, 2);
  assert.ok(errors.some((message) => message.startsWith('/entries/0/position: ')));
  assert.ok(errors.some((message) => message.startsWith('/entries/0/format: ')));
});

test('a value of the wrong shape at the root is one error, never a throw', () => {
  assert.equal(validate(SCHEMA, []).length, 1);
  assert.equal(validate(SCHEMA, null).length, 1);
  assert.equal(validate(SCHEMA, 'entries').length, 1);
});

test('annotation keywords are ignored and unsupported ones throw', () => {
  const annotated = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Repair',
    description: 'ignored',
    type: 'string',
  };
  assert.deepEqual(validate(annotated, 'x'), []);

  for (const schema of [
    { type: 'string', pattern: '^a' },
    { type: 'number', minimum: 1 },
    { type: 'object', patternProperties: {} },
    { anyOf: [{ type: 'string' }] },
  ]) {
    assert.throws(
      () => validate(schema, 'x'),
      `expected a throw for ${JSON.stringify(Object.keys(schema))}`,
    );
  }
});
