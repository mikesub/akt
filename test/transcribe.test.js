import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { openDb } from '../src/db.js';
import { runPipeline } from '../src/runner.js';
import { transcribe } from '../src/steps/transcribe.js';
import { whisperFromEnv } from '../src/whisper.js';
import { fakeWhisper, tempDir, testCtx } from './helpers.js';

const GUID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

/** Only `transcribe`, so the chain under test is the one step. */
const REGISTRY = { before: [], chain: [transcribe], after: [] };

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

function setup(t, options = {}, overrides = {}) {
  const db = openDb(':memory:');
  t.after(() => db.close());
  const mediaDir = join(tempDir(t), 'media');
  mkdirSync(mediaDir, { recursive: true });
  const fake = fakeWhisper(t, options);
  const whisper = whisperFromEnv({ ...process.env, ...fake.env, ...overrides });
  return { ctx: testCtx(db, { mediaDir, whisper }), db, mediaDir, fake };
}

/** The WAV `download` would have left behind. Its bytes are never read. */
function decoded(mediaDir, guid) {
  writeFileSync(join(mediaDir, `${guid}.wav`), 'FAKEWAVDATA');
}

function row(db, guid) {
  return db.prepare('SELECT * FROM episode WHERE guid = ?').get(guid);
}

function transcript(db, guid) {
  return db.prepare('SELECT * FROM transcript WHERE episode_guid = ?').get(guid);
}

test('an episode becomes episode-second segments, with the model recorded', async (t) => {
  const { ctx, db, mediaDir, fake } = setup(t);
  seed(db, [{ guid: GUID }]);
  decoded(mediaDir, GUID);

  const result = await transcribe.run(ctx, row(db, GUID));

  assert.deepEqual(result, { segments: 3, model: 'large-v3' });
  const stored = transcript(db, GUID);
  assert.equal(stored.model, 'large-v3', 'which model produced these seconds is part of the row');
  const segments = JSON.parse(stored.segments);
  assert.deepEqual(
    segments.map((segment) => [segment.start, segment.end]),
    [
      [62, 68.48],
      [68.48, 75.24],
      [604.3, 611.9],
    ],
    'milliseconds from the binary, seconds in the database',
  );
  assert.match(segments[0].text, /^Здравствуйте, в эфире «Стереоплан»/);
  assert.ok(
    segments.every((segment) => segment.text.trim() === segment.text && segment.text !== ''),
    'entries whisper emitted for silence are dropped',
  );
  assert.equal(fake.calls().length, 1);
  assert.match(ctx.lines.join('\n'), /transcribe 3 segments, 20\.8s of speech, large-v3/);
});

test('re-running replaces the transcript instead of adding a second row', async (t) => {
  const { ctx, db, mediaDir, fake } = setup(t);
  seed(db, [{ guid: GUID }]);
  decoded(mediaDir, GUID);

  await transcribe.run(ctx, row(db, GUID));
  await transcribe.run(ctx, row(db, GUID));

  assert.equal(db.prepare('SELECT count(*) AS n FROM transcript').get().n, 1);
  assert.equal(fake.calls().length, 2, 'the work itself is redone; the row is not duplicated');
});

test('a missing wav names the step that produces it and spawns nothing', async (t) => {
  const { ctx, db, mediaDir, fake } = setup(t);
  seed(db, [{ guid: GUID }]);

  await assert.rejects(
    () => transcribe.run(ctx, row(db, GUID)),
    new RegExp(`no wav at ${join(mediaDir, `${GUID}.wav`)}; run --step download first`),
  );
  assert.equal(fake.calls().length, 0);
});

test('a missing model file fails this episode without spawning whisper-cli', async (t) => {
  const empty = tempDir(t);
  const { ctx, db, mediaDir, fake } = setup(t, {}, { WHISPER_MODEL_DIR: empty });
  seed(db, [{ guid: GUID }]);
  decoded(mediaDir, GUID);

  await assert.rejects(
    () => transcribe.run(ctx, row(db, GUID)),
    /no model at .*ggml-large-v3\.bin: .*download-ggml-model\.sh large-v3/,
  );
  assert.equal(fake.calls().length, 0);
});

test('one failing episode is recorded and the rest of the run continues', async (t) => {
  const { ctx, db, mediaDir } = setup(t);
  seed(db, [
    { guid: GUID, published_at: '2025-09-01T00:00:00.000Z' },
    { guid: OTHER, published_at: '2025-08-01T00:00:00.000Z' },
  ]);
  // Only the newer episode was downloaded.
  decoded(mediaDir, GUID);

  const result = await runPipeline(ctx, REGISTRY);

  assert.equal(result.failures, 1);
  const done = row(db, GUID);
  assert.equal(done.status, 'transcribed');
  assert.equal(done.error, null);
  assert.equal(JSON.parse(transcript(db, GUID).segments).length, 3);

  const failed = row(db, OTHER);
  assert.equal(failed.status, 'downloaded', 'status stays at the last good state');
  assert.equal(failed.failed_step, 'transcribe');
  assert.match(failed.error, /no wav at/);
  assert.equal(transcript(db, OTHER), undefined);
});

test('a transcribed episode is skipped by the chain and re-run only by --step', async (t) => {
  const { ctx, db, mediaDir, fake } = setup(t);
  seed(db, [{ guid: GUID, status: 'transcribed' }]);
  decoded(mediaDir, GUID);

  await runPipeline(ctx, REGISTRY);
  assert.equal(fake.calls().length, 0, 'an episode already at transcribed costs no CPU');

  const forced = await runPipeline(ctx, REGISTRY, { episode: GUID, step: 'transcribe' });

  assert.equal(forced.failures, 0);
  assert.equal(fake.calls().length, 1);
  assert.equal(row(db, GUID).status, 'transcribed');
  assert.equal(JSON.parse(transcript(db, GUID).segments).length, 3);
});
