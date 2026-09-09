import assert from 'node:assert/strict';
import test from 'node:test';
import { openDb } from '../src/db.js';
import { createLlm } from '../src/llm.js';
import { REPAIR_SCHEMA } from '../src/repair.js';
import { runPipeline } from '../src/runner.js';
import { parse } from '../src/steps/parse.js';
import { findStep, registry } from '../src/steps/registry.js';
import { descriptionFixture, fakeLlm, testCtx } from './helpers.js';

const FIXTURE = descriptionFixture('084');

/** Only parse, so parse-focused runner tests never need audio or a fetch stub. */
const PARSE_ONLY = { before: [], chain: [parse], after: [] };

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

function setup(t, { guid = FIXTURE.expected.guid, description = FIXTURE.html, status, llm } = {}) {
  const db = openDb(':memory:');
  t.after(() => db.close());
  const episode = seed(db, { guid, description, status });
  return { ctx: testCtx(db, { llm }), db, episode, guid };
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
  assert.deepEqual(result, { tracks: 13, warned: 0, sent: 0, repaired: 0 });
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
  assert.deepEqual(result, { tracks: 3, warned: 1, sent: 0, repaired: 0 });
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
  assert.deepEqual(result, { tracks: 2, warned: 0, sent: 0, repaired: 0 });

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

  const { failures } = await runPipeline(ctx, PARSE_ONLY, { episode: guid });
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
  assert.deepEqual(result, { tracks: 0, warned: 0, sent: 0, repaired: 0 });
  assert.equal(tracks(db, guid).length, 0);
});

test('the whole chain parses an episode that is still at new', async (t) => {
  const { ctx, db, guid } = setup(t);

  const { selected, failures } = await runPipeline(ctx, PARSE_ONLY, {});
  assert.equal(selected, 1);
  assert.equal(failures, 0);
  assert.equal(db.prepare('SELECT status FROM episode WHERE guid = ?').get(guid).status, 'parsed');
  assert.equal(tracks(db, guid).length, 13);
});

/*
 * The LLM fallback. It runs inside the parse step, after the deterministic
 * upsert has committed, and only ever sees the entries the parser flagged.
 */

/** Two entries the parser reads cleanly around one it cannot read at all. */
const MIXED =
  '<p>1. Clean Alpha (UK) — «Alpha Song» LP *ALPHA ALBUM* (Alpha Label)</p>' +
  '<p>2. Некая группа без разметки</p>' +
  '<p>3. Clean Gamma (UK) — «Gamma Song» LP *GAMMA ALBUM* (Gamma Label)</p>';

/** Two flagged entries, so a reply can repair one and skip the other. */
const TWO_FLAGGED =
  '<p>1. Первая группа без разметки</p>' +
  '<p>2. Вторая группа без разметки</p>' +
  '<p>3. Clean Gamma (UK) — «Gamma Song» LP *GAMMA ALBUM* (Gamma Label)</p>';

const SECOND_GUID = 'b0b0b0b0-0000-4000-8000-000000000002';

/** One reply entry: the six columns parse owns, keyed by position. */
function repairEntry(position, fields = {}) {
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

/** An adapter over a fake CLI, logging into the same lines the step uses. */
function wireLlm(ctx, fake, cli = 'claude') {
  ctx.llm = createLlm({ cli, env: { ...process.env, ...fake.env }, log: ctx.log });
  return ctx.llm;
}

test('the fallback sends the flagged entry only, and never a clean one', async (t) => {
  const { ctx, db, episode, guid } = setup(t, { description: MIXED });
  const reply = {
    entries: [
      repairEntry(2, {
        artist: 'Invented Artist',
        track: 'Без разметки',
        album: 'BETA ALBUM',
        label: 'Beta Label',
        country: 'Russia',
        format: 'LP',
      }),
    ],
  };
  const fake = fakeLlm(t, { replies: [JSON.stringify(reply)] });
  wireLlm(ctx, fake);

  const result = await parse.run(ctx, episode);
  assert.deepEqual(result, { tracks: 3, warned: 1, sent: 1, repaired: 1 });

  const calls = fake.calls();
  assert.equal(calls.length, 1, 'one call per episode, not one per entry');
  const { prompt } = calls[0];
  assert.ok(prompt.includes('2. Некая группа без разметки'), 'the flagged raw line is sent');
  for (const clean of ['Clean Alpha', 'Alpha Song', 'ALPHA ALBUM', 'Clean Gamma', 'Gamma Song']) {
    assert.ok(!prompt.includes(clean), `a cleanly parsed entry is never sent: ${clean}`);
  }

  const rows = tracks(db, guid);
  assert.equal(rows[1].artist, 'Некая группа без разметки', 'a filled field is never overwritten');
  assert.equal(rows[1].track, 'Без разметки');
  assert.equal(rows[1].album, 'BETA ALBUM');
  assert.equal(rows[1].label, 'Beta Label');
  assert.equal(rows[1].country, 'Russia');
  assert.equal(rows[1].format, 'LP');
  assert.equal(rows[1].parse_warning, null, 'a repaired row is no longer flagged');
  assert.equal(rows[0].artist, 'Clean Alpha');
  assert.equal(rows[2].artist, 'Clean Gamma');

  const expected = `${guid}: parse 3 tracks, 1 warned, 1 sent to claude, 1 repaired`;
  assert.equal(ctx.lines.at(-1), expected);
  assert.ok(ctx.lines.some((line) => /llm parse claude ok/.test(line)));

  // parse owns no episode column, fallback or not.
  assert.deepEqual(db.prepare('SELECT * FROM episode WHERE guid = ?').get(guid), episode);
});

test('an episode the parser read cleanly never spawns the CLI', async (t) => {
  const { ctx, episode, guid } = setup(t);
  const fake = fakeLlm(t, { reply: '{"entries": []}' });
  wireLlm(ctx, fake);

  const result = await parse.run(ctx, episode);
  assert.deepEqual(result, { tracks: 13, warned: 0, sent: 0, repaired: 0 });
  assert.equal(fake.calls().length, 0, 'nothing flagged, nothing to repair');
  assert.deepEqual(ctx.lines, [`${guid}: parse 13 tracks, 0 warned`]);
});

test('a flagged entry keeps its warning when no adapter is configured', async (t) => {
  const { ctx, db, episode, guid } = setup(t, { description: MIXED });
  assert.equal(ctx.llm, null);

  const result = await parse.run(ctx, episode);
  assert.deepEqual(result, { tracks: 3, warned: 1, sent: 0, repaired: 0 });
  assert.deepEqual(ctx.lines, [`${guid}: parse 3 tracks, 1 warned`]);
  assert.match(tracks(db, guid)[1].parse_warning, /no_track/);
});

test('a position the reply skips keeps its warning, and an invented one is ignored', async (t) => {
  const seen = [];
  const llm = {
    cli: 'stub',
    call: async (request) => {
      seen.push(request);
      return {
        entries: [
          repairEntry(1, { track: 'Первая песня' }),
          repairEntry(99, { track: 'Не существует' }),
        ],
      };
    },
  };
  const { ctx, db, episode, guid } = setup(t, { description: TWO_FLAGGED, llm });

  const result = await parse.run(ctx, episode);
  assert.deepEqual(result, { tracks: 3, warned: 2, sent: 2, repaired: 1 });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].step, 'parse');
  assert.equal(seen[0].guid, guid);
  assert.equal(seen[0].schema, REPAIR_SCHEMA);
  assert.equal(typeof seen[0].prompt, 'string');

  const rows = tracks(db, guid);
  assert.equal(rows.length, 3, 'a position the reply invented is not a new row');
  assert.equal(rows[0].track, 'Первая песня');
  assert.equal(
    rows[0].parse_warning,
    'no_country,no_format,no_album,no_label',
    'the codes for the fields still missing outlive the one that was filled',
  );
  assert.match(rows[1].parse_warning, /no_track/, 'an unanswered position stays flagged');
  assert.equal(ctx.lines.at(-1), `${guid}: parse 3 tracks, 2 warned, 2 sent to stub, 1 repaired`);
});

test('an unrepairable reply fails the episode cleanly and keeps the raw output', async (t) => {
  const { ctx, db, guid } = setup(t, { description: MIXED });
  const fake = fakeLlm(t, { reply: '{"entries": "marker-not-an-array"}' });
  wireLlm(ctx, fake);

  const { failures } = await runPipeline(ctx, PARSE_ONLY, { episode: guid });
  assert.equal(failures, 1);
  assert.equal(fake.calls().length, 3, 'three attempts before it gives up');

  const row = db.prepare('SELECT * FROM episode WHERE guid = ?').get(guid);
  assert.equal(row.status, 'new', 'a failed step leaves the status where it was');
  assert.equal(row.failed_step, 'parse');
  assert.match(row.error, /marker-not-an-array/, 'the raw stdout is retained for debugging');

  const rows = tracks(db, guid);
  assert.equal(rows.length, 3, 'the deterministic rows survive a failed repair');
  assert.match(rows[1].parse_warning, /no_track/);
  assert.equal(rows[0].artist, 'Clean Alpha');
});

test('an auth failure fails every episode without spawning the CLI again', async (t) => {
  const { ctx, db } = setup(t, { description: MIXED });
  seed(db, { guid: SECOND_GUID, description: MIXED });
  const fake = fakeLlm(t, { exit: 1, stderr: 'Not logged in. Please run /login.' });
  wireLlm(ctx, fake);

  const { selected, failures } = await runPipeline(ctx, PARSE_ONLY, {});
  assert.equal(selected, 2);
  assert.equal(failures, 2, 'an auth failure fails both episodes');
  assert.equal(fake.calls().length, 1, 'the CLI is spawned once, not once per episode');

  const rows = db.prepare('SELECT * FROM episode ORDER BY guid').all();
  for (const row of rows) {
    assert.equal(row.status, 'new', 'the next run retries from where this one stopped');
    assert.equal(row.failed_step, 'parse');
    assert.match(row.error, /LlmAuthError|not logged in/i);
  }
  const latched = rows.filter((row) => /disabled for the rest of this run/.test(row.error));
  assert.equal(latched.length, 1, 'the second episode fails on the latch, not on a new spawn');
});

/** Fully parsed entries whose printed numbers disagree with their ordinals. */
const MISNUMBERED =
  '<p>1. Clean Alpha (UK) — «Alpha Song» LP *ALPHA ALBUM* (Alpha Label)</p>' +
  '<p>3. Clean Beta (UK) — «Beta Song» LP *BETA ALBUM* (Beta Label)</p>' +
  '<p>4. Clean Gamma (UK) — «Gamma Song» LP *GAMMA ALBUM* (Gamma Label)</p>';

/** A line the parser cannot read, on an entry that is also misnumbered. */
const MISNUMBERED_AND_UNREADABLE =
  '<p>1. Clean Alpha (UK) — «Alpha Song» LP *ALPHA ALBUM* (Alpha Label)</p>' +
  '<p>3. Некая группа без разметки</p>';

test('a warning no re-reading can settle is never sent and never cleared', async (t) => {
  const { ctx, db, episode, guid } = setup(t, { description: MISNUMBERED });
  const fake = fakeLlm(t, { reply: '{"entries": []}' });
  wireLlm(ctx, fake);

  const result = await parse.run(ctx, episode);
  assert.deepEqual(result, { tracks: 3, warned: 2, sent: 0, repaired: 0 });
  assert.equal(fake.calls().length, 0, 'the regex already read every field of these rows');

  const rows = tracks(db, guid);
  assert.deepEqual(
    rows.map((row) => row.parse_warning),
    [null, 'number_mismatch', 'number_mismatch'],
    'the printed number still disagrees, so the flag stands',
  );
  assert.deepEqual(ctx.lines, [`${guid}: parse 3 tracks, 2 warned`]);
});

test('a reply that fills nothing leaves the warning in place and repairs nothing', async (t) => {
  const seen = [];
  const llm = {
    cli: 'stub',
    call: async (request) => {
      seen.push(request);
      return { entries: [repairEntry(2)] };
    },
  };
  const { ctx, db, episode, guid } = setup(t, { description: MIXED, llm });

  const result = await parse.run(ctx, episode);
  assert.deepEqual(result, { tracks: 3, warned: 1, sent: 1, repaired: 0 });
  assert.equal(seen.length, 1, 'the entry was flagged for a field, so it was sent');

  const row = tracks(db, guid)[1];
  assert.equal(row.track, null, 'the model answered null, as it is told to when a field is absent');
  assert.equal(
    row.parse_warning,
    'no_track,no_country,no_format,no_album,no_label',
    'an echoed position is not a repair',
  );
  assert.equal(ctx.lines.at(-1), `${guid}: parse 3 tracks, 1 warned, 1 sent to stub, 0 repaired`);
});

test('a partial repair clears the codes it filled and keeps the rest', async (t) => {
  const llm = {
    cli: 'stub',
    call: async () => ({ entries: [repairEntry(2, { track: 'Без разметки' })] }),
  };
  const { ctx, db, episode, guid } = setup(t, { description: MISNUMBERED_AND_UNREADABLE, llm });

  const result = await parse.run(ctx, episode);
  assert.deepEqual(result, { tracks: 2, warned: 1, sent: 1, repaired: 1 });

  const row = tracks(db, guid)[1];
  assert.equal(row.track, 'Без разметки');
  assert.equal(
    row.parse_warning,
    'no_country,no_format,no_album,no_label,number_mismatch',
    'the fields still missing keep their codes, and the misprinted number keeps its own',
  );
});
