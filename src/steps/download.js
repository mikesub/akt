import { mkdir, unlink } from 'node:fs/promises';
import { decodeWav, downloadMp3, fileSize, isVerified, mediaPaths } from '../media.js';

function ignoreMissing(err) {
  if (err.code !== 'ENOENT') throw err;
}

/**
 * Fetch one episode's enclosure and decode it once.
 *
 * Everything here is derived from the guid and the media directory — no
 * episode column records where the audio is — so the step is idempotent on
 * disk: a verified MP3 transfers nothing, and media deleted by `prune` is
 * simply fetched again on the next `--step download`.
 */
export const download = {
  name: 'download',
  target: 'downloaded',
  async run(ctx, row) {
    const { mp3, wav } = mediaPaths(ctx.mediaDir, row.guid);
    if (!row.mp3_url) throw new Error(`${row.guid}: no mp3_url in the feed`);
    if (typeof row.enclosure_length !== 'number') {
      throw new Error(`${row.guid}: no enclosure_length to verify against`);
    }

    await mkdir(ctx.mediaDir, { recursive: true });

    let transferred = false;
    if (!(await isVerified(mp3, row.enclosure_length))) {
      const stale = await fileSize(mp3);
      if (stale !== null) {
        ctx.log(`${row.guid}: mp3 is ${stale} bytes, expected ${row.enclosure_length}; refetching`);
      }
      await downloadMp3(ctx.fetch, row.mp3_url, mp3, row.enclosure_length);
      // A fresh MP3 makes any WAV beside it stale.
      await unlink(wav).catch(ignoreMissing);
      transferred = true;
      ctx.log(`${row.guid}: downloaded ${row.enclosure_length} bytes to ${mp3}`);
    }

    let decoded = false;
    if ((await fileSize(wav)) === null) {
      await decodeWav(ctx.ffmpeg, mp3, wav);
      decoded = true;
      ctx.log(`${row.guid}: decoded ${wav}`);
    }

    return { transferred, decoded };
  },
};
