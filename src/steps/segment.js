import { fileSize, mediaPaths, wavDuration } from '../media.js';
import { detectSpeech, formatRange, labelIntervals, vadModelTag } from '../vad.js';

const UPSERT = `
INSERT INTO segmentation (episode_guid, intervals, model) VALUES (?, ?, ?)
ON CONFLICT(episode_guid) DO UPDATE SET
  intervals = excluded.intervals, model = excluded.model`;

/**
 * Label one episode's audio speech or music.
 *
 * The VAD is re-run every time rather than cached on disk: it costs seconds to
 * a minute of CPU, and the alternative is a second copy of the truth to keep
 * in step with the WAV. The row is upserted, so `--step segment` after a
 * threshold change simply replaces what was there.
 */
export const segment = {
  name: 'segment',
  target: 'segmented',
  async run(ctx, row) {
    const startedAt = Date.now();
    const { wav } = mediaPaths(ctx.mediaDir, row.guid);
    if ((await fileSize(wav)) === null) {
      throw new Error(`${row.guid}: no wav at ${wav}; run --step download first`);
    }

    const durationSec = await wavDuration(wav);
    const speech = await detectSpeech(ctx.vad, wav);
    const intervals = labelIntervals(speech, durationSec, ctx.vad.minMusicSec);
    ctx.db.prepare(UPSERT).run(row.guid, JSON.stringify(intervals), vadModelTag(ctx.vad));

    const music = intervals.filter((interval) => interval.label === 'music');
    const seconds = (Date.now() - startedAt) / 1000;
    // Every music range is logged: the eyeball check for this step is that
    // they line up with the episode's songs, in count and in length.
    const ranges = music.map((interval) => formatRange(interval.start, interval.end)).join(', ');
    const counts = `${music.length} music, ${intervals.length - music.length} speech intervals`;
    ctx.log(`${row.guid}: segment ${counts} in ${seconds.toFixed(1)}s: ${ranges}`);

    return {
      speech: speech.length,
      music: music.length,
      intervals: intervals.length,
      seconds,
    };
  },
};
