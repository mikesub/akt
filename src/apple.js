import { get } from './http.js';

/**
 * Apple Music ids through the public iTunes Search API (no key, no login,
 * paced by src/http.js), always in the Dutch storefront with English names
 * for genres (`lang=en_us`; without it they come in Dutch). A track's URL is
 * built from its id: https://music.apple.com/song/<id>.
 *
 * A song search finds most tracks. When it doesn't, or finds only a live,
 * demo or remixed version, the artist is found by name and their catalog
 * looked up by id: the search index misses whole releases (Geordie Greep's
 * 2024 album) and returns at most a top slice.
 */

const STORE = 'nl';
const LANG = 'en_us';
const CATALOG_LIMIT = 200;
const LOOKUP_BATCH = 150; // ids per lookup call; the API takes about 200
const NOT_FOUND = { apple_id: null, year: null, genres: [] };

/** How each lookup ended, for the run's summary line. */
export const appleStats = { search: 0, catalog: 0, near: 0, missed: 0, relinked: 0 };

const CYRILLIC = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l',
  м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch',
  ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', і: 'i', ї: 'yi', є: 'ye', ґ: 'g', ў: 'u',
};

/**
 * Lowercase Latin letters and digits only: Cyrillic transliterated (the Dutch
 * store lists Звуки Му as Zvuki Mu), accents, punctuation and a bracketed or
 * "- Remastered"-style suffix dropped.
 */
export function plain(text) {
  return [...(text ?? '').toLowerCase()]
    .map((c) => CYRILLIC[c] ?? c)
    .join('')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/\s[([].*$/, '')
    .replace(/\s[-–—]\s.*\b(remaster(ed)?|version|mix|edit|mono|stereo|live)\b.*$/, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** The credit without its guests: "A ft B" is A. */
export const main = (artist) => (artist ?? '').split(/\s+(?:ft\.?|feat\.?|featuring)\s+/i)[0].trim();

/** Each name a credit lists, as written: "A & B", "A and B", "A / B", "A, B" and "A + B" are A and B. */
export const credited = (artist) =>
  (artist ?? '').split(/\s+(?:ft\.?|feat\.?|featuring|with|vs\.?|and|&|и|\+)\s+|\s*[/,;]\s*/i).filter((name) => name.trim());

/** A credited name for comparing: plain, without a leading "The". */
const bare = (name) => plain(name).replace(/^the\s+/, '');

/** The first credited name, so "A ft B", "A & B" and "A and B" all compare as A. */
export const lead = (artist) => bare(credited(artist)[0]);

function distance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    row = next;
  }
  return row[b.length];
}

/** Equal, or close enough for a typo or a transliteration variant. Never for short names. */
export function close(a, b, ratio) {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 5) return false;
  return distance(a, b) <= Math.floor(ratio * Math.max(a.length, b.length));
}

const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10, xi: 11, xii: 12 };
const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };

/** A word read as a number ("2", "ii", "two" are all "2"), else null. */
const numberOf = (word) => (/^\d+$/.test(word) ? String(Number(word)) : String(ROMAN[word] ?? WORDS[word] ?? '') || null);

/** The numbers in a plain title: "pt ii", "part 2" and "part two" all give "2". */
function numbers(title) {
  return title.split(' ').map(numberOf).filter(Boolean).sort().join(',');
}

/**
 * A plain title with its numbers as digits, "pt" as "part" and no leading
 * "the": "pt 1" and "part one" read the same, as do "The House of the Rising
 * Sun" and "House of the Rising Sun".
 */
const counted = (title) =>
  title
    .replace(/^the\s+/, '')
    .split(' ')
    .map((word) => (word === 'pt' ? 'part' : (numberOf(word) ?? word)))
    .join(' ');

/** A near title: a typo or spelling variant, never a different part ("1" against "IV"). */
export const nearTitle = (a, b) => close(a, b, 0.2) && numbers(a) === numbers(b);

/**
 * The plain forms a source's title can match: the whole title, without its
 * bracketed words ("(Rope) Away"), and each half of a bilingual one
 * ("Черные Цветы / Chernye Cvety"), but not of a medley ("Sugar Baby /
 * Kriminaltango"), whose halves are different songs.
 */
function forms(title) {
  const forms = [plain(title), plain((title ?? '').replace(/\s*[([][^)\]]*[)\]]\s*/g, ' '))];
  const halves = (title ?? '').split(/\s+\/\s+/).map(plain);
  if (halves.length === 2 && close(halves[0], halves[1], 0.3)) forms.push(...halves);
  return [...new Set(forms)].filter(Boolean);
}

const squash = (text) => text.replaceAll(' ', '');

/** The host's title and a source's are the same, spaces and spelled numbers aside ("Kriminal Tango", "Kriminaltango"). */
export const sameTitle = (host, other) =>
  forms(other).some((form) => squash(counted(form)) === squash(counted(plain(host))));

/** The host's title and a source's are near (see nearTitle). */
export const nearTitles = (host, other) => forms(other).some((form) => nearTitle(counted(plain(host)), counted(form)));

/**
 * Album titles compare like song titles, spaces aside ("In Flux", "inFLUX"),
 * and with or without a subtitle after a dash ("Nouse Luonto - Lauluja Monimuotoisuudesta").
 */
export const sameAlbum = (host, other) => {
  const want = squash(plain(host));
  if (want === '') return false;
  return [other, (other ?? '').split(/\s[-–—]\s/)[0]].some((title) => squash(plain(title)) === want);
};

/**
 * The same artist: the host's first credited name is one of the source's, or
 * the source's first is one of the host's (guests after "ft" aside), so
 * "Janis Joplin / Big Brother & The Holding Company" and "Big Brother & The
 * Holding Company & Janis Joplin" match, and a typo or transliteration passes.
 */
export const sameArtist = (host, other) => {
  const hosts = credited(main(host)).map(bare).filter(Boolean);
  const others = credited(main(other)).map(bare).filter(Boolean);
  if (hosts.length === 0 || others.length === 0) return false;
  return others.some((name) => close(hosts[0], name, 0.2)) || hosts.some((name) => close(name, others[0], 0.2));
};

/** A live, demo, edited or remixed version, as its title or album says. */
const NOT_STUDIO = /\b(live|demo|edit|remix|mix|instrumental|acoustic|karaoke|session|rehearsal)\b/i;
const isStudio = (r) => !NOT_STUDIO.test(r.trackName ?? '') && !/\blive\b/i.test(r.collectionName ?? '');

async function itunes(path, params) {
  const query = new URLSearchParams({ ...params, country: STORE, lang: LANG });
  return (await get(`https://itunes.apple.com/${path}?${query}`))?.results ?? [];
}

const artistIds = new Map();
const catalogs = new Map();

/** Apple artist ids whose name matches, searched once per name and run. */
async function findArtists(name) {
  const key = lead(name);
  if (!artistIds.has(key)) {
    const found = await itunes('search', { term: name, entity: 'musicArtist', limit: '10' });
    artistIds.set(key, found.filter((a) => sameArtist(name, a.artistName)).slice(0, 3).map((a) => a.artistId));
  }
  return artistIds.get(key);
}

/** An artist's songs, looked up once per artist id and run. */
async function catalog(artistId) {
  if (!catalogs.has(artistId)) {
    const found = await itunes('lookup', { id: String(artistId), entity: 'song', limit: String(CATALOG_LIMIT) });
    catalogs.set(artistId, found.filter((r) => r.wrapperType === 'track'));
  }
  return catalogs.get(artistId);
}

/** A release year Apple actually knows: it dates some old recordings 1900-01-01. */
const yearOf = (r) => {
  const year = Number(r.releaseDate?.slice(0, 4));
  return year > 1900 ? year : null;
};

/**
 * The best version among `results` for this track: the host's artist, and
 * the same title, or a near one. The id is, with the same title, a studio
 * version on the host's album when Apple has one (else any version there: a
 * live album stays live), else the earliest studio version; failing both,
 * the same with a near title; else the earliest version of any kind. The
 * year is the song's first release: the earliest of its same-title versions,
 * so an original album beats its reissues.
 */
function pick(results, { artist, track, album }) {
  const songs = results.filter((r) => r.kind === 'song' && sameArtist(artist, r.artistName));
  const byDate = (list) => [...list].sort((a, b) => (a.releaseDate ?? '9999').localeCompare(b.releaseDate ?? '9999'));
  const exact = byDate(songs.filter((r) => sameTitle(track, r.trackName)));
  const near = byDate(songs.filter((r) => !sameTitle(track, r.trackName) && nearTitles(track, r.trackName)));
  if (exact.length + near.length === 0) return null;

  const best = (list) => {
    const onAlbum = list.filter((r) => sameAlbum(album, r.collectionName));
    return onAlbum.find(isStudio) ?? onAlbum[0] ?? list.find(isStudio);
  };
  const chosen = best(exact) ?? best(near) ?? exact[0] ?? near[0];
  const years = [...(exact.length > 0 ? exact : near), chosen].map(yearOf).filter(Boolean);
  return {
    near: !exact.includes(chosen),
    weak: !isStudio(chosen) && !sameAlbum(album, chosen.collectionName),
    found: {
      apple_id: chosen.trackId,
      year: years.length > 0 ? Math.min(...years) : null,
      genres: chosen.primaryGenreName ? [chosen.primaryGenreName] : [],
    },
  };
}

/** The Apple Music id, year and genres for one track, all empty when nothing matches. */
export async function findOnApple(track) {
  if (!track.artist || !track.track) {
    appleStats.missed++;
    return NOT_FOUND;
  }
  const searched = await itunes('search', { term: `${main(track.artist)} ${track.track}`, entity: 'song', limit: '50' });
  let match = pick(searched, track);
  let via = 'search';
  // Nothing, or only a live, demo or remixed version: the catalog may have the studio one.
  if (!match || match.weak) {
    const songs = [...searched];
    for (const id of await findArtists(main(track.artist))) songs.push(...(await catalog(id)));
    const better = pick(songs, track);
    if (better && (!match || !better.weak)) {
      match = better;
      via = 'catalog';
    }
  }
  if (!match) {
    appleStats.missed++;
    return NOT_FOUND;
  }
  appleStats[match.near ? 'near' : via]++;
  return match.found;
}

/** Apple's songs by id, in batches: a Map from id to its lookup result. Ids Apple no longer has are absent. */
export async function lookupSongs(ids) {
  const songs = new Map();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += LOOKUP_BATCH) {
    for (const r of await itunes('lookup', { id: unique.slice(i, i + LOOKUP_BATCH).join(',') })) {
      if (r.wrapperType === 'track') songs.set(r.trackId, r);
    }
  }
  return songs;
}

/**
 * Why a stored link looks wrong, or null when it looks right: the song is
 * gone from the store, by another artist, under another title, or a live,
 * demo or remixed version that is not on the host's album.
 */
export function doubtLink(track, song) {
  if (!song) return 'gone from the store';
  if (!sameArtist(track.artist, song.artistName)) return `by ${song.artistName}`;
  if (!sameTitle(track.track, song.trackName) && !nearTitles(track.track, song.trackName)) return `titled ${song.trackName}`;
  if (!isStudio(song) && !sameAlbum(track.album, song.collectionName)) return `a version: ${song.trackName} [${song.collectionName}]`;
  return null;
}
