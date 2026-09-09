import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { openDb } from '../src/db.js';
import { runPipeline } from '../src/runner.js';
import { download } from '../src/steps/download.js';
import { fakeFfmpeg, mediaServer, tempDir, testCtx } from './helpers.js';

const GUID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SIZE = 4096;

function seed(db, rows) {
  for (const row of rows) {
    db.prepare(
      `INSERT INTO episode (guid, title, published_at, mp3_url, enclosure_length, status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z')`,
    ).run(
      row.guid,
      row.guid,
      row.published_at ?? '2025-09-01T00:00:00.000Z',
      row.mp3_url ?? null,
      row.enclosure_length ?? null,
      row.status ?? 'parsed',
    );
  }
}

async function setup(t, { size = SIZE, keepMedia = false } = {}) {
  const db = openDb(':memory:');
  t.after(() => db.close());
  const mediaDir = join(tempDir(t), 'media');
  const ffmpeg = fakeFfmpeg(tempDir(t));
  const server = await mediaServer(t, { size });
  const ctx = testCtx(db, {
    fetch: globalThis.fetch,
    mediaDir,
    keepMedia,
    ffmpeg: ffmpeg.bin,
  });
  return { ctx, db, mediaDir, ffmpeg, server };
}

function row(db, guid) {
  return db.prepare('SELECT * FROM episode WHERE guid = ?').get(guid);
}

test('a fresh episode is transferred, verified and decoded once', async (t) => {
  const { ctx, db, mediaDir, ffmpeg, server } = await setup(t);
  seed(db, [{ guid: GUID, mp3_url: server.url('84'), enclosure_length: SIZE }]);

  const result = await download.run(ctx, row(db, GUID));

  assert.deepEqual(result, { transferred: true, decoded: true });
  assert.equal(readFileSync(join(mediaDir, `${GUID}.mp3`)).length, SIZE);
  assert.equal(readFileSync(join(mediaDir, `${GUID}.wav`), 'utf8'), 'FAKEWAVDATA');
  assert.equal(existsSync(join(mediaDir, `${GUID}.mp3.part`)), false);
  assert.equal(ffmpeg.calls().length, 1);
});

test('a second run over a complete episode transfers and decodes nothing', async (t) => {
  const { ctx, db, ffmpeg, server } = await setup(t);
  seed(db, [{ guid: GUID, mp3_url: server.url('84'), enclosure_length: SIZE }]);

  await download.run(ctx, row(db, GUID));
  const hitsAfterFirst = server.hits.length;

  const result = await download.run(ctx, row(db, GUID));

  assert.deepEqual(result, { transferred: false, decoded: false });
  assert.equal(server.hits.length, hitsAfterFirst, 'no request is made');
  assert.equal(ffmpeg.calls().length, 1, 'no second decode');
});

test('an mp3 of the wrong size is refetched and its wav regenerated', async (t) => {
  const { ctx, db, mediaDir, ffmpeg, server } = await setup(t);
  seed(db, [{ guid: GUID, mp3_url: server.url('84'), enclosure_length: SIZE }]);
  mkdirSync(mediaDir, { recursive: true });
  writeFileSync(join(mediaDir, `${GUID}.mp3`), 'truncated');
  writeFileSync(join(mediaDir, `${GUID}.wav`), 'stale wav');

  const result = await download.run(ctx, row(db, GUID));

  assert.deepEqual(result, { transferred: true, decoded: true });
  assert.equal(readFileSync(join(mediaDir, `${GUID}.mp3`)).length, SIZE);
  assert.equal(readFileSync(join(mediaDir, `${GUID}.wav`), 'utf8'), 'FAKEWAVDATA');
  assert.equal(ffmpeg.calls().length, 1);
  assert.match(ctx.lines.join('\n'), /mp3 is 9 bytes, expected 4096/);
});

test('a verified mp3 with a missing wav is only decoded', async (t) => {
  const { ctx, db, mediaDir, ffmpeg, server } = await setup(t);
  seed(db, [{ guid: GUID, mp3_url: server.url('84'), enclosure_length: SIZE }]);
  await download.run(ctx, row(db, GUID));
  const hitsAfterFirst = server.hits.length;
  rmSync(join(mediaDir, `${GUID}.wav`));

  const result = await download.run(ctx, row(db, GUID));

  assert.deepEqual(result, { transferred: false, decoded: true });
  assert.equal(server.hits.length, hitsAfterFirst);
  assert.equal(ffmpeg.calls().length, 2);
});

test('a missing url, a missing length or a bad guid fails before any I/O', async (t) => {
  const { ctx, db, mediaDir, server } = await setup(t);
  seed(db, [
    { guid: GUID, mp3_url: null, enclosure_length: SIZE },
    { guid: OTHER, mp3_url: server.url('75'), enclosure_length: null },
  ]);

  await assert.rejects(() => download.run(ctx, row(db, GUID)), /no mp3_url/);
  await assert.rejects(() => download.run(ctx, row(db, OTHER)), /no enclosure_length/);
  await assert.rejects(
    () => download.run(ctx, { guid: 'not-a-uuid', mp3_url: server.url('84'), enclosure_length: 1 }),
    /bad guid: not-a-uuid/,
  );
  assert.deepEqual(server.hits, []);
  assert.equal(existsSync(mediaDir), false, 'the media directory is not even created');
});

test('a failing download is isolated to its episode and retried next run', async (t) => {
  const { ctx, db, mediaDir, server } = await setup(t);
  seed(db, [
    { guid: GUID, mp3_url: `${server.origin}/gone.mp3`, enclosure_length: SIZE },
    { guid: OTHER, mp3_url: server.url('75'), enclosure_length: SIZE, published_at: '2025-08-01' },
  ]);

  const result = await runPipeline(ctx, { before: [], chain: [download], after: [] });

  assert.equal(result.failures, 1);
  const failed = row(db, GUID);
  assert.equal(failed.status, 'parsed', 'the status stays at the last good state');
  assert.equal(failed.failed_step, 'download');
  assert.match(failed.error, /download failed: 404/);
  assert.equal(existsSync(join(mediaDir, `${GUID}.mp3`)), false);

  const done = row(db, OTHER);
  assert.equal(done.status, 'downloaded');
  assert.equal(done.failed_step, null);
  assert.equal(readFileSync(join(mediaDir, `${OTHER}.mp3`)).length, SIZE);
});
