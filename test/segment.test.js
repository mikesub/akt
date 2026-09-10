import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { openDb } from '../src/db.js';
import { runPipeline } from '../src/runner.js';
import { registry, validateRegistry } from '../src/steps/registry.js';
import { segment } from '../src/steps/segment.js';
import { fakeVad, tempDir, testCtx, vadConfig, wavBytes } from './helpers.js';

const GUID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

/** What the fake VAD reports for the two-minute WAV these tests segment. */
const SEGMENTS = [
  { start: 0, end: 30 },
  { start: 35, end: 40 },
  { start: 100, end: 118 },
];

/**
 * The complement of those segments over 120 seconds with a five-second music
 * floor: two music intervals, and a two-second tail too short to be one.
 */
const INTERVALS = [
  { start: 0, end: 30, label: 'speech' },
  { start: 30, end: 35, label: 'music' },
  { start: 35, end: 40, label: 'speech' },
  { start: 40, end: 100, label: 'music' },
  { start: 100, end: 120, label: 'speech' },
];

const MODEL_TAG =
  'silero-v6.2.0.bin threshold=0.5 min_speech_ms=250 min_silence_ms=100 pad_ms=30 min_music_s=5';

function seed(db, rows) {
  for (const row of rows) {
    db.prepare(
      `INSERT INTO episode (guid, title, published_at, status, updated_at)
       VALUES (?, ?, ?, ?, '2026-01-01T00:00:00.000Z')`,
    ).run(
      row.guid,
      row.guid,
      row.published_at ?? '2025-09-01T00:00:00.000Z',
      row.status ?? 'downloaded',
    );
  }
}

function setup(t, options = {}) {
  const { seconds = 120, list = false, wavs = [GUID], vad: vadOptions = {}, config = {} } = options;
  const db = openDb(':memory:');
  t.after(() => db.close());
  const mediaDir = join(tempDir(t), 'media');
  mkdirSync(mediaDir, { recursive: true });
  for (const guid of wavs) {
    writeFileSync(join(mediaDir, `${guid}.wav`), wavBytes(seconds, { list }));
  }
  const vad = fakeVad(t, { segments: SEGMENTS, ...vadOptions });
  const ctx = testCtx(db, { mediaDir, vad: vadConfig(vad, config) });
  return { ctx, db, mediaDir, vad };
}

function row(db, guid) {
  return db.prepare('SELECT * FROM episode WHERE guid = ?').get(guid);
}

function segmentations(db) {
  return db.prepare('SELECT * FROM segmentation ORDER BY episode_guid').all();
}

test('segment owns the segmented status and runs after download', () => {
  assert.equal(segment.name, 'segment');
  assert.equal(segment.target, 'segmented');
  const names = registry.chain.map((step) => step.name);
  assert.deepEqual(
    names,
    ['parse', 'download', 'segment', 'transcribe', 'extract', 'align'],
    'align is the last step of the chain',
  );
  assert.throws(
    () =>
      validateRegistry({
        before: [],
        chain: [
          { name: 'parse', target: 'parsed' },
          { name: 'align', target: 'aligned' },
        ],
        after: [],
      }),
    /status gap/,
    'a missing chain state is rejected before any episodes run',
  );
});

test('a downloaded episode gets one row of speech and music intervals', async (t) => {
  const { ctx, db, mediaDir, vad } = setup(t);
  seed(db, [{ guid: GUID }]);

  const result = await segment.run(ctx, row(db, GUID));

  assert.equal(result.speech, 3, 'the raw segments the binary detected');
  assert.equal(result.music, 2);
  assert.equal(result.intervals, 5);
  assert.equal(typeof result.seconds, 'number');

  const rows = segmentations(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].episode_guid, GUID);
  assert.deepEqual(JSON.parse(rows[0].intervals), INTERVALS);
  assert.equal(rows[0].intervals, JSON.stringify(INTERVALS), 'stored compact, in that key order');
  assert.equal(rows[0].model, MODEL_TAG);

  assert.match(
    ctx.lines.join('\n'),
    /segment 2 music, 3 speech intervals in [\d.]+s: 0:00:30-0:00:35, 0:00:40-0:01:40/,
  );

  const calls = vad.calls();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].at(-1), join(mediaDir, `${GUID}.wav`), 'the wav, never the mp3');
  assert.deepEqual(readdirSync(mediaDir), [`${GUID}.wav`], 'the step writes no file of its own');
});

test('the duration comes from the wav header, past the LIST chunk ffmpeg writes', async (t) => {
  const { ctx, db } = setup(t, { seconds: 45.5, list: true });
  seed(db, [{ guid: GUID }]);

  await segment.run(ctx, row(db, GUID));

  const intervals = JSON.parse(segmentations(db)[0].intervals);
  assert.deepEqual(intervals, [
    { start: 0, end: 30, label: 'speech' },
    { start: 30, end: 35, label: 'music' },
    { start: 35, end: 40, label: 'speech' },
    { start: 40, end: 45.5, label: 'music' },
  ]);
});

test('a second run replaces the row instead of adding one', async (t) => {
  const { ctx, db, vad } = setup(t);
  seed(db, [{ guid: GUID }]);

  await segment.run(ctx, row(db, GUID));
  const first = segmentations(db);
  await segment.run(ctx, row(db, GUID));

  assert.deepEqual(segmentations(db), first, 'same single row, same content');
  assert.equal(vad.calls().length, 2, 'the binary is re-run: nothing is cached on disk');
});

test('a missing wav names the step that produces it', async (t) => {
  const { ctx, db, mediaDir, vad } = setup(t, { wavs: [] });
  seed(db, [{ guid: GUID }]);

  await assert.rejects(
    () => segment.run(ctx, row(db, GUID)),
    (err) => {
      assert.match(err.message, new RegExp(`no wav at ${join(mediaDir, `${GUID}.wav`)}`));
      assert.match(err.message, /--step download/);
      return true;
    },
  );
  assert.deepEqual(vad.calls(), [], 'nothing is spawned without audio');
  assert.deepEqual(segmentations(db), []);
});

test('a failing vad is isolated to its episode and retried next run', async (t) => {
  const { ctx, db, vad } = setup(t, {
    wavs: [GUID, OTHER],
    vad: { failFor: GUID, exit: 3, stderr: 'failed to load model' },
  });
  seed(db, [{ guid: GUID }, { guid: OTHER, published_at: '2025-08-01T00:00:00.000Z' }]);

  const result = await runPipeline(ctx, { before: [], chain: [segment], after: [] });

  assert.equal(result.failures, 1);
  const failed = row(db, GUID);
  assert.equal(failed.status, 'downloaded', 'the status stays at the last good state');
  assert.equal(failed.failed_step, 'segment');
  assert.match(failed.error, /exited 3: failed to load model/);

  const done = row(db, OTHER);
  assert.equal(done.status, 'segmented');
  assert.equal(done.failed_step, null);
  const stored = segmentations(db).map((entry) => entry.episode_guid);
  assert.deepEqual(stored, [OTHER], 'only the episode that segmented has a row');
  assert.equal(vad.calls().length, 2, 'both episodes were attempted');
});
