import { setMeta } from '../db.js';
import { parseFeed, resolveFeed } from '../feed.js';

/** The seven columns ingest owns on an episode row. */
const FEED_COLUMNS = [
  'number',
  'title',
  'published_at',
  'mp3_url',
  'enclosure_length',
  'duration_sec',
  'description_raw',
];

const INSERT = `
INSERT INTO episode (
  guid, number, title, published_at, mp3_url, enclosure_length, duration_sec,
  description_raw, description_changed, status, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'new', ?)`;

const REFRESH_ALL = `
UPDATE episode SET
  number = ?, title = ?, published_at = ?, mp3_url = ?, enclosure_length = ?,
  duration_sec = ?, description_raw = ?, updated_at = ?
WHERE guid = ?`;

const REFRESH_DESCRIPTION = `
UPDATE episode SET description_raw = ?, description_changed = 1, updated_at = ?
WHERE guid = ?`;

/**
 * Upsert one row per feed item, keyed on guid.
 *
 * A row at status `new` has all seven feed columns refreshed, but only when
 * something actually differs, so a re-run leaves the table byte-identical.
 * A row past `new` is never overwritten, with one exception: a changed
 * description is stored and flagged, so a re-parse can be triggered by hand.
 */
export function upsertEpisodes(db, items, now) {
  const select = db.prepare('SELECT * FROM episode WHERE guid = ?');
  const insert = db.prepare(INSERT);
  const refreshAll = db.prepare(REFRESH_ALL);
  const refreshDescription = db.prepare(REFRESH_DESCRIPTION);

  const counts = { inserted: 0, updated: 0, unchanged: 0 };
  for (const item of items) {
    const existing = select.get(item.guid);
    if (!existing) {
      insert.run(
        item.guid,
        item.number ?? null,
        item.title ?? null,
        item.published_at ?? null,
        item.mp3_url ?? null,
        item.enclosure_length ?? null,
        item.duration_sec ?? null,
        item.description_raw ?? null,
        now,
      );
      counts.inserted++;
      continue;
    }

    if (existing.status === 'new') {
      const differs = FEED_COLUMNS.some(
        (column) => (existing[column] ?? null) !== (item[column] ?? null),
      );
      if (!differs) {
        counts.unchanged++;
        continue;
      }
      refreshAll.run(
        item.number ?? null,
        item.title ?? null,
        item.published_at ?? null,
        item.mp3_url ?? null,
        item.enclosure_length ?? null,
        item.duration_sec ?? null,
        item.description_raw ?? null,
        now,
        item.guid,
      );
      counts.updated++;
      continue;
    }

    if ((existing.description_raw ?? null) !== (item.description_raw ?? null)) {
      refreshDescription.run(item.description_raw ?? null, now, item.guid);
      counts.updated++;
      continue;
    }
    counts.unchanged++;
  }
  return counts;
}

export const ingest = {
  name: 'ingest',
  async run(ctx) {
    const { url, xml } = await resolveFeed(ctx.fetch, ctx.feedUrl);
    const { items, skipped } = parseFeed(xml);

    ctx.db.exec('BEGIN');
    let counts;
    try {
      setMeta(ctx.db, 'feed_url', url);
      counts = upsertEpisodes(ctx.db, items, ctx.now());
      ctx.db.exec('COMMIT');
    } catch (err) {
      ctx.db.exec('ROLLBACK');
      throw err;
    }

    const summary = `${counts.inserted} inserted, ${counts.updated} updated, ${counts.unchanged} unchanged`;
    ctx.log(`ingest ${url}: ${items.length} items, ${summary}, ${skipped} skipped`);
    return counts;
  },
};
