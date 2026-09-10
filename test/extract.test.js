import assert from 'node:assert/strict';
import test from 'node:test';
import { openDb } from '../src/db.js';
import { createLlm } from '../src/llm.js';
import { notesSchema } from '../src/notes.js';
import { runPipeline } from '../src/runner.js';
import { extract } from '../src/steps/extract.js';
import { parse } from '../src/steps/parse.js';
import { findStep, registry } from '../src/steps/registry.js';
import { descriptionFixture, fakeLlm, testCtx } from './helpers.js';

const FIXTURE = descriptionFixture('084');
const GUID = FIXTURE.expected.guid;
const OLDER = '22222222-2222-4222-8222-222222222222';

/** Only extract, so the chain under test is the one step. */
const EXTRACT_ONLY = { before: [], chain: [extract], after: [] };

/** Written by steps after this one; every one must survive an extract. */
const LATER_STEP_COLUMNS = {
  genre: 'blues',
  start_sec: 1234,
  start_confidence: 'high',
  apple_url: 'https://music.apple.test/x',
  ytmusic_url: 'https://music.youtube.test/y',
};

/** Three episode-second segments with a song-sized gap between the first two. */
const SEGMENTS = [
  { start: 62, end: 68.48, text: 'Здравствуйте, в эфире «Стереоплан».' },
  { start: 604.3, end: 611.9, text: 'Это была новая пластинка The Black Keys.' },
  { start: 620.1, end: 628.4, text: 'А теперь Kerala Dust, стиль — мрачный dream pop.' },
];

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

/** The reply the stub gives for the 13-track fixture, two tracks discussed. */
function fullReply(fields = {}) {
  const tracks = [];
  for (let position = 1; position <= 13; position++) tracks.push(entry(position));
  tracks[0] = entry(1, {
    note_spoken: 'Ведущий назвал это примерно 13-м альбомом традиционалистов из Огайо.',
    genre_raw: 'blues rock',
    tags: ['host’s favourite', 'host’s favourite'],
    intro_segment: 0,
  });
  tracks[2] = entry(3, { note_spoken: 'Про Kerala Dust ведущий сказал: мрачный dream pop.' });
  return { tracks, episode_tags: ['theme:знакомство с Kerala Dust', 'autumn records'], ...fields };
}

/** An LLM adapter that records what it was asked and answers from a queue. */
function stubLlm(...replies) {
  const seen = [];
  return {
    cli: 'stub',
    seen,
    call: async (request) => {
      seen.push(request);
      return replies[Math.min(seen.length - 1, replies.length - 1)];
    },
  };
}

function seedEpisode(db, guid, { published_at = '2025-09-01T03:00:00.000Z', status } = {}) {
  db.prepare(
    `INSERT INTO episode (guid, number, title, published_at, description_raw, description_changed,
       status, updated_at)
     VALUES (?, 84, ?, ?, ?, 0, ?, '2026-01-01T00:00:00.000Z')`,
  ).run(guid, FIXTURE.expected.title, published_at, FIXTURE.html, status ?? 'transcribed');
  return db.prepare('SELECT * FROM episode WHERE guid = ?').get(guid);
}

/**
 * The state extract inherits: the 13 rows `parse` wrote from the real
 * description, the transcript `transcribe` stored, and a sentinel in every
 * column a later step owns.
 */
async function seedTracks(db, guid, segments = SEGMENTS) {
  const row = db.prepare('SELECT * FROM episode WHERE guid = ?').get(guid);
  const result = await parse.run(testCtx(db), row);
  assert.equal(result.warned, 0, 'the fixture parses cleanly, so no repair call is involved');

  if (segments !== null) {
    db.prepare('INSERT INTO transcript (episode_guid, segments, model) VALUES (?, ?, ?)').run(
      guid,
      JSON.stringify(segments),
      'large-v3',
    );
  }
  const columns = Object.keys(LATER_STEP_COLUMNS);
  db.prepare(
    `UPDATE track SET ${columns.map((column) => `${column} = ?`).join(', ')}
     WHERE episode_guid = ?`,
  ).run(...columns.map((column) => LATER_STEP_COLUMNS[column]), guid);
  return result.tracks;
}

async function setup(t, { llm = null, segments = SEGMENTS, status } = {}) {
  const db = openDb(':memory:');
  t.after(() => db.close());
  seedEpisode(db, GUID, { status });
  await seedTracks(db, GUID, segments);
  const ctx = testCtx(db, { llm });
  return { ctx, db, episode: db.prepare('SELECT * FROM episode WHERE guid = ?').get(GUID) };
}

function tracks(db, guid) {
  return db.prepare('SELECT * FROM track WHERE episode_guid = ? ORDER BY position').all(guid);
}

function episode(db, guid) {
  return db.prepare('SELECT * FROM episode WHERE guid = ?').get(guid);
}

/** A track row without the four columns extract owns: everything it must not touch. */
function untouched(row) {
  const copy = { ...row };
  for (const column of ['note_spoken', 'genre_raw', 'tags', 'intro_segment']) delete copy[column];
  return copy;
}

test('extract follows transcription and owns the extracted status', () => {
  assert.equal(extract.name, 'extract');
  assert.equal(extract.target, 'extracted');
  const index = registry.chain.indexOf(extract);
  assert.equal(registry.chain[index - 1].name, 'transcribe', 'extract reads the transcript');
  assert.equal(registry.chain[index + 1].name, 'align', 'align consumes extract output');
  assert.equal(findStep('extract'), extract);
});

test('one call per episode fills the four owned columns and the episode tags', async (t) => {
  const llm = stubLlm(fullReply());
  const { ctx, db, episode: before } = await setup(t, { llm });
  const beforeTracks = tracks(db, GUID);

  const result = await extract.run(ctx, before);

  assert.deepEqual(result, { tracks: 13, noted: 2, intros: 1, unanswered: 0 });
  assert.equal(llm.seen.length, 1, 'one call per episode, not one per track');
  const [request] = llm.seen;
  assert.equal(request.step, 'extract');
  assert.equal(request.guid, GUID);
  assert.deepEqual(
    request.schema,
    notesSchema([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]),
    'the reply is pinned to the positions this episode actually has',
  );
  assert.ok(request.prompt.includes('The Black Keys'), 'the tracklist is sent');
  assert.ok(request.prompt.includes(SEGMENTS[0].text), 'and the whole transcript with it');

  const rows = tracks(db, GUID);
  assert.match(rows[0].note_spoken, /традиционалистов из Огайо/);
  assert.equal(rows[0].genre_raw, 'blues rock', 'the genre wording is stored as expressed');
  assert.deepEqual(JSON.parse(rows[0].tags), ['host’s favourite'], 'tags are a JSON array');
  assert.equal(rows[0].intro_segment, 0, 'an index into transcript.segments, not a second');
  assert.equal(rows[1].note_spoken, null, 'a track the host passed over stays null');
  assert.equal(rows[1].tags, '[]', 'never NULL after a successful extract');

  assert.deepEqual(
    rows.map((row) => untouched(row)),
    beforeTracks.map((row) => untouched(row)),
    'every parse-owned column, genre, start_sec and the links are left alone',
  );
  // Spread both sides: a row from node:sqlite has a null prototype, which
  // deepStrictEqual compares as well as the values.
  const after = episode(db, GUID);
  assert.deepEqual({ ...after, tags: null }, { ...before }, 'only tags changed on the episode');
  assert.deepEqual(JSON.parse(after.tags), ['theme:знакомство с Kerala Dust', 'autumn records']);
  assert.equal(ctx.lines.at(-1), `${GUID}: extract 13 tracks, 2 noted, 1 intros, 2 episode tags`);
});

test('re-running overwrites the owned columns and adds no rows', async (t) => {
  const second = fullReply();
  second.tracks[0] = entry(1, { note_spoken: 'Другая формулировка.', genre_raw: 'garage rock' });
  second.episode_tags = [];
  const llm = stubLlm(fullReply(), second);
  const { ctx, db, episode: before } = await setup(t, { llm });

  await extract.run(ctx, before);
  const ids = tracks(db, GUID).map((row) => row.id);
  const result = await extract.run(ctx, before);

  assert.deepEqual(result, { tracks: 13, noted: 2, intros: 0, unanswered: 0 });
  const rows = tracks(db, GUID);
  assert.equal(rows.length, 13, 'a re-run is an update, never a new row');
  assert.deepEqual(
    rows.map((row) => row.id),
    ids,
    'track.id stays stable for the steps that key on it',
  );
  assert.equal(rows[0].note_spoken, 'Другая формулировка.');
  assert.equal(rows[0].genre_raw, 'garage rock');
  assert.equal(rows[0].intro_segment, null, 'the previous index is replaced, not kept');
  assert.equal(episode(db, GUID).tags, '[]');
});

test('a position the reply answered twice leaves the skipped one null', async (t) => {
  const reply = fullReply();
  // 13 entries, but position 5 was answered as a second position 2.
  reply.tracks[4] = entry(2, { note_spoken: 'Второй ответ про вторую позицию.' });
  const { ctx, db, episode: before } = await setup(t, { llm: stubLlm(reply) });

  const result = await extract.run(ctx, before);

  assert.equal(result.unanswered, 1);
  const rows = tracks(db, GUID);
  assert.equal(rows[1].note_spoken, 'Второй ответ про вторую позицию.', 'the last repeat wins');
  assert.equal(rows[4].note_spoken, null, 'the unanswered position is not filled from anywhere');
  assert.equal(rows[4].tags, '[]');
  assert.match(
    ctx.lines.at(-1),
    /extract 13 tracks, 3 noted, 1 intros, 2 episode tags, 1 unanswered/,
  );
});

test('a missing transcript names the step that produces it and calls nothing', async (t) => {
  const llm = stubLlm(fullReply());
  const { ctx, db, episode: before } = await setup(t, { llm, segments: null });

  await assert.rejects(
    () => extract.run(ctx, before),
    /no transcript; run --step transcribe first/,
  );
  assert.equal(llm.seen.length, 0);
  assert.equal(tracks(db, GUID)[0].note_spoken, null);
  assert.equal(episode(db, GUID).tags, null, 'nothing is written when the input is missing');
});

test('no adapter fails this episode before anything is written', async (t) => {
  const { ctx, db, episode: before } = await setup(t);
  assert.equal(ctx.llm, null);

  await assert.rejects(() => extract.run(ctx, before), /no LLM adapter configured/);
  assert.equal(episode(db, GUID).tags, null);
});

test('an empty transcript costs no call and still advances the episode', async (t) => {
  const llm = stubLlm(fullReply());
  const { ctx, db } = await setup(t, { llm, segments: [] });

  const { failures } = await runPipeline(ctx, EXTRACT_ONLY, { episode: GUID });

  assert.equal(failures, 0);
  assert.equal(llm.seen.length, 0, 'there is nothing a note could be grounded in');
  for (const row of tracks(db, GUID)) {
    assert.equal(row.note_spoken, null);
    assert.equal(row.genre_raw, null);
    assert.equal(row.intro_segment, null);
    assert.equal(row.tags, '[]');
  }
  assert.equal(episode(db, GUID).tags, '[]');
  assert.equal(episode(db, GUID).status, 'extracted');
  assert.ok(
    ctx.lines.some((line) => line === `${GUID}: extract 13 tracks, skipped`),
    'the log says the call was skipped, not that nothing was said',
  );
});

test('a reply that never validates fails the episode and keeps the raw output', async (t) => {
  const { ctx, db } = await setup(t);
  const fake = fakeLlm(t, { reply: '{"tracks": "marker-not-an-array", "episode_tags": []}' });
  ctx.llm = createLlm({ cli: 'claude', env: { ...process.env, ...fake.env }, log: ctx.log });

  const { failures } = await runPipeline(ctx, EXTRACT_ONLY, { episode: GUID });

  assert.equal(failures, 1);
  assert.equal(fake.calls().length, 3, 'three attempts before it gives up');
  const row = episode(db, GUID);
  assert.equal(row.status, 'transcribed', 'a failed step leaves the status where it was');
  assert.equal(row.failed_step, 'extract');
  assert.match(row.error, /marker-not-an-array/, 'the raw stdout is retained for debugging');
  assert.equal(row.tags, null, 'nothing is half-written');
  assert.deepEqual(
    tracks(db, GUID).map((track) => track.tags),
    Array.from({ length: 13 }, () => null),
  );
});

test('one episode the model mishandles does not stop the others', async (t) => {
  const db = openDb(':memory:');
  t.after(() => db.close());
  seedEpisode(db, GUID, { published_at: '2025-09-01T03:00:00.000Z' });
  await seedTracks(db, GUID);
  seedEpisode(db, OLDER, { published_at: '2025-06-30T03:00:00.000Z' });
  await seedTracks(db, OLDER);

  const ctx = testCtx(db);
  const invalid = '{"tracks": [], "episode_tags": "marker-not-an-array"}';
  const fake = fakeLlm(t, {
    replies: [JSON.stringify(fullReply()), invalid, invalid, invalid],
  });
  ctx.llm = createLlm({ cli: 'claude', env: { ...process.env, ...fake.env }, log: ctx.log });

  const { selected, failures } = await runPipeline(ctx, EXTRACT_ONLY, {});

  assert.equal(selected, 2);
  assert.equal(failures, 1, 'a bad reply for one episode is that episode’s failure');
  assert.equal(episode(db, GUID).status, 'extracted', 'the newest episode is done');
  assert.equal(episode(db, GUID).error, null);
  const failed = episode(db, OLDER);
  assert.equal(failed.status, 'transcribed');
  assert.equal(failed.failed_step, 'extract');
  assert.equal(failed.tags, null);
});
