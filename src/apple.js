import { get } from './http.js';

/**
 * Apple Music ids through the public iTunes Search API (no key, no login,
 * paced by src/http.js), always in the Dutch storefront. A track's URL is
 * built from its id: https://music.apple.com/song/<id>.
 *
 * A song search finds most tracks. When it doesn't, the artist is found by
 * name and their catalog looked up by id: the search index misses whole
 * releases (Geordie Greep's 2024 album) and returns at most a top slice.
 */

const STORE = 'nl';
const CATALOG_LIMIT = 200;
const NOT_FOUND = { apple_id: null, year: null, genres: [] };

/** How each lookup ended, for the run's summary line. */
export const appleStats = { search: 0, catalog: 0, near: 0, missed: 0 };

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
function plain(text) {
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

/** The first credited name, so "A ft B", "A & B" and "A and B" all compare as A. */
function lead(artist) {
  const first = (artist ?? '').split(/\s+(?:ft\.?|feat\.?|featuring|with|vs\.?|and|&|и)\s+|\s*[/,;]\s*/i)[0];
  return plain(first).replace(/^the\s+/, '');
}

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
function close(a, b, ratio) {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 5) return false;
  return distance(a, b) <= Math.floor(ratio * Math.max(a.length, b.length));
}

const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10, xi: 11, xii: 12 };

/** The numbers in a plain title, Roman numerals read as digits: "pt ii" and "part 2" both give "2". */
function numbers(title) {
  return title
    .split(' ')
    .map((word) => (/^\d+$/.test(word) ? String(Number(word)) : ROMAN[word] ? String(ROMAN[word]) : null))
    .filter(Boolean)
    .sort()
    .join(',');
}

/** A near title: a typo or spelling variant, never a different part ("1" against "IV"). */
const nearTitle = (a, b) => close(a, b, 0.2) && numbers(a) === numbers(b);

/** A live, demo, edited or remixed version, as its title or album says. */
const NOT_STUDIO = /\b(live|demo|edit|remix|mix|instrumental|acoustic|karaoke|session|rehearsal)\b/i;
const isStudio = (r) => !NOT_STUDIO.test(r.trackName ?? '') && !/\blive\b/i.test(r.collectionName ?? '');

const sameArtist = (host, apple) => {
  const a = lead(host);
  const b = lead(apple);
  return a !== '' && b !== '' && close(a, b, 0.2);
};

async function itunes(path, params) {
  const query = new URLSearchParams({ ...params, country: STORE });
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

/**
 * The best version among `results` for this track: the host's artist, and
 * the same title, or failing that a near one. The id is a studio version on
 * the host's album when Apple has one (else any version there: a live album
 * stays live), else the earliest studio version, else the earliest of any kind. The year is the song's first release: the earliest
 * of all its versions, so an original album beats its reissues.
 */
function pick(results, { artist, track, album }) {
  const title = plain(track);
  const songs = results.filter((r) => r.kind === 'song' && sameArtist(artist, r.artistName));
  let versions = songs.filter((r) => plain(r.trackName) === title);
  const near = versions.length === 0;
  if (near) versions = songs.filter((r) => nearTitle(plain(r.trackName), title));
  if (versions.length === 0) return null;

  const byDate = [...versions].sort((a, b) => (a.releaseDate ?? '9999').localeCompare(b.releaseDate ?? '9999'));
  const onAlbum = byDate.filter((r) => plain(r.collectionName) === plain(album));
  const chosen = onAlbum.find(isStudio) ?? onAlbum[0] ?? byDate.find(isStudio) ?? byDate[0];
  const earliest = byDate[0].releaseDate;
  return {
    near,
    found: {
      apple_id: chosen.trackId,
      year: earliest ? Number(earliest.slice(0, 4)) : null,
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
  const term = `${track.artist.split(/\s+(?:ft\.?|feat\.?|featuring)\s+/i)[0]} ${track.track}`;
  let match = pick(await itunes('search', { term, entity: 'song', limit: '50' }), track);
  let via = 'search';
  if (!match) {
    const songs = [];
    for (const id of await findArtists(track.artist.split(/\s+(?:ft\.?|feat\.?|featuring)\s+/i)[0])) {
      songs.push(...(await catalog(id)));
    }
    match = pick(songs, track);
    via = 'catalog';
  }
  if (!match) {
    appleStats.missed++;
    return NOT_FOUND;
  }
  appleStats[match.near ? 'near' : via]++;
  return match.found;
}
