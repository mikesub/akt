/**
 * Deterministic tracklist parser for the episode descriptions in the feed.
 *
 * Two pure stages, no I/O and no LLM: `normalizeDescription` turns the raw
 * HTML into clean text lines, `parseTracklist` turns those lines into track
 * rows. The markup changed twice over the life of the feed, so field
 * extraction slices an entry left to right — number, quoted track, country
 * before it, format after it, label last — instead of matching one big
 * regex. A slice that finds nothing degrades to a `parse_warning` rather
 * than losing the row: issue 2 repairs the residue with an LLM, and it can
 * only repair rows that exist.
 */

/** Tags that end a line. Everything else is dropped without a trace. */
const BLOCK_TAG = /<\s*\/?\s*(?:br|p|li|div|h[1-6])\s*\/?\s*>/gi;
const ANY_TAG = /<[^>]*>/g;

const ENTITY = /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z]+));/g;

/** The named entities this feed actually uses. Unknown names are left alone. */
const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  laquo: '«',
  raquo: '»',
  mdash: '—',
  ndash: '–',
  hellip: '…',
};

/** Every description opens with the mandatory foreign-agent paragraph. */
const DISCLAIMER = /ИНОСТРАНН\S* АГЕНТ/iu;

/** `1.` or `13)` at the start of a line. */
const NUMBERED_ENTRY = /^(\d{1,2})[.)]\s*/;

/**
 * The earliest episodes number nothing, so an entry is recognised by shape
 * alone: an artist, a bracketed country, an optional dash and a quote.
 */
const UNNUMBERED_ENTRY = /^[^«"»]+\([^()]+\)\s*[—–-]?\s*[«"]/;

/**
 * `MLP` is a mini-LP and appears once in the archive; without it the token
 * would be read as part of the album title.
 */
const FORMAT = /^(M?LP|SP|EP)\b\s*/i;
const FORMAT_ANYWHERE = /\b(?:M?LP|SP|EP)\b/i;

/** `Ibid`, optionally starred or full-stopped, means "same as the previous". */
const IBID = /^\*?\s*ibid\s*\*?\.?$/i;

const CHERISHED = /заветн/iu;

/**
 * Warning codes in report order. `parse_warning` is the comma-joined subset
 * that applies, so a row's flags read the same way every run.
 */
export const PARSE_WARNINGS = [
  'no_track',
  'no_country',
  'no_format',
  'no_album',
  'no_label',
  'ibid_orphan',
  'number_mismatch',
];

/**
 * The codes that name a field the parser could not read, and the column each
 * one names. The rest of `PARSE_WARNINGS` record something about the entry
 * that re-reading its line cannot settle — the host miscounted, or an `Ibid`
 * has nothing before it to inherit from — so the LLM fallback is neither
 * asked about them nor allowed to clear them.
 */
export const FIELD_WARNINGS = {
  no_track: 'track',
  no_country: 'country',
  no_format: 'format',
  no_album: 'album',
  no_label: 'label',
};

/**
 * Raw `description_raw` to ordered, clean text lines.
 *
 * Tags go first so that entities can never produce one, then entities, then
 * the typographic characters the host's editor inserts: non-breaking and
 * zero-width spaces, and the several kinds of double and single quote. `«»`
 * and the dashes are left exactly as written — they are Russian typography,
 * not noise, and the site displays them.
 */
export function normalizeDescription(html) {
  if (html === null || html === undefined) return [];

  const decoded = String(html)
    .replace(BLOCK_TAG, '\n')
    .replace(ANY_TAG, '')
    .replace(ENTITY, (match, decimal, hex, name) => {
      if (decimal !== undefined) return String.fromCodePoint(Number(decimal));
      if (hex !== undefined) return String.fromCodePoint(Number.parseInt(hex, 16));
      return Object.hasOwn(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name] : match;
    })
    .replace(/[\u00A0\u202F\u2007]/g, ' ')
    .replace(/[\u200B\uFEFF]/g, '')
    .replace(/[“”„‟]/g, '"')
    .replace(/[‘’‚‛]/g, "'");

  const lines = decoded
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line !== '');

  return lines.length > 0 && DISCLAIMER.test(lines[0]) ? lines.slice(1) : lines;
}

/** The last `(…)` group anywhere in the text, used for the country. */
function lastGroup(text) {
  let found = null;
  const groups = /\(([^()]*)\)/g;
  let match = groups.exec(text);
  while (match !== null) {
    found = { inner: match[1].trim(), before: text.slice(0, match.index) };
    match = groups.exec(text);
  }
  return found;
}

/**
 * The trailing `(…)` group, used for the label. It tolerates one level of
 * nesting so an album like `*STRIVE (OST)*` keeps its own parentheses, and a
 * full stop after the closing bracket.
 */
function trailingGroup(text) {
  const match = text.match(/\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*\.?\s*$/);
  return match ? { inner: match[1].trim(), before: text.slice(0, match.index).trim() } : null;
}

function isIbid(text) {
  return typeof text === 'string' && IBID.test(text.trim());
}

function stripStars(text) {
  return text.replace(/^\*|\*$/g, '').trim();
}

function stripLeadingDash(text) {
  return text.replace(/^[—–-]\s*/, '').trim();
}

function stripTrailingDash(text) {
  return text.replace(/[—–-]\s*$/, '').trim();
}

/** Whether a line opens an entry, in whichever mode this episode is in. */
function isEntry(line, numbered) {
  if (numbered) return NUMBERED_ENTRY.test(line);
  if (!UNNUMBERED_ENTRY.test(line)) return false;
  const closing = afterQuotedTrack(line);
  return closing !== null && FORMAT_ANYWHERE.test(closing.after);
}

/** Split at the first `«…»` / `"…"` pair; null when there is no pair. */
function afterQuotedTrack(text) {
  const open = text.search(/[«"]/);
  if (open === -1) return null;
  const tail = text.slice(open + 1);
  const close = tail.search(/[»"]/);
  if (close === -1) return null;
  return {
    head: text.slice(0, open).trim(),
    track: tail.slice(0, close).trim(),
    after: tail.slice(close + 1).trim(),
  };
}

/**
 * Artist, country and track from the part of an entry before the format.
 * With no quote pair there is nothing to anchor on, so the line is split at
 * its first dash and flagged; issue 2 gets to look at it.
 */
function readHead(text, warn) {
  const quoted = afterQuotedTrack(text);
  if (quoted === null) {
    warn.add('no_country');
    const dash = text.search(/[—–]/);
    const artist = (dash === -1 ? text : text.slice(0, dash)).trim() || null;
    const track = dash === -1 ? null : text.slice(dash + 1).trim() || null;
    if (track === null) warn.add('no_track');
    return { artist, country: null, track, after: '' };
  }

  const track = quoted.track || null;
  if (track === null) warn.add('no_track');
  const group = lastGroup(quoted.head);
  const inner = group === null ? '' : group.inner;
  const country = inner === '' ? null : inner;
  if (country === null) warn.add('no_country');
  return {
    artist: stripTrailingDash(group === null ? quoted.head : group.before) || null,
    country,
    track,
    after: quoted.after,
  };
}

/** Format, album and label from the `LP *ALBUM* (Label)` part of an entry. */
function readAlbum(text, previous, warn) {
  const matched = text.match(FORMAT);
  if (matched === null) warn.add('no_format');
  const format = matched === null ? null : matched[1].toUpperCase();
  const rest = matched === null ? text : text.slice(matched[0].length).trim();

  let album = null;
  let label = null;
  if (isIbid(rest)) {
    // `LP Ibid` means the compilation the previous entry already named.
    if (previous === null) {
      warn.add('ibid_orphan');
    } else {
      album = previous.album;
      label = previous.label;
    }
  } else if (rest !== '') {
    const trailing = trailingGroup(rest);
    label = trailing === null ? null : trailing.inner;
    album = stripStars(trailing === null ? rest : trailing.before) || null;
  }

  if (album === null) warn.add('no_album');
  if (label === null) warn.add('no_label');
  return { format, album, label };
}

/**
 * Ordered text lines to track rows.
 *
 * `position` is the ordinal among entries, never the printed number: the
 * host miscounts, and downstream steps key on position. Commentary and
 * section headers are both unnumbered lines, so position alone tells them
 * apart — the first line after an entry is that entry's commentary, anything
 * further is a header that applies until the next one.
 */
export function parseTracklist(lines) {
  const numbered = lines.some((line) => NUMBERED_ENTRY.test(line));
  const tracks = [];
  let section = null;
  let header = [];
  let sinceEntry = 0;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];

    if (!isEntry(line, numbered)) {
      // Lines before the first entry are the preamble («В этом выпуске:»).
      if (tracks.length === 0) continue;
      sinceEntry++;
      if (sinceEntry === 1) attachNote(tracks, line);
      else header.push(line);
      continue;
    }

    if (header.length > 0) {
      section = header.join(' ');
      header = [];
    }
    sinceEntry = 0;

    const warn = new Set();
    const printed = line.match(NUMBERED_ENTRY);
    let text = printed === null ? line : line.slice(printed[0].length);
    // What the host actually wrote, kept whole: the LLM fallback repairs a
    // flagged row from this and nothing else.
    let raw = line;
    if (printed !== null && Number(printed[1]) !== tracks.length + 1) warn.add('number_mismatch');

    const head = readHead(text, warn);
    let after = stripLeadingDash(head.after);
    // The older layout puts `LP Album (Label)` on the line below the entry.
    const next = lines[index + 1];
    if (after === '' && next !== undefined && FORMAT.test(next) && !isEntry(next, numbered)) {
      index++;
      after = lines[index];
      text += ` ${after}`;
      raw += ` ${after}`;
    }

    const previous = tracks[tracks.length - 1] ?? null;
    const album = readAlbum(after, previous, warn);

    let { artist, country } = head;
    if (isIbid(artist)) {
      if (previous === null) {
        warn.add('ibid_orphan');
      } else {
        artist = previous.artist;
        if (country === null) country = previous.country;
      }
    }

    tracks.push({
      position: tracks.length + 1,
      artist,
      country,
      track: head.track,
      format: album.format,
      album: album.album,
      label: album.label,
      section,
      is_cherished: CHERISHED.test(text),
      note_desc: null,
      parse_warning: PARSE_WARNINGS.filter((code) => warn.has(code)).join(',') || null,
      raw,
    });
  }

  return { tracks, warned: tracks.filter((row) => row.parse_warning !== null).length };
}

/**
 * One commentary line can cover two entries — the host writes it once after
 * the second of a pair — so it also fills a bare entry immediately before.
 */
function attachNote(tracks, line) {
  const cherished = CHERISHED.test(line);
  const current = tracks[tracks.length - 1];
  current.note_desc = line;
  if (cherished) current.is_cherished = true;

  const previous = tracks.at(-2);
  if (previous === undefined || previous.note_desc !== null) return;
  previous.note_desc = line;
  if (cherished) previous.is_cherished = true;
}
