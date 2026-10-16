import { askClaude } from './llm.js';

/** Every field `claude` reads for a track; `country` is stored as `printed_country`. */
const FIELDS = ['artist', 'track', 'album', 'country'];

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
- country: that parenthesised country, without the parentheses ("USA", "USA/Cambodia").
- track: the quoted title, without the quotes.
- album: without the format before it, the asterisks around it and the parenthesised label after it.
- "Ibid" in the artist or album position means "same as the previous entry": copy the previous entry's artist (and its country) or album.
- Copy every value exactly as written: keep the language and spelling, translate nothing, correct nothing. Use null for anything the entry does not contain. Ignore the legal disclaimer, the intro and the host's comments between entries.

HTML:
`;

const PLAYLIST_PROMPT = `Below is the playlist of one episode of a Russian music radio show, typed by hand and printed by its web page or podcast feed. Each entry is one track, numbered ("1.", "1", "01") or not, in one of these notations or close to them:
  N. Artist (Country). Title, FORMAT Album (Label)
  N. Artist (Country) - "Title" FORMAT "Album" (Label)
  N Artist (Country) "Title" FORMAT "Album" (Label)
  N. Artist (Country) Title FORMAT Album (Label)
  Artist (Country) - Title / альбом Album (label "Label")
  Artist (Country) - Title
FORMAT is LP, CD, EP, SP, MLP, single or the like (also in Cyrillic letters); the parts may be separated by a full stop, a comma, a dash, a colon, quotes or only a space, sometimes with no space at all, and any of them may be missing (the country, the title, the album, the label). Extract one row per entry, in order.

- artist: without the parenthesised country after it. A name such as "A & B", "A feat. B" or "A/B" is one artist value, as written.
- country: that parenthesised country, without the parentheses ("USA", "UK/Germany", "РФ"), even when it is a region or a city rather than a country.
- The entry number is not part of the artist, even with no space after it: "6Port Mone (Беларусь)" is entry 6 by Port Mone. Digits that do not continue the numbering belong to the name.
- track: the title, without quotes around it. The country is the parenthesised part right after the artist; one after the title is either the label (when there is no album) or part of the title, such as a subtitle or version ("Be Ki Don(Cockpit Dub)").
- album: without the format before it, the quotes or the word "альбом" before or around it, and the parenthesised label after it.
- A line with only "FORMAT Album (Label)" continues the entry above it: it is that entry's album, not a new entry.
- "Ibid" (also "ibid.", "Там же") in the artist or album position means "same as the previous entry": copy the previous entry's artist (and its country) or album. An entry that starts with "Ibid" followed directly by the title has the previous entry's artist.
- Copy every value exactly as written: keep the language, spelling and capitals (lowercase stays lowercase), translate nothing, correct nothing; only trim spaces and stray quotes at either end. Use null for anything the entry does not contain or only holds a place for ("...", "?").
- Ignore any header line and every line that is not an entry: a heading, a comment, a promo or subscription line. When the entries are numbered, a line without a number is either such a line or the continuation of the entry above it.

Playlist:
`;

const rows = (tracks) =>
  tracks.map(({ artist, track, album, country }) => ({ artist, track, album, printed_country: country }));

/** One episode description to its tracks, in tracklist order, read by `claude` in one call. */
export async function parseTracklist(description) {
  if (!description) return [];
  const { tracks } = await askClaude(PROMPT + description, SCHEMA);
  return rows(tracks);
}

/** One playlist file's text (src/playlists.js) to its tracks, the same way. */
export async function parsePlaylist(text) {
  if (!text) return [];
  const { tracks } = await askClaude(PLAYLIST_PROMPT + text, SCHEMA);
  return rows(tracks);
}

const COUNTRIES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['entries'],
  properties: {
    entries: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['n', 'country'],
        properties: { n: { type: 'integer' }, country: TEXT },
      },
    },
  },
};

const COUNTRIES_PROMPT = `Below is the playlist of one episode of a Russian music radio show, typed by hand and printed by its web page or podcast feed, and after it the entries already read from it, numbered in order. Most entries print the artist's country in parentheses right after the artist's name: "Pixies (USA). Head Carrier", "Вася Обломов (РФ) «Письмо счастья»", "DENGUE FEVER (USA/Cambodia) «Room 720»". For each numbered entry, give the country the playlist prints for it.

- country: the parenthesised part right after that entry's artist, without the parentheses, copied exactly as written: keep the language, spelling, capitals and abbreviations ("czech rep.", "UK/USA", "Тува"), translate nothing, correct nothing, even when it is a region, a city or a people rather than a country.
- A parenthesised part elsewhere is not the country: the label at the end of the entry, a version or subtitle after the title, a part of the artist's name.
- An entry whose artist is printed as "Ibid" (also "ibid.", "Там же") has the previous entry's country.
- null when the playlist prints no country for that entry. Never fill one in from what you know about the artist.
- One row per numbered entry, in order, with its number as n: exactly as many rows as there are entries.

Playlist:
`;

/**
 * The country a playlist prints for each of its tracks already parsed, as printed (null for none):
 * for tracks parsed before the parse read countries. One `claude` call, checked row for row.
 */
export async function readCountries(text, tracks) {
  const list = tracks.map((t, i) => `${i + 1}. ${t.artist ?? '?'} — ${t.track ?? '?'}${t.album ? ` (${t.album})` : ''}`).join('\n');
  const { entries } = await askClaude(`${COUNTRIES_PROMPT}${text}\n\nEntries:\n${list}\n`, COUNTRIES_SCHEMA);
  if (entries.length !== tracks.length || entries.some((e, i) => e.n !== i + 1)) {
    throw new Error(`claude gave ${entries.length} countries for ${tracks.length} tracks`);
  }
  return entries.map((e) => e.country?.trim() || null);
}
