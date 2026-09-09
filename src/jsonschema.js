/**
 * The slice of JSON Schema the LLM adapter needs, and not one keyword more.
 *
 * A hand-rolled validator instead of a dependency: the runtime tree is an
 * allowlist (test/deps.test.js), and the schemas this project sends to a
 * model are flat records of scalars. Anything outside the supported set
 * throws rather than being silently ignored, so a later step cannot come to
 * rely on a rule that is not enforced.
 */

/** Documentation, not validation: present in schemas, never checked. */
const ANNOTATIONS = ['$schema', 'title', 'description'];

const SUPPORTED = [
  'type',
  'enum',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minItems',
  'maxItems',
];

/**
 * Every way `value` fails `schema`, as `<json-pointer>: <reason>` strings, in
 * document order. An empty array means it is valid. The pointer is what the
 * retry prompt shows the model, so it names the exact field.
 */
export function validate(schema, value) {
  const errors = [];
  check(schema, value, '', errors);
  return errors;
}

/** `integer` is a type of its own here, as it is in the schemas we send. */
function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function matchesType(expected, value) {
  const actual = typeOf(value);
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  return expected === actual;
}

function label(value) {
  return value === null ? 'null' : String(value);
}

function check(schema, value, pointer, errors) {
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED.includes(keyword) && !ANNOTATIONS.includes(keyword)) {
      throw new Error(`unsupported JSON Schema keyword: ${keyword}`);
    }
  }

  if (Object.hasOwn(schema, 'type')) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!allowed.some((expected) => matchesType(expected, value))) {
      errors.push(`${pointer}: expected ${allowed.join(' or ')}, got ${typeOf(value)}`);
      return;
    }
  }

  if (Object.hasOwn(schema, 'enum') && !schema.enum.includes(value)) {
    errors.push(`${pointer}: expected one of ${schema.enum.map(label).join(', ')}`);
    return;
  }

  if (typeOf(value) === 'object') checkObject(schema, value, pointer, errors);
  if (typeOf(value) === 'array') checkArray(schema, value, pointer, errors);
}

function checkObject(schema, value, pointer, errors) {
  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(value, key)) errors.push(`${pointer}/${key}: required property is missing`);
  }

  if (schema.additionalProperties === false) {
    const known = Object.keys(schema.properties ?? {});
    for (const key of Object.keys(value)) {
      if (!known.includes(key)) errors.push(`${pointer}/${key}: unexpected property`);
    }
  }

  for (const [key, subschema] of Object.entries(schema.properties ?? {})) {
    if (Object.hasOwn(value, key)) check(subschema, value[key], `${pointer}/${key}`, errors);
  }
}

function checkArray(schema, value, pointer, errors) {
  if (Object.hasOwn(schema, 'minItems') && value.length < schema.minItems) {
    errors.push(`${pointer}: expected at least ${schema.minItems} items, got ${value.length}`);
  }
  if (Object.hasOwn(schema, 'maxItems') && value.length > schema.maxItems) {
    errors.push(`${pointer}: expected at most ${schema.maxItems} items, got ${value.length}`);
  }
  if (Object.hasOwn(schema, 'items')) {
    for (let index = 0; index < value.length; index++) {
      check(schema.items, value[index], `${pointer}/${index}`, errors);
    }
  }
}
