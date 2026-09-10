import { notesPrompt, notesSchema, pickNotes } from '../notes.js';

/**
 * The four `track` columns this step owns. `genre` belongs to the later
 * `genres` step, which normalises `genre_raw` into it, and `start_sec` to
 * `align` — neither is ever written from here, so the two steps can never
 * disagree about a column.
 */
const OWNED_COLUMNS = ['note_spoken', 'genre_raw', 'tags', 'intro_segment'];

const SELECT_TRANSCRIPT = 'SELECT segments FROM transcript WHERE episode_guid = ?';

const SELECT_TRACKS = `
SELECT position, artist, country, track, album, label, section, note_desc
FROM track WHERE episode_guid = ? ORDER BY position`;

const UPDATE_TRACK = `
UPDATE track SET ${OWNED_COLUMNS.map((column) => `${column} = ?`).join(', ')}
WHERE episode_guid = ? AND position = ?`;

/** The only episode column this step owns. `status` is the runner's. */
const UPDATE_EPISODE = 'UPDATE episode SET tags = ? WHERE guid = ?';

/** What the step writes when there is nothing to ask about. */
function blank(positions) {
  return positions.map((position) => ({
    position,
    note_spoken: null,
    genre_raw: null,
    tags: [],
    intro_segment: null,
  }));
}

/**
 * Summarise, per track, what the host said about it on air.
 *
 * One call per episode: the whole tracklist and the whole transcript go in
 * together, because which record a remark belongs to is only decidable from
 * the order of the two lists. Anything the adapter throws propagates, so the
 * runner records `error` + `failed_step` on this episode alone and the rest
 * of the run carries on.
 */
export const extract = {
  name: 'extract',
  target: 'extracted',
  async run(ctx, row) {
    const guid = row.guid;
    if (!ctx.llm) throw new Error(`${guid}: no LLM adapter configured`);

    const stored = ctx.db.prepare(SELECT_TRANSCRIPT).get(guid);
    if (stored === undefined) {
      throw new Error(`${guid}: no transcript; run --step transcribe first`);
    }
    const segments = JSON.parse(stored.segments ?? 'null');
    if (!Array.isArray(segments)) throw new Error(`${guid}: transcript is not a list of segments`);

    const tracks = ctx.db.prepare(SELECT_TRACKS).all(guid);
    const positions = tracks.map((track) => track.position);

    // An episode with no tracklist, or one whose transcript came back empty,
    // has nothing to ground a note in. It costs no call and still advances.
    const asked = tracks.length > 0 && segments.length > 0;
    let entries = blank(positions);
    let episodeTags = [];
    let unanswered = 0;
    if (asked) {
      const data = await ctx.llm.call({
        step: 'extract',
        guid,
        prompt: notesPrompt({ title: row.title, tracks, segments }),
        schema: notesSchema(positions),
      });
      ({ entries, episodeTags, unanswered } = pickNotes(data, positions, segments.length));
    }

    ctx.db.exec('BEGIN');
    try {
      const update = ctx.db.prepare(UPDATE_TRACK);
      for (const entry of entries) {
        update.run(
          entry.note_spoken,
          entry.genre_raw,
          JSON.stringify(entry.tags),
          entry.intro_segment,
          guid,
          entry.position,
        );
      }
      ctx.db.prepare(UPDATE_EPISODE).run(JSON.stringify(episodeTags), guid);
      ctx.db.exec('COMMIT');
    } catch (err) {
      ctx.db.exec('ROLLBACK');
      throw err;
    }

    const noted = entries.filter((entry) => entry.note_spoken !== null).length;
    const intros = entries.filter((entry) => entry.intro_segment !== null).length;
    if (asked) {
      const counted = `extract ${tracks.length} tracks, ${noted} noted, ${intros} intros`;
      const missing = unanswered > 0 ? `, ${unanswered} unanswered` : '';
      ctx.log(`${guid}: ${counted}, ${episodeTags.length} episode tags${missing}`);
    } else {
      ctx.log(`${guid}: extract ${tracks.length} tracks, skipped`);
    }

    return { tracks: tracks.length, noted, intros, unanswered };
  },
};
