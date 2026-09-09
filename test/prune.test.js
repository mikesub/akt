import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { openDb } from '../src/db.js';
import { prune } from '../src/steps/prune.js';
import { tempDir, testCtx } from './helpers.js';

const GUIDS = {
  downloaded: '11111111-1111-4111-8111-111111111111',
  transcribed: '22222222-2222-4222-8222-222222222222',
  extracted: '33333333-3333-4333-8333-333333333333',
  notified: '44444444-4444-4444-8444-444444444444',
};

function setup(t, { keepMedia = false, withFiles = Object.keys(GUIDS) } = {}) {
  const db = openDb(':memory:');
  t.after(() => db.close());
  const mediaDir = tempDir(t);
  for (const [status, guid] of Object.entries(GUIDS)) {
    db.prepare(
      "INSERT INTO episode (guid, status, updated_at) VALUES (?, ?, '2026-01-01T00:00:00.000Z')",
    ).run(guid, status);
    if (!withFiles.includes(status)) continue;
    writeFileSync(join(mediaDir, `${guid}.mp3`), 'mp3');
    writeFileSync(join(mediaDir, `${guid}.wav`), 'wav');
  }
  return { ctx: testCtx(db, { mediaDir, keepMedia }), mediaDir };
}

function hasMedia(mediaDir, guid) {
  return existsSync(join(mediaDir, `${guid}.mp3`)) || existsSync(join(mediaDir, `${guid}.wav`));
}

test('media is dropped only once an episode is past transcribed', async (t) => {
  const { ctx, mediaDir } = setup(t);

  assert.deepEqual(await prune.run(ctx), { episodes: 2, files: 4 });

  assert.equal(hasMedia(mediaDir, GUIDS.extracted), false);
  assert.equal(hasMedia(mediaDir, GUIDS.notified), false);
  assert.equal(hasMedia(mediaDir, GUIDS.transcribed), true, 'transcribed still needs its audio');
  assert.equal(hasMedia(mediaDir, GUIDS.downloaded), true);
  assert.match(ctx.lines.join('\n'), /prune: removed 4 files for 2 episodes/);
});

test('KEEP_MEDIA leaves every file alone', async (t) => {
  const { ctx, mediaDir } = setup(t, { keepMedia: true });

  assert.deepEqual(await prune.run(ctx), { episodes: 0, files: 0 });

  for (const guid of Object.values(GUIDS)) assert.equal(hasMedia(mediaDir, guid), true);
  assert.deepEqual(ctx.lines, []);
});

test('an episode whose media is already gone is not an error', async (t) => {
  const { ctx } = setup(t, { withFiles: [] });

  assert.deepEqual(await prune.run(ctx), { episodes: 2, files: 0 });
  assert.deepEqual(ctx.lines, [], 'nothing to say when nothing was removed');
});
