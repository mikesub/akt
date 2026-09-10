import { removeMedia } from '../media.js';
import { rank, STATUSES } from '../status.js';

/**
 * Media may go once nothing later reads audio: the transcript and the
 * segmentation are what every remaining step consumes, and the MP3 is always
 * re-downloadable from the enclosure.
 *
 * The status alone does not prove that for a forced step or an imported
 * database: an episode can stand past `transcribed` with no stored
 * segmentation. `align` reads track seconds from that segmentation, so the
 * stored row is part of the condition rather than something the rank alone is
 * trusted to imply.
 */
const PAST_TRANSCRIBED = STATUSES.slice(rank('transcribed') + 1);

const SELECT = `
SELECT guid FROM episode
WHERE status IN (${PAST_TRANSCRIBED.map(() => '?').join(', ')})
  AND EXISTS (SELECT 1 FROM segmentation WHERE segmentation.episode_guid = episode.guid)
ORDER BY guid ASC`;

/**
 * Run-level retention sweep. Retaining all 83 MP3s costs ~4.6 GB and their
 * WAVs another ~10 GB, so the default is to let them go; `KEEP_MEDIA=1`
 * keeps them.
 */
export const prune = {
  name: 'prune',
  async run(ctx) {
    if (ctx.keepMedia) return { episodes: 0, files: 0 };

    const rows = ctx.db.prepare(SELECT).all(...PAST_TRANSCRIBED);
    let files = 0;
    for (const row of rows) files += await removeMedia(ctx.mediaDir, row.guid);
    if (files > 0) ctx.log(`prune: removed ${files} files for ${rows.length} episodes`);
    return { episodes: rows.length, files };
  },
};
