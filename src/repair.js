/**
 * The first use of the LLM adapter: the tracklist entries the deterministic
 * parser could not read.
 *
 * Only the flagged rows are sent, and only their raw text — the model is
 * asked to read the notation the host actually used, not to know the music.
 * Positions come from the deterministic pass and are echoed back so the merge
 * can key on them; nothing here invents a row.
 */

/** The six columns `parse` owns, plus the position they merge back on. */
export const REPAIR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['entries'],
  properties: {
    entries: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['position', 'artist', 'track', 'album', 'label', 'country', 'format'],
        properties: {
          position: { type: 'integer' },
          artist: { type: ['string', 'null'] },
          track: { type: ['string', 'null'] },
          album: { type: ['string', 'null'] },
          label: { type: ['string', 'null'] },
          country: { type: ['string', 'null'] },
          format: { enum: ['LP', 'MLP', 'SP', 'EP', null] },
        },
      },
    },
  },
};

const NOTATION = 'Artist (Country) — «Track» FORMAT *ALBUM* (Label)';

const RULES = [
  '- Keep the original language and spelling exactly as written. Translate nothing,',
  '  transliterate nothing, correct nothing.',
  '- Use null for any field the line does not contain. Never invent a value and',
  '  never guess one from your own knowledge of the record.',
  '- FORMAT is one of LP, MLP, SP, EP, or null.',
  '- Answer for every position listed below, using the same position numbers.',
];

/**
 * The prompt for one episode. `entries` are the flagged rows, and only their
 * `position`, `raw` and `parse_warning` are ever printed: an entry that
 * parsed cleanly never reaches the model.
 */
export function repairPrompt(entries) {
  const listed = [];
  for (const entry of entries) {
    listed.push(`position ${entry.position} (${entry.parse_warning}): ${entry.raw}`);
  }
  return [
    'These are entries from the tracklist of a Russian music radio show, written',
    `by hand in the notation ${NOTATION},`,
    'where the bracketed codes after each position say which fields a parser could',
    'not read. Split each line into its fields.',
    '',
    RULES.join('\n'),
    '',
    listed.join('\n'),
  ].join('\n');
}

/**
 * The reply entries worth merging: the ones for a position that was actually
 * sent, one per position, the last repeat winning. Anything else the model
 * returned — an invented position, a duplicate — is dropped here rather than
 * reaching the database.
 */
export function pickRepairs(data, positions) {
  const wanted = new Set(positions);
  const picked = new Map();
  for (const entry of data?.entries ?? []) {
    if (wanted.has(entry.position)) picked.set(entry.position, entry);
  }
  return [...picked.values()];
}
