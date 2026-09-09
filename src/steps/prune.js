import { removeMedia } from '../media.js';
import { rank, STATUSES } from '../status.js';

/**
 * Once an episode is past `transcribed`, both `segment` and `transcribe` have
 * run and nothing later reads audio — the transcript and the segmentation are
 * what every remaining step consumes, and the MP3 is always re-downloadable
 * from the enclosure.
 */
const PAST_TRANSCRIBED = STATUSES.slice(rank('transcribed') + 1);

const SELECT = `
SELECT guid FROM episode
WHERE status IN (${PAST_TRANSCRIBED.map(() => '?').join(', ')})
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
