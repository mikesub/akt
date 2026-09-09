import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { decodeWav, downloadMp3, mediaPaths, removeMedia } from '../src/media.js';
import { fakeFfmpeg, mediaServer, tempDir } from './helpers.js';

const GUID = '11111111-1111-4111-8111-111111111111';

test('mediaPaths asserts the guid shape instead of sanitising it', () => {
  assert.deepEqual(mediaPaths('/m', GUID), {
    mp3: `/m/${GUID}.mp3`,
    wav: `/m/${GUID}.wav`,
  });
  for (const bad of ['../etc/passwd', 'Z1111111-1111-4111-8111-111111111111', '', null]) {
    assert.throws(() => mediaPaths('/m', bad), /bad guid/);
  }
});

test('a 302 to the CDN is followed and the file lands verified', async (t) => {
  const dir = tempDir(t);
  const server = await mediaServer(t, { size: 4096 });
  const dest = join(dir, `${GUID}.mp3`);

  const size = await downloadMp3(globalThis.fetch, server.url('84'), dest, 4096);

  assert.equal(size, 4096);
  assert.equal(readFileSync(dest).length, 4096);
  assert.equal(existsSync(`${dest}.part`), false, 'the temporary file is gone');
  assert.deepEqual(server.hits, ['/api/84.mp3', '/cdn/84.mp3?v=7']);
});

test('a content-length that disagrees with the enclosure fails before writing', async (t) => {
  const dir = tempDir(t);
  const server = await mediaServer(t, { size: 4096 });
  const dest = join(dir, `${GUID}.mp3`);

  await assert.rejects(
    () => downloadMp3(globalThis.fetch, server.url('84'), dest, 5000),
    /content-length 4096, expected 5000/,
  );
  assert.equal(existsSync(dest), false);
  assert.equal(existsSync(`${dest}.part`), false);
});

test('an interrupted transfer leaves nothing behind, and a retry succeeds', async (t) => {
  const dir = tempDir(t);
  const server = await mediaServer(t, { size: 4096, interruptAfter: 1024 });
  const dest = join(dir, `${GUID}.mp3`);

  await assert.rejects(() => downloadMp3(globalThis.fetch, server.url('84'), dest, 4096));
  assert.equal(existsSync(dest), false, 'a truncated file must never look complete');
  assert.equal(existsSync(`${dest}.part`), false);

  server.opts.interruptAfter = null;
  assert.equal(await downloadMp3(globalThis.fetch, server.url('84'), dest, 4096), 4096);
  assert.equal(readFileSync(dest).length, 4096);
});

test('a short body with no content-length is caught by the size check', async (t) => {
  const dir = tempDir(t);
  const server = await mediaServer(t, { size: 1000, chunked: true });
  const dest = join(dir, `${GUID}.mp3`);

  await assert.rejects(
    () => downloadMp3(globalThis.fetch, server.url('84'), dest, 4096),
    /downloaded 1000 bytes, expected 4096/,
  );
  assert.equal(existsSync(dest), false);
  assert.equal(existsSync(`${dest}.part`), false);
});

test('a non-ok response names the status and the url', async (t) => {
  const dir = tempDir(t);
  const server = await mediaServer(t);
  const dest = join(dir, `${GUID}.mp3`);

  await assert.rejects(
    () => downloadMp3(globalThis.fetch, `${server.origin}/gone.mp3`, dest, 4096),
    /download failed: 404 Not Found \(http:\/\/127\.0\.0\.1:\d+\/gone\.mp3\)/,
  );
  assert.equal(existsSync(dest), false);
});

test('decodeWav asks ffmpeg for 16 kHz mono PCM and renames on success', async (t) => {
  const dir = tempDir(t);
  const bin = tempDir(t);
  const ffmpeg = fakeFfmpeg(bin);
  const mp3 = join(dir, `${GUID}.mp3`);
  const wav = join(dir, `${GUID}.wav`);
  writeFileSync(mp3, 'mp3');

  await decodeWav(ffmpeg.bin, mp3, wav);

  assert.equal(readFileSync(wav, 'utf8'), 'FAKEWAVDATA');
  assert.equal(existsSync(`${wav}.part`), false);
  const calls = ffmpeg.calls();
  assert.equal(calls.length, 1);
  assert.match(calls[0], /-ac 1 -ar 16000 -c:a pcm_s16le -f wav/);
  assert.match(calls[0], new RegExp(`-i ${mp3} `));
  assert.match(calls[0], new RegExp(`${wav}\\.part$`), 'ffmpeg writes the temporary name');
});

test('a failing ffmpeg surfaces its stderr and leaves no wav', async (t) => {
  const dir = tempDir(t);
  const bin = tempDir(t);
  const ffmpeg = fakeFfmpeg(bin, { exitCode: 3, stderr: 'Invalid data found' });
  const mp3 = join(dir, `${GUID}.mp3`);
  const wav = join(dir, `${GUID}.wav`);
  writeFileSync(mp3, 'mp3');

  await assert.rejects(
    () => decodeWav(ffmpeg.bin, mp3, wav),
    /ffmpeg exited 3: Invalid data found/,
  );
  assert.equal(existsSync(wav), false);
  assert.equal(existsSync(`${wav}.part`), false);
});

test('removeMedia counts what it removed and ignores what is missing', async (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, `${GUID}.mp3`), 'a');
  writeFileSync(join(dir, `${GUID}.wav`), 'b');
  writeFileSync(join(dir, `${GUID}.mp3.part`), 'c');

  assert.equal(await removeMedia(dir, GUID), 3);
  assert.equal(await removeMedia(dir, GUID), 0);
  assert.equal(existsSync(join(dir, `${GUID}.mp3`)), false);
});
