import { normalizeDescription, parseTracklist } from '../tracklist.js';

/**
 * The ten `track` columns this step owns. Every other column on the row
 * belongs to a later step and must survive a re-parse untouched, which is
 * why this is an upsert on (episode_guid, position) listing exactly these
 * columns rather than a delete-and-reinsert: `track.id` has to stay stable
 * for the rows extract, align and links have already filled in.
 */
const OWNED_COLUMNS = [
  'artist',
  'track',
  'album',
  'label',
  'country',
  'format',
  'section',
  'is_cherished',
  'note_desc',
  'parse_warning',
];

const UPSERT = `
INSERT INTO track (episode_guid, position, ${OWNED_COLUMNS.join(', ')})
VALUES (?, ?, ${OWNED_COLUMNS.map(() => '?').join(', ')})
ON CONFLICT(episode_guid, position) DO UPDATE SET
${OWNED_COLUMNS.map((column) => `  ${column} = excluded.${column}`).join(',\n')}`;

/** Positions the description no longer has. Nothing else is ever deleted. */
const DELETE_TRAILING = 'DELETE FROM track WHERE episode_guid = ? AND position > ?';

export const parse = {
  name: 'parse',
  target: 'parsed',
  run(ctx, episode) {
    const { tracks, warned } = parseTracklist(normalizeDescription(episode.description_raw));

    ctx.db.exec('BEGIN');
    try {
      const upsert = ctx.db.prepare(UPSERT);
      for (const row of tracks) {
        upsert.run(
          episode.guid,
          row.position,
          row.artist,
          row.track,
          row.album,
          row.label,
          row.country,
          row.format,
          row.section,
          row.is_cherished ? 1 : 0,
          row.note_desc,
          row.parse_warning,
        );
      }
      ctx.db.prepare(DELETE_TRAILING).run(episode.guid, tracks.length);
      ctx.db.exec('COMMIT');
    } catch (err) {
      ctx.db.exec('ROLLBACK');
      throw err;
    }

    ctx.log(`${episode.guid}: parse ${tracks.length} tracks, ${warned} warned`);
    return { tracks: tracks.length, warned };
  },
};
