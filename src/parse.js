import { askClaude } from './llm.js';

/** Every track field, in the order they are stored. */
const FIELDS = ['artist', 'track', 'album'];

const TEXT = { type: ['string', 'null'] };

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['tracks'],
  properties: {
    tracks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: FIELDS,
        properties: Object.fromEntries(FIELDS.map((field) => [field, TEXT])),
      },
    },
  },
};

const PROMPT = `Below is the HTML description of one episode of a Russian music radio show. It contains a tracklist written by hand, usually in the notation
  N. Artist (Country) — «Track» FORMAT *ALBUM* (Label)
where FORMAT is LP, MLP, SP or EP. Older episodes may omit the numbers, or put "FORMAT Album (Label)" on the line below the entry. Extract one row per tracklist entry, in order.

- artist: without the parenthesised country after it.
- track: the quoted title, without the quotes.
- album: without the format before it, the asterisks around it and the parenthesised label after it.
- "Ibid" in the artist or album position means "same as the previous entry": copy the previous entry's artist or album.
- Copy every value exactly as written: keep the language and spelling, translate nothing, correct nothing. Use null for anything the entry does not contain. Ignore the legal disclaimer, the intro and the host's comments between entries.

HTML:
`;

/** One episode description to its tracks, in tracklist order, read by `claude` in one call. */
export async function parseTracklist(description) {
  if (!description) return [];
  const { tracks } = await askClaude(PROMPT + description, SCHEMA);
  return tracks.map((track) => Object.fromEntries(FIELDS.map((field) => [field, track[field]])));
}
