import assert from 'node:assert/strict';
import test from 'node:test';
import { openDb } from '../src/db.js';
import { runPipeline } from '../src/runner.js';
import { parse } from '../src/steps/parse.js';
import { findStep, registry } from '../src/steps/registry.js';
import { descriptionFixture, testCtx } from './helpers.js';

const FIXTURE = descriptionFixture('084');

/** Only the chain, so the test never needs a feed or a fetch stub. */
const CHAIN_ONLY = { before: [], chain: registry.chain, after: [] };

const LATER_STEP_COLUMNS = {
  note_spoken: 'сказал в эфире',
  genre_raw: 'blues rock',
  tags: 'a,b',
  intro_segment: 1,
  genre: 'blues',
  start_sec: 1234,
  start_confidence: 'high',
  apple_url: 'https://music.apple.test/x',
  ytmusic_url: 'https://music.youtube.test/y',
};

function seed(db, { guid, description, status = 'new' }) {
  db.prepare(
    `INSERT INTO episode (guid, number, title, published_at, description_raw, description_changed,
       status, updated_at)
     VALUES (?, 84, 'ep', '2025-09-01T03:00:00.000Z', ?, 0, ?, '2026-01-01T00:00:00.000Z')`,
  ).run(guid, description, status);
  return db.prepare('SELECT * FROM episode WHERE guid = ?').get(guid);
}

function setup(t, { guid = FIXTURE.expected.guid, description = FIXTURE.html, status } = {}) {
  const db = openDb(':memory:');
  t.after(() => db.close());
  const episode = seed(db, { guid, description, status });
  return { ctx: testCtx(db, {}), db, episode, guid };
}

/** A column expected to hold the same value on every row. */
function repeat(value, count) {
  return Array.from({ length: count }, () => value);
}

function tracks(db, guid) {
  return db.prepare('SELECT * FROM track WHERE episode_guid = ? ORDER BY position').all(guid);
}

test('parse is the first chain step and owns the parsed status', () => {
  assert.equal(parse.name, 'parse');
  assert.equal(parse.target, 'parsed');
  assert.equal(registry.chain[0], parse, 'parse runs before any audio work');
  assert.equal(findStep('parse'), parse);
});

test('parse writes one row per entry of a real description and logs one line', async (t) => {
  const { ctx, db, episode, guid } = setup(t);

  const result = await parse.run(ctx, episode);
  assert.deepEqual(result, { tracks: 13, warned: 0 });
  assert.deepEqual(ctx.lines, [`${guid}: parse 13 tracks, 0 warned`]);

  const rows = tracks(db, guid);
  assert.equal(rows.length, 13);
  assert.deepEqual(
    rows.map((row) => row.position),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
  );
  assert.deepEqual(
    rows.map((row) => row.parse_warning),
    repeat(null, 13),
  );

  const first = rows[0];
  assert.equal(first.artist, 'The Black Keys');
  assert.equal(first.country, 'USA');
  assert.equal(first.track, 'Man on a Mission');
  assert.equal(first.format, 'LP');
  assert.equal(first.album, 'NO RAIN, NO FLOWERS');
  assert.equal(first.label, 'Easy Eye');
  assert.equal(first.section, null);
  assert.equal(first.is_cherished, 0);
  assert.equal(first.note_desc, 'Примерно 13-й альбом традиционалистов из Огайо.');

  // Entry 6 inherits album and label from entry 5 through `LP *Ibid*`.
  assert.equal(rows[5].album, 'AN ECHO OF LOVE');
  assert.equal(rows[5].label, 'PIAS');
  // Entry 5 has no commentary of its own and shares entry 6's.
  assert.equal(rows[4].note_desc, rows[5].note_desc);
  // The central-part header applies from entry 3 on.
  assert.equal(rows[1].section, null);
  assert.match(rows[2].section, /^В центральной части/);
  assert.equal(rows[12].section, rows[2].section);
  // «заветная мелодия» in the commentary of entry 12.
  assert.deepEqual(
    rows.map((row) => row.is_cherished),
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0],
  );

  // parse owns no episode column; the runner advances the status.
  assert.deepEqual(db.prepare('SELECT * FROM episode WHERE guid = ?').get(guid), episode);
});

test('parse stores the warning of an entry it could not read, and counts it', async (t) => {
  const { ctx, db, episode, guid } = setup(t, {
    description:
      '<p>1. A (UK) — «T» LP *X* (L)</p><p>2. Некая группа без разметки</p><p>3. C (UK) — «T» LP *X* (L)</p>',
  });

  const result = await parse.run(ctx, episode);
  assert.deepEqual(result, { tracks: 3, warned: 1 });
  assert.deepEqual(ctx.lines, [`${guid}: parse 3 tracks, 1 warned`]);

  const rows = tracks(db, guid);
  assert.equal(rows.length, 3, 'an unreadable entry is still a row');
  assert.equal(rows[1].artist, 'Некая группа без разметки');
  assert.match(rows[1].parse_warning, /no_track/);
  assert.equal(rows[0].parse_warning, null);
});

test('a re-parse is an upsert: ids are stable and later-step columns survive', async (t) => {
  const { ctx, db, episode, guid } = setup(t);
  await parse.run(ctx, episode);

  const assignments = Object.keys(LATER_STEP_COLUMNS)
    .map((column) => `${column} = ?`)
    .join(', ');
  db.prepare(`UPDATE track SET ${assignments} WHERE episode_guid = ?`).run(
    ...Object.values(LATER_STEP_COLUMNS),
    guid,
  );
  const before = tracks(db, guid);

  const { failures } = await runPipeline(ctx, registry, { episode: guid, step: 'parse' });
  assert.equal(failures, 0);

  const after = tracks(db, guid);
  assert.deepEqual(
    after.map((row) => row.id),
    before.map((row) => row.id),
    'track.id must survive a re-parse',
  );
  assert.deepEqual(after, before, 'no column changes when the description has not changed');
  for (const [column, value] of Object.entries(LATER_STEP_COLUMNS)) {
    assert.deepEqual(
      after.map((row) => row[column]),
      repeat(value, after.length),
      `${column} is owned by a later step and must be untouched`,
    );
  }
  assert.equal(db.prepare('SELECT status FROM episode WHERE guid = ?').get(guid).status, 'parsed');
});

test('a re-parse rewrites owned columns and deletes only the positions that vanished', async (t) => {
  const { ctx, db, guid } = setup(t, {
    description:
      '<p>1. A (UK) — «T1» LP *X* (L)</p><p>2. B (UK) — «T2» LP *Y* (M)</p><p>3. C (UK) — «T3» LP *Z* (N)</p>',
  });
  await parse.run(ctx, db.prepare('SELECT * FROM episode WHERE guid = ?').get(guid));
  db.prepare('UPDATE track SET start_sec = position * 100 WHERE episode_guid = ?').run(guid);
  const before = tracks(db, guid);
  assert.equal(before.length, 3);

  db.prepare('UPDATE episode SET description_raw = ? WHERE guid = ?').run(
    '<p>1. A (UK) — «T1» LP *X* (L)</p><p>2. B2 (USA) — «T2b» LP *Y2* (M2)</p>',
    guid,
  );
  const result = await parse.run(ctx, db.prepare('SELECT * FROM episode WHERE guid = ?').get(guid));
  assert.deepEqual(result, { tracks: 2, warned: 0 });

  const after = tracks(db, guid);
  assert.deepEqual(
    after.map((row) => row.position),
    [1, 2],
    'only the trailing row is deleted',
  );
  assert.deepEqual(
    after.map((row) => row.id),
    before.slice(0, 2).map((row) => row.id),
  );
  assert.deepEqual(
    after.map((row) => [row.artist, row.country, row.track, row.album, row.label]),
    [
      ['A', 'UK', 'T1', 'X', 'L'],
      ['B2', 'USA', 'T2b', 'Y2', 'M2'],
    ],
  );
  assert.deepEqual(
    after.map((row) => row.start_sec),
    [100, 200],
    'the align column is untouched even where parse rewrote the row',
  );
});

test('an episode with no tracklist parses to zero rows and still advances', async (t) => {
  const { ctx, db, guid } = setup(t, { description: null });

  const { failures } = await runPipeline(ctx, CHAIN_ONLY, { episode: guid });
  assert.equal(failures, 0);
  assert.deepEqual(ctx.lines, [`${guid}: parse 0 tracks, 0 warned`]);
  assert.equal(tracks(db, guid).length, 0);

  const row = db.prepare('SELECT * FROM episode WHERE guid = ?').get(guid);
  assert.equal(row.status, 'parsed');
  assert.equal(row.error, null);
  assert.equal(row.failed_step, null);
});

test('a description that loses its tracklist drops every row', async (t) => {
  const { ctx, db, guid } = setup(t);
  await parse.run(ctx, db.prepare('SELECT * FROM episode WHERE guid = ?').get(guid));
  assert.equal(tracks(db, guid).length, 13);

  db.prepare('UPDATE episode SET description_raw = ? WHERE guid = ?').run(
    '<p>Разговор без треклиста</p>',
    guid,
  );
  const result = await parse.run(ctx, db.prepare('SELECT * FROM episode WHERE guid = ?').get(guid));
  assert.deepEqual(result, { tracks: 0, warned: 0 });
  assert.equal(tracks(db, guid).length, 0);
});

test('the whole chain parses an episode that is still at new', async (t) => {
  const { ctx, db, guid } = setup(t);

  const { selected, failures } = await runPipeline(ctx, CHAIN_ONLY, {});
  assert.equal(selected, 1);
  assert.equal(failures, 0);
  assert.equal(db.prepare('SELECT status FROM episode WHERE guid = ?').get(guid).status, 'parsed');
  assert.equal(tracks(db, guid).length, 13);
});
