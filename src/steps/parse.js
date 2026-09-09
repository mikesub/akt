import { pickRepairs, REPAIR_SCHEMA, repairPrompt } from '../repair.js';
import { FIELD_WARNINGS, normalizeDescription, parseTracklist } from '../tracklist.js';

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

/**
 * The LLM fallback's merge. COALESCE makes "never clear a field the
 * deterministic parser filled" a property of the statement rather than of a
 * code path: a repaired value only lands where the column is still NULL.
 * `parse_warning` is rewritten rather than blanked, because a reply that
 * filled nothing has repaired nothing, and a row can carry a code the reply
 * was never asked about.
 */
const MERGE_REPAIR = `
UPDATE track SET
  artist = COALESCE(artist, ?),
  track = COALESCE(track, ?),
  album = COALESCE(album, ?),
  label = COALESCE(label, ?),
  country = COALESCE(country, ?),
  format = COALESCE(format, ?),
  parse_warning = ?
WHERE episode_guid = ? AND position = ?`;

/** Rows the fallback can do something about: at least one unread field. */
function hasFieldWarning(warning) {
  if (warning === null) return false;
  return warning.split(',').some((code) => Object.hasOwn(FIELD_WARNINGS, code));
}

/**
 * What is left of a row's warning once the repair has landed. A field code
 * goes only where the reply actually supplied that field — the model is told
 * to answer null for anything the line does not contain, and a null answer
 * repairs nothing — and a code that names no field always stays.
 */
function remainingWarning(warning, entry) {
  const left = warning.split(',').filter((code) => {
    const column = FIELD_WARNINGS[code];
    if (column === undefined) return true;
    return entry[column] === null || entry[column] === undefined;
  });
  return left.length > 0 ? left.join(',') : null;
}

/**
 * One call per episode, over the flagged rows only. Anything that goes wrong
 * propagates: the runner records `error` and `failed_step`, the status stays
 * where it was, and the deterministic rows written above stay in the table,
 * so the next run retries the repair rather than the whole parse.
 */
async function repairFlagged(ctx, guid, flagged) {
  const data = await ctx.llm.call({
    step: 'parse',
    guid,
    prompt: repairPrompt(flagged),
    schema: REPAIR_SCHEMA,
  });

  const byPosition = new Map(flagged.map((row) => [row.position, row]));
  const picked = pickRepairs(data, [...byPosition.keys()]);
  if (picked.length === 0) return 0;

  // A repair is a row whose warning changed, not a position the model echoed
  // back: that is what says whether the deterministic parser is drifting.
  let repaired = 0;
  ctx.db.exec('BEGIN');
  try {
    const merge = ctx.db.prepare(MERGE_REPAIR);
    for (const entry of picked) {
      const before = byPosition.get(entry.position).parse_warning;
      const after = remainingWarning(before, entry);
      if (after !== before) repaired++;
      merge.run(
        entry.artist,
        entry.track,
        entry.album,
        entry.label,
        entry.country,
        entry.format,
        after,
        guid,
        entry.position,
      );
    }
    ctx.db.exec('COMMIT');
  } catch (err) {
    ctx.db.exec('ROLLBACK');
    throw err;
  }
  return repaired;
}

export const parse = {
  name: 'parse',
  target: 'parsed',
  async run(ctx, episode) {
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

    // Only what the deterministic pass could not read is ever sent, and only
    // after its own rows are committed. A row flagged for something no
    // re-reading can settle — a misprinted number — is not one of them.
    const flagged = tracks.filter((row) => hasFieldWarning(row.parse_warning));
    const sent = flagged.length > 0 && ctx.llm ? flagged.length : 0;
    const repaired = sent > 0 ? await repairFlagged(ctx, episode.guid, flagged) : 0;

    const counted = `parse ${tracks.length} tracks, ${warned} warned`;
    const fallback = sent > 0 ? `, ${sent} sent to ${ctx.llm.cli}, ${repaired} repaired` : '';
    ctx.log(`${episode.guid}: ${counted}${fallback}`);
    return { tracks: tracks.length, warned, sent, repaired };
  },
};
