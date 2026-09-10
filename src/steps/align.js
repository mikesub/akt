import { alignTracks } from '../align.js';
import { clock } from '../vad.js';

const SELECT_TRACKS = `
SELECT position, artist, track, intro_segment FROM track
WHERE episode_guid = ? ORDER BY position`;

const UPDATE = `
UPDATE track SET start_sec = ?, start_confidence = ?
WHERE episode_guid = ? AND position = ?`;

/** One row the step cannot work without, named together with its step. */
function requireRow(ctx, sql, guid, missing) {
  const row = ctx.db.prepare(sql).get(guid);
  if (!row) throw new Error(missing);
  return row;
}

/**
 * Give every track the second its music starts on.
 *
 * The second is never computed: it is the exact start of a music interval the
 * VAD found, and this is the only place that conversion happens —
 * `alignTracks` answers in interval indices precisely so that no reading of
 * the transcript, and no model, can put a number here that the audio does not
 * back.
 *
 * Every row of the episode is rewritten from scratch in one transaction, so a
 * re-run after a better transcript replaces what was there, including
 * returning a track that lost its evidence to NULL.
 */
export const align = {
  name: 'align',
  target: 'aligned',
  async run(ctx, row) {
    const segmentation = requireRow(
      ctx,
      'SELECT intervals FROM segmentation WHERE episode_guid = ?',
      row.guid,
      `no segmentation for ${row.guid}; run --step segment first`,
    );
    const transcript = requireRow(
      ctx,
      'SELECT segments FROM transcript WHERE episode_guid = ?',
      row.guid,
      `no transcript for ${row.guid}; run --step transcribe first`,
    );

    const intervals = JSON.parse(segmentation.intervals ?? '[]');
    const segments = JSON.parse(transcript.segments ?? '[]');
    const music = intervals.filter((interval) => interval.label === 'music');
    const tracks = ctx.db.prepare(SELECT_TRACKS).all(row.guid);

    const placements = alignTracks({ tracks, segments, intervals, synonyms: ctx.synonyms ?? null });
    const seconds = placements.map((placement) =>
      placement.interval === null ? null : music[placement.interval].start,
    );

    ctx.db.exec('BEGIN');
    try {
      const update = ctx.db.prepare(UPDATE);
      for (const [index, placement] of placements.entries()) {
        update.run(seconds[index], placement.confidence, row.guid, placement.position);
      }
      ctx.db.exec('COMMIT');
    } catch (err) {
      ctx.db.exec('ROLLBACK');
      throw err;
    }

    const counts = { tracks: placements.length, high: 0, medium: 0, low: 0, unplaced: 0, intro: 0 };
    for (const placement of placements) {
      if (placement.confidence === null) counts.unplaced++;
      else counts[placement.confidence]++;
      if (placement.evidence === 'intro') counts.intro++;
    }

    // Every track is listed at the second it landed on: this line is what the
    // listening check is done from, so it has to be seekable as it stands.
    const listed = placements
      .map((placement, index) =>
        seconds[index] === null
          ? `${placement.position}@-`
          : `${placement.position}@${clock(seconds[index])} ${placement.confidence}`,
      )
      .join(', ');
    const summary = `${counts.high} high, ${counts.medium} medium, ${counts.low} low, ${counts.unplaced} unplaced`;
    ctx.log(
      `${row.guid}: align ${counts.tracks} tracks: ${summary}, intro fallback ${counts.intro}: ${listed}`,
    );

    return counts;
  },
};
