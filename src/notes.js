/**
 * The second use of the LLM adapter: what the host actually said on air about
 * each track of one episode.
 *
 * The transcript is the only source for `note_spoken`. The written tracklist
 * goes into the prompt so the model knows which record each mention belongs
 * to, never so it can describe a track the host passed over in silence: a
 * track that was not discussed gets null, and null is also where every
 * uncertain answer lands on the way back (see `pickNotes`).
 *
 * `genre_raw` stays free text on purpose — mapping it to a canonical key is a
 * deterministic step of its own, and `genre` is not this step's column.
 */

/** The four `track` columns this step owns, plus the episode's own tags. */
export function notesSchema(positions) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['tracks', 'episode_tags'],
    properties: {
      tracks: {
        type: 'array',
        // Pinned to the tracklist that was sent: a reply that drops, pads or
        // renumbers a track is rejected by the adapter and asked for again,
        // rather than landing as half-filled rows.
        minItems: positions.length,
        maxItems: positions.length,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['position', 'note_spoken', 'genre_raw', 'tags', 'intro_segment'],
          properties: {
            position: { type: 'integer', enum: positions },
            note_spoken: { type: ['string', 'null'] },
            genre_raw: { type: ['string', 'null'] },
            tags: { type: 'array', items: { type: 'string' } },
            intro_segment: { type: ['integer', 'null'] },
          },
        },
      },
      episode_tags: { type: 'array', items: { type: 'string' } },
    },
  };
}

const RULES = [
  '- note_spoken: 1 to 3 sentences in Russian summarising only what the host says',
  '  in the transcript about that track. Keep the host’s own wording and',
  '  language; translate nothing. Use null when the transcript never mentions the',
  '  track, its artist or its record. Never fill it from the written description,',
  '  from the tracklist line, or from your own knowledge of the music.',
  '- genre_raw: the genre wording as it was actually expressed, in the written',
  '  description or on air («мрачный dream pop», «DarkWave»). Free text, in the',
  '  language it was said in, not normalised to any vocabulary. null when neither',
  '  says one.',
  '- tags: short lowercase English labels for facts and opinions the host stated,',
  '  in writing or on air — for example "personal best of 2025", "debut",',
  '  "reissue", "host’s favourite", "RIP" — plus "similar:<Artist>" for a',
  '  comparison, with the name written as it was written. [] when there are none.',
  '- intro_segment: the index of the transcript segment in which the host',
  '  introduces this track just before it plays, typically the last segment before',
  '  a jump in seconds. It is an index into the list below, never a second and',
  '  never a timestamp. null when you are not sure.',
  '- episode_tags: short English labels for the episode as a whole — for example',
  '  "special episode", "year review", "in memoriam". Whenever the tracklist has a',
  '  section header or the host announces a theme on air, include',
  '  "theme:<the theme, in the host’s own words>".',
  '- Answer every position listed below exactly once, using the same position',
  '  numbers. Add nothing, drop nothing, reorder nothing.',
];

const TRANSCRIPT_NOTE = [
  'The transcript covers speech only: it was made over the intervals a voice',
  'activity detector marked as speech, so a jump in seconds between two',
  'consecutive segments is a song being played in between. The host usually',
  'introduces a track just before it plays, and sometimes comments on it once it',
  'has ended.',
];

/** `1. Artist (Country) — «Track» *ALBUM* (Label)`, absent fields omitted. */
function trackLine(row) {
  const artist = [row.artist, row.country === null ? null : `(${row.country})`]
    .filter((part) => part !== null && part !== undefined)
    .join(' ');
  const record = [
    row.track === null ? null : `«${row.track}»`,
    row.album === null ? null : `*${row.album}*`,
    row.label === null ? null : `(${row.label})`,
  ]
    .filter((part) => part !== null && part !== undefined)
    .join(' ');
  const body = [artist, record].filter((part) => part !== '').join(' — ');
  return `${row.position}. ${body}`;
}

/** The tracklist as written, section headers and description notes labelled. */
function tracklistLines(tracks) {
  const lines = [];
  let section = null;
  for (const row of tracks) {
    if ((row.section ?? null) !== section) {
      section = row.section ?? null;
      if (section !== null) lines.push(`section: ${section}`);
    }
    lines.push(trackLine(row));
    if (row.note_desc) lines.push(`   description: ${row.note_desc}`);
  }
  return lines;
}

/** One line per segment: the index the answer keys on, and its start second. */
function transcriptLines(segments) {
  return segments.map(
    (segment, index) => `[${index} @ ${Math.round(segment.start)}s] ${segment.text}`,
  );
}

/**
 * The prompt for one episode: its whole tracklist and its whole transcript,
 * in one call rather than one per track, so the model can tell which mention
 * belongs to which record and where one track's commentary ends.
 */
export function notesPrompt({ title, tracks, segments }) {
  return [
    'This is one episode of «Стереоплан Троицкого», a Russian music radio show:',
    'its tracklist, taken from the written episode description, and the transcript',
    'of what the host said on air. Summarise what the host said about each track.',
    '',
    `Episode: ${title}`,
    '',
    RULES.join('\n'),
    '',
    'TRACKLIST (in play order, from the written description):',
    tracklistLines(tracks).join('\n'),
    '',
    'TRANSCRIPT (one line per segment, as [index @ start second] text):',
    TRANSCRIPT_NOTE.join('\n'),
    '',
    transcriptLines(segments).join('\n'),
  ].join('\n');
}

/** '' and a non-string are the same thing here: nothing was said. */
function text(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Trimmed, empties dropped, de-duplicated in first-seen order. */
function tags(value) {
  if (!Array.isArray(value)) return [];
  const kept = [];
  for (const tag of value) {
    const label = text(tag);
    if (label !== null && !kept.includes(label)) kept.push(label);
  }
  return kept;
}

/** An index into the segments that were sent, or null. Never a second. */
function segmentIndex(value, segmentCount) {
  if (!Number.isInteger(value)) return null;
  return value >= 0 && value < segmentCount ? value : null;
}

/**
 * The reply as this step will write it: one entry per position that was sent,
 * in the order they were sent. An invented position is dropped, a repeated
 * one keeps its last answer, and a position the reply skipped becomes an
 * all-null row and is counted in `unanswered`. Everything the schema cannot
 * express degrades towards null rather than towards a guess.
 */
export function pickNotes(data, positions, segmentCount) {
  const wanted = new Set(positions);
  const picked = new Map();
  for (const entry of data?.tracks ?? []) {
    if (wanted.has(entry?.position)) picked.set(entry.position, entry);
  }

  let unanswered = 0;
  const entries = positions.map((position) => {
    const entry = picked.get(position);
    if (entry === undefined) {
      unanswered++;
      return { position, note_spoken: null, genre_raw: null, tags: [], intro_segment: null };
    }
    return {
      position,
      note_spoken: text(entry.note_spoken),
      genre_raw: text(entry.genre_raw),
      tags: tags(entry.tags),
      intro_segment: segmentIndex(entry.intro_segment, segmentCount),
    };
  });

  return { entries, episodeTags: tags(data?.episode_tags), unanswered };
}
