import assert from 'node:assert/strict';
import test from 'node:test';
import { validate } from '../src/jsonschema.js';
import { notesPrompt, notesSchema, pickNotes } from '../src/notes.js';

/** Two tracks of one section, the second carrying a written description note. */
const TRACKS = [
  {
    position: 1,
    artist: 'The Black Keys',
    country: 'USA',
    track: 'Man on a Mission',
    album: 'NO RAIN, NO FLOWERS',
    label: 'Easy Eye',
    section: null,
    note_desc: null,
  },
  {
    position: 2,
    artist: 'Kerala Dust',
    country: 'UK',
    track: 'Amsterdam',
    album: 'LIGHT, WEST',
    label: 'Denature',
    section: 'В центральной части — знакомство с группой Kerala Dust.',
    note_desc: 'Трио из Лондона; дебютный альбом 2020 года.',
  },
];

/** Episode seconds, with a song-sized gap between the first two. */
const SEGMENTS = [
  { start: 62, end: 68.48, text: 'Здравствуйте, в эфире «Стереоплан».' },
  { start: 604.3, end: 611.9, text: 'Это была новая пластинка The Black Keys.' },
  { start: 620.1, end: 628.4, text: 'А теперь Kerala Dust, стиль — мрачный dream pop.' },
];

/** One reply entry: the four extract-owned fields plus its position. */
function entry(position, fields = {}) {
  return {
    position,
    note_spoken: null,
    genre_raw: null,
    tags: [],
    intro_segment: null,
    ...fields,
  };
}

function reply(tracks, episode_tags = []) {
  return { tracks, episode_tags };
}

test('notesSchema accepts the four extract-owned fields and the episode tags', () => {
  const schema = notesSchema([1, 2]);
  const ok = reply(
    [entry(1, { note_spoken: 'Ведущий похвалил саксофон.', tags: ['debut'] }), entry(2)],
    ['theme:Kerala Dust'],
  );
  assert.deepEqual(validate(schema, ok), []);
  assert.deepEqual(validate(schema, reply([entry(1), entry(2)])), [], 'empty tags are valid');
});

test('notesSchema pins the reply to exactly the tracklist that was sent', () => {
  const schema = notesSchema([1, 2]);
  assert.ok(validate(schema, reply([entry(1)])).length > 0, 'a dropped track is rejected');
  assert.ok(
    validate(schema, reply([entry(1), entry(2), entry(1)])).length > 0,
    'a padded reply is rejected',
  );
  assert.ok(validate(schema, reply([entry(1), entry(3)])).length > 0, 'an invented position');
});

test('notesSchema rejects a column extract does not own and a mistyped field', () => {
  const schema = notesSchema([1, 2]);
  const pair = (fields) => reply([entry(1, fields), entry(2)]);

  assert.ok(validate(schema, pair({ genre: 'blues' })).length > 0, 'genre belongs to genres');
  assert.ok(validate(schema, pair({ start_sec: 604 })).length > 0, 'start_sec belongs to align');
  assert.ok(validate(schema, pair({ intro_segment: '2' })).length > 0, 'an index is not a string');
  assert.ok(validate(schema, pair({ intro_segment: 1.5 })).length > 0, 'an index is a whole one');
  assert.ok(validate(schema, pair({ tags: 'debut' })).length > 0, 'tags are an array');

  const missing = reply([{ position: 1, note_spoken: null, genre_raw: null }, entry(2)]);
  assert.ok(validate(schema, missing).length > 0, 'every field must be present');
  assert.ok(validate(schema, { tracks: [entry(1), entry(2)] }).length > 0, 'episode_tags required');
  assert.ok(validate(schema, { ...reply([entry(1), entry(2)]), notes: [] }).length > 0);
});

test('notesPrompt carries the tracklist as written, sections and notes labelled', () => {
  const prompt = notesPrompt({ title: 'Стереоплан #84', tracks: TRACKS, segments: SEGMENTS });

  assert.ok(prompt.includes('Стереоплан #84'), 'the episode is named');
  assert.ok(prompt.includes('1. The Black Keys (USA) — «Man on a Mission»'));
  assert.ok(
    prompt.includes('*NO RAIN, NO FLOWERS* (Easy Eye)'),
    'album and label go in as written',
  );
  assert.ok(prompt.includes('2. Kerala Dust (UK) — «Amsterdam» *LIGHT, WEST* (Denature)'));
  assert.ok(prompt.includes(`section: ${TRACKS[1].section}`), 'the section header is labelled');
  assert.ok(prompt.includes(`description: ${TRACKS[1].note_desc}`), 'the written note is labelled');
});

test('notesPrompt numbers every segment and prints its whole start second', () => {
  const prompt = notesPrompt({ title: 'ep', tracks: TRACKS, segments: SEGMENTS });

  assert.ok(prompt.includes('[0 @ 62s] Здравствуйте, в эфире «Стереоплан».'));
  assert.ok(prompt.includes('[1 @ 604s] Это была новая пластинка The Black Keys.'));
  assert.ok(prompt.includes('[2 @ 620s] А теперь Kerala Dust, стиль — мрачный dream pop.'));
});

test('notesPrompt states what the transcript is and what may not be invented', () => {
  const prompt = notesPrompt({ title: 'ep', tracks: TRACKS, segments: SEGMENTS });

  assert.match(prompt, /speech only/i, 'the gaps are not missing transcript');
  assert.match(prompt, /jump|gap/i, 'a jump in seconds is explained');
  assert.match(prompt, /song/i, 'what fills a jump is a song');
  assert.match(prompt, /null/, 'a track the host passed over gets null');
  assert.match(prompt, /invent|own knowledge/i, 'nothing may be made up');
  assert.match(prompt, /Russian/i, 'the note stays in the language it was said in');
  assert.match(prompt, /index/i, 'intro_segment is an index');
  assert.match(prompt, /never a second/i, 'and never a timestamp');
  assert.match(prompt, /theme:/, 'the central section theme rides in the episode tags');
});

test('pickNotes answers every sent position once, the last repeat winning', () => {
  const data = reply([
    entry(2, { note_spoken: 'Первый вариант' }),
    entry(9, { note_spoken: 'Никогда не отправлялся' }),
    entry(2, { note_spoken: 'Второй вариант' }),
    entry(1, { genre_raw: 'мрачный dream pop' }),
  ]);

  const { entries, unanswered } = pickNotes(data, [1, 2, 3], 5);

  assert.deepEqual(
    entries.map((row) => row.position),
    [1, 2, 3],
    'the sent order, with an invented position dropped',
  );
  assert.equal(entries[0].genre_raw, 'мрачный dream pop');
  assert.equal(entries[1].note_spoken, 'Второй вариант');
  assert.deepEqual(entries[2], {
    position: 3,
    note_spoken: null,
    genre_raw: null,
    tags: [],
    intro_segment: null,
  });
  assert.equal(unanswered, 1, 'a position with no answer is counted, not guessed at');
});

test('pickNotes turns a blank answer into null and cleans up the tag arrays', () => {
  const data = reply(
    [entry(1, { note_spoken: '   ', genre_raw: '', tags: [' debut ', 'debut', '', 'reissue'] })],
    ['  year review  ', 'year review', ' '],
  );

  const { entries, episodeTags } = pickNotes(data, [1], 3);

  assert.equal(entries[0].note_spoken, null, 'whitespace is not a summary');
  assert.equal(entries[0].genre_raw, null);
  assert.deepEqual(entries[0].tags, ['debut', 'reissue'], 'trimmed, deduplicated, order kept');
  assert.deepEqual(episodeTags, ['year review']);
});

test('pickNotes keeps intro_segment only where it indexes a real segment', () => {
  const at = (value) => pickNotes(reply([entry(1, { intro_segment: value })]), [1], 3);

  assert.equal(at(0).entries[0].intro_segment, 0, 'the first segment is a valid index');
  assert.equal(at(2).entries[0].intro_segment, 2, 'and so is the last');
  assert.equal(at(3).entries[0].intro_segment, null, 'one past the end is not');
  assert.equal(at(-1).entries[0].intro_segment, null);
  assert.equal(at(604).entries[0].intro_segment, null, 'a second answered as an index is dropped');
});

test('pickNotes treats a reply with no usable shape as nothing said', () => {
  const { entries, episodeTags, unanswered } = pickNotes({}, [1], 2);

  assert.deepEqual(entries, [
    { position: 1, note_spoken: null, genre_raw: null, tags: [], intro_segment: null },
  ]);
  assert.deepEqual(episodeTags, []);
  assert.equal(unanswered, 1);
  assert.deepEqual(pickNotes(reply([entry(1, { tags: null })]), [1], 2).entries[0].tags, []);
});
