import assert from 'node:assert/strict';
import test from 'node:test';
import { validate } from '../src/jsonschema.js';
import { pickRepairs, REPAIR_SCHEMA, repairPrompt } from '../src/repair.js';

/** The entries the parse step sends: only what the deterministic pass flagged. */
const FLAGGED = [
  { position: 2, raw: '2. Некая группа без разметки', parse_warning: 'no_track,no_country' },
  { position: 7, raw: '7. Another Band (UK) «Some Song» LP SOME ALBUM', parse_warning: 'no_label' },
];

/** One reply entry: the six parse-owned fields plus the position they key on. */
function entry(position, fields = {}) {
  return {
    position,
    artist: null,
    track: null,
    album: null,
    label: null,
    country: null,
    format: null,
    ...fields,
  };
}

test('REPAIR_SCHEMA accepts the six parse-owned fields and nothing else', () => {
  const reply = { entries: [entry(2, { artist: 'A', track: 'T', format: 'LP' })] };
  assert.deepEqual(validate(REPAIR_SCHEMA, reply), []);
  assert.deepEqual(validate(REPAIR_SCHEMA, { entries: [] }), [], 'an empty repair is valid');

  const missing = { entries: [{ position: 2, artist: 'A' }] };
  assert.ok(validate(REPAIR_SCHEMA, missing).length > 0, 'every field must be present');

  const extra = { entries: [entry(2, { section: 'В центральной части' })] };
  assert.ok(validate(REPAIR_SCHEMA, extra).length > 0, 'a column parse does not own is rejected');

  assert.ok(validate(REPAIR_SCHEMA, { entries: [entry(2, { format: 'CD' })] }).length > 0);
  assert.deepEqual(validate(REPAIR_SCHEMA, { entries: [entry(2, { format: 'MLP' })] }), []);
  const badPosition = validate(REPAIR_SCHEMA, { entries: [entry('2')] });
  assert.ok(badPosition.length > 0, 'position is an integer');
  assert.ok(validate(REPAIR_SCHEMA, { entries: [entry(2, { artist: 7 })] }).length > 0);
  assert.ok(validate(REPAIR_SCHEMA, {}).length > 0, 'entries is required');
});

test('repairPrompt carries every flagged entry with its position and warning', () => {
  const prompt = repairPrompt(FLAGGED);
  for (const flagged of FLAGGED) {
    assert.ok(prompt.includes(flagged.raw), `the raw line of entry ${flagged.position} is sent`);
    assert.ok(prompt.includes(String(flagged.position)), 'the position keys the merge back');
    assert.ok(prompt.includes(flagged.parse_warning), 'the warning says what to look for');
  }
});

test('repairPrompt explains the notation and forbids inventing anything', () => {
  const prompt = repairPrompt(FLAGGED);
  assert.ok(
    prompt.includes('Artist (Country) — «Track» FORMAT *ALBUM* (Label)'),
    'the host notation is spelled out',
  );
  assert.match(prompt, /null/, 'an absent field is null, not a guess');
  assert.match(prompt, /invent/i, 'the model is told not to make anything up');
  assert.match(prompt, /language|spelling/i, 'Russian entries stay in Russian');
});

test('pickRepairs keeps only the positions that were sent, the last one winning', () => {
  const data = {
    entries: [
      entry(2, { track: 'Первый вариант' }),
      entry(9, { track: 'Никогда не отправлялся' }),
      entry(2, { track: 'Второй вариант' }),
      entry(7, { label: 'Some Label' }),
    ],
  };

  const picked = pickRepairs(data, [2, 7]);
  assert.deepEqual(
    picked.map((row) => row.position).sort((a, b) => a - b),
    [2, 7],
    'a position the reply invented is dropped',
  );
  assert.equal(picked.find((row) => row.position === 2).track, 'Второй вариант');
  assert.equal(picked.find((row) => row.position === 7).label, 'Some Label');
});

test('pickRepairs is empty when the reply has nothing for the sent positions', () => {
  assert.deepEqual(pickRepairs({ entries: [] }, [2]), []);
  assert.deepEqual(pickRepairs({ entries: [entry(4)] }, [2]), []);
  assert.deepEqual(pickRepairs({ entries: [entry(2)] }, []), []);
});
