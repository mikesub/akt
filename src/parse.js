import { askClaude } from './llm.js';

/** Every field `claude` reads for a track; `country` and `label` are stored as `printed_country` and `printed_label`. */
const FIELDS = ['artist', 'track', 'album', 'country', 'label'];

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
- label: that parenthesised label after the album, without the parentheses, every label it names as written ("Sub Pop / Bungalow").
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
- label: that parenthesised label at the end of the entry, after the album (or after the title when there is no album), without the parentheses and the word "label" or "лейбл" before it, every label it names as written ("Sub Pop / Bungalow", "No format/naive"). Not a version or subtitle after the title, not a part of the album's title ("(ost)", "(deluxe edition)"), not the host's comment after the entry.
- A line with only "FORMAT Album (Label)" continues the entry above it: it is that entry's album, not a new entry.
- "Ibid" (also "ibid.", "Там же", "Same") in the artist or album position means "same as the previous entry": copy the previous entry's artist (and its country) or album; "Same (Same)" is the previous entry's artist and country. An entry that starts with "Ibid" followed directly by the title has the previous entry's artist. A title "Same" is a title.
- Copy every value exactly as written: keep the language, spelling and capitals (lowercase stays lowercase), translate nothing, correct nothing; only trim spaces and stray quotes at either end. Use null for anything the entry does not contain or only holds a place for ("...", "?").
- Ignore any header line and every line that is not an entry: a heading, a comment, a promo or subscription line. When the entries are numbered, a line without a number is either such a line or the continuation of the entry above it.

Playlist:
`;

const rows = (tracks) =>
  tracks.map(({ artist, track, album, country, label }) => ({ artist, track, album, printed_country: country, printed_label: label }));

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

/** The reply of a read pass: one value a numbered entry. */
const entriesSchema = (field) => ({
  type: 'object',
  additionalProperties: false,
  required: ['entries'],
  properties: {
    entries: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['n', field],
        properties: { n: { type: 'integer' }, [field]: TEXT },
      },
    },
  },
});

const COUNTRIES_PROMPT = `Below is the playlist of one episode of a Russian music radio show, typed by hand and printed by its web page or podcast feed, and after it the entries already read from it, numbered in order. Most entries print the artist's country in parentheses right after the artist's name: "Pixies (USA). Head Carrier", "Вася Обломов (РФ) «Письмо счастья»", "DENGUE FEVER (USA/Cambodia) «Room 720»". For each numbered entry, give the country the playlist prints for it.

- country: the parenthesised part right after that entry's artist, without the parentheses, copied exactly as written: keep the language, spelling, capitals and abbreviations ("czech rep.", "UK/USA", "Тува"), translate nothing, correct nothing, even when it is a region, a city or a people rather than a country.
- A parenthesised part elsewhere is not the country: the label at the end of the entry, a version or subtitle after the title, a part of the artist's name.
- An entry whose artist is printed as "Ibid" (also "ibid.", "Там же") has the previous entry's country.
- null when the playlist prints no country for that entry. Never fill one in from what you know about the artist.
- One row per numbered entry, in order, with its number as n: exactly as many rows as there are entries.

Playlist:
`;

const LABELS_PROMPT = `Below is the playlist of one episode of a Russian music radio show, typed by hand and printed by its web page or podcast feed, and after it the entries already read from it, numbered in order. Most entries print the record label in parentheses at the end, after the album: 'Combustible Edison (USA) "Mr. Pushkin Came To Shore" CD "The Impossible World" (Sub Pop / Bungalow)', '1. Laibach (Slovenia)”AllGoRhythm” LP MUSICK (Mute).', '3 Džambo Aguevi Orchestra (Macedonia) "Tears" CD "Brass like it hot" (ARC)', 'Artist (Country) - Title / альбом Album (label "Label")'. For each numbered entry, give the label the playlist prints for it.

- label: the parenthesised part at the end of that entry, after its album (or after its title when it has no album), without the parentheses, the quotes around it and the word "label" or "лейбл" before it, copied exactly as written: keep the language, spelling, capitals and abbreviations, and every label it names ("Sub Pop / Bungalow", "No format/naive", "self-released"), translate nothing, correct nothing.
- A parenthesised part elsewhere is not the label: the country right after the artist, a version or subtitle after the title ("(Cockpit Dub)", "(live)"), a part of the album's title ("(ost)", "(deluxe edition)", "(EP)"), the host's comment after the label.
- An entry whose label is printed as "Ibid" (also "ibid.", "Там же", "Same") has the previous entry's label.
- null when the playlist prints no label for that entry. Never fill one in from what you know about the record.
- One row per numbered entry, in order, with its number as n: exactly as many rows as there are entries.

Playlist:
`;

/** One value `field` a track the playlist prints, as printed (null for none): one `claude` call, checked row for row. */
async function readEach(prompt, field, text, tracks) {
  const list = tracks.map((t, i) => `${i + 1}. ${t.artist ?? '?'} — ${t.track ?? '?'}${t.album ? ` (${t.album})` : ''}`).join('\n');
  const { entries } = await askClaude(`${prompt}${text}\n\nEntries:\n${list}\n`, entriesSchema(field));
  if (entries.length !== tracks.length || entries.some((e, i) => e.n !== i + 1)) {
    throw new Error(`claude gave ${entries.length} ${field} values for ${tracks.length} tracks`);
  }
  return entries.map((e) => e[field]?.trim() || null);
}

/**
 * The country a playlist prints for each of its tracks already parsed, as printed (null for none):
 * for tracks parsed before the parse read countries.
 */
export const readCountries = (text, tracks) => readEach(COUNTRIES_PROMPT, 'country', text, tracks);

/**
 * The label a playlist prints for each of its tracks already parsed, as printed (null for none):
 * for tracks parsed before the parse read labels (2026-11-12).
 */
export const readLabels = (text, tracks) => readEach(LABELS_PROMPT, 'label', text, tracks);
