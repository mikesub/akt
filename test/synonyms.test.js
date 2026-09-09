import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fold } from '../docs/lib/translit.js';
import { UsageError } from '../src/errors.js';
import { DEFAULT_SYNONYMS_PATH, loadSynonyms, parseSynonyms } from '../src/synonyms.js';
import { tempDir } from './helpers.js';

/** Both list styles, a comment and a blank line: the whole supported subset. */
const SOURCE = `# artist aliases: every name below is the same artist
The Beatles: [Beatles, Битлз]

Depeche Mode:
  - Депеш Мод
  - DM
`;

/** The group a name resolves to, as folded names, sorted. */
function group(map, name) {
  const found = map.get(fold(name));
  assert.ok(found, `no group for ${name}`);
  return [...found].map(fold).sort();
}

test('both list styles parse, comments and blank lines are ignored', () => {
  const map = parseSynonyms(SOURCE);

  const beatles = group(map, 'The Beatles');
  assert.equal(new Set(beatles).size, 3, 'the canonical name and both aliases');
  assert.ok(beatles.includes(fold('Битлз')));
  assert.ok(
    group(map, 'DM').includes(fold('Depeche Mode')),
    'the indented style is the same thing',
  );
});

test('a russian and a latin name of one group resolve to the same set', () => {
  const map = parseSynonyms(SOURCE);
  assert.deepEqual(group(map, 'Beatles'), group(map, 'Битлз'));
  assert.deepEqual(group(map, 'Депеш Мод'), group(map, 'Depeche Mode'));
});

test('a lookup goes through the same fold the aligner uses', () => {
  const map = parseSynonyms(SOURCE);
  assert.deepEqual(group(map, '  БИТЛЗ!  '), group(map, 'Битлз'), 'case and punctuation are noise');
});

test('a line that is neither a group nor an alias names its number', () => {
  assert.throws(
    () => parseSynonyms('The Beatles: [Beatles]\nnot a group line\n'),
    (err) => {
      assert.match(err.message, /line 2/);
      return true;
    },
  );
});

test('an empty document is an empty map', () => {
  assert.equal(parseSynonyms('# nothing but a comment\n\n').size, 0);
});

test('a missing file is an empty map, not an error', (t) => {
  const map = loadSynonyms(join(tempDir(t), 'absent.yaml'));
  assert.equal(map.size, 0, 'aliases are optional: the aligner still runs without them');
});

test('a malformed file is a usage error naming the file', (t) => {
  const path = join(tempDir(t), 'synonyms.yaml');
  writeFileSync(path, 'The Beatles: [Beatles]\nnonsense without a colon\n');

  assert.throws(() => loadSynonyms(path), UsageError);
  assert.throws(() => loadSynonyms(path), new RegExp(path));
});

test('the checked-in synonyms.yaml parses and every name reaches its whole group', () => {
  const map = loadSynonyms(DEFAULT_SYNONYMS_PATH);
  assert.ok(map.size > 0, 'the seed file is part of the repo and documents the format');

  for (const [key, names] of map) {
    const members = [...names].map(fold).sort();
    assert.ok(members.includes(key), `${key} is missing from its own group`);
    for (const name of names) {
      assert.deepEqual(group(map, name), members, `${name} resolves to a different group`);
    }
  }
});

test('the checked-in file pairs at least one cyrillic name with a latin one', () => {
  const map = loadSynonyms(DEFAULT_SYNONYMS_PATH);
  const mixed = [...map.values()].find(
    (names) =>
      [...names].some((name) => /[а-яё]/i.test(name)) &&
      [...names].some((name) => /[a-z]/i.test(name)),
  );
  assert.ok(mixed, 'AGENTS.md: a RU and an EN query have to return the same set');
});
