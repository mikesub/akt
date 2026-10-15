import { get } from './http.js';
import { bare, close, lead, main, nearTitles, plain, sameAlbum, sameArtist, sameTitle, squash } from './match.js';

/**
 * Apple Music ids through the public iTunes Search API (no key, no login,
 * paced by src/http.js), always in the Dutch storefront, in English
 * (`lang=en_us`; without it some names come in Dutch). A track's URL is
 * built from its id: https://music.apple.com/song/<id>, and its album's and
 * artist's the same way (/album/<id>, /artist/<id>; see findAppleLinks).
 *
 * A song search finds most tracks. When it doesn't, or finds only a live,
 * demo or remixed version, the artist is found by name and their catalog
 * looked up by id: the search index misses whole releases (Geordie Greep's
 * 2024 album) and returns at most a top slice. Failing both, the host's
 * album is found by its title and the song looked for in it.
 */

const STORE = 'nl';
const LANG = 'en_us';
const CATALOG_LIMIT = 200;
const LOOKUP_BATCH = 150; // ids per lookup call; the API takes about 200
const NOT_FOUND = { apple_id: null, year: null };

/** How each lookup ended, for the run's summary line. */
export const appleStats = { search: 0, catalog: 0, album: 0, near: 0, missed: 0 };

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
    },
  };
}

/**
 * The track on the host's album, for a song Apple credits otherwise (Mo'Ju
 * for Mojo Juju, a band filed under its album's name): the album found by
 * its title, the song in it by the host's title. Its year counts only on an
 * album by the host's artist: Apple marks no compilation as one.
 */
async function fromAlbum({ artist, track, album }) {
  if (!album) return null;
  const albums = await itunes('search', { term: `${main(artist)} ${album}`, entity: 'album', limit: '25' });
  const found = albums.find((a) => sameAlbum(album, a.collectionName));
  if (!found) return null;
  const songs = await itunes('lookup', { id: String(found.collectionId), entity: 'song' });
  const song = songs.find((r) => r.wrapperType === 'track' && sameTitle(track, r.trackName));
  if (!song) return null;
  const own = sameArtist(artist, found.artistName) || sameArtist(artist, song.artistName);
  return {
    apple_id: song.trackId,
    year: own ? yearOf(song) : null,
  };
}

/** The Apple Music id and year for one track, both empty when nothing matches. */
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
    const found = await fromAlbum(track);
    appleStats[found ? 'album' : 'missed']++;
    return found ?? NOT_FOUND;
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
 * The album and artist ids for every track with an Apple Music link and none
 * yet, by id in batches: a Map from track to `{ apple_album_id,
 * apple_artist_id }`. Each only where Apple's name is the host's, else null:
 * a song found on a single or a compilation links no album, and "A & B"
 * links no artist when Apple's artist page is A's alone.
 */
export async function findAppleLinks(tracks) {
  const want = tracks.filter((track) => track.apple_id && !('apple_album_id' in track));
  if (want.length === 0) return new Map();
  const songs = await lookupSongs(want.map((track) => track.apple_id));
  const artists = new Map();
  const ids = [...new Set([...songs.values()].map((song) => song.artistId).filter(Boolean))];
  for (let i = 0; i < ids.length; i += LOOKUP_BATCH) {
    for (const r of await itunes('lookup', { id: ids.slice(i, i + LOOKUP_BATCH).join(',') })) {
      if (r.wrapperType === 'artist') artists.set(r.artistId, r.artistName);
    }
  }
  // The whole credit against the artist page's own name, guests after "ft" aside.
  const sameCredit = (host, page) => page !== undefined && close(squash(bare(main(host))), squash(bare(page)), 0.2);
  return new Map(
    want.map((track) => {
      const song = songs.get(track.apple_id);
      return [
        track,
        {
          apple_album_id: song && sameAlbum(track.album, song.collectionName) ? song.collectionId : null,
          apple_artist_id: song && sameCredit(track.artist, artists.get(song.artistId)) ? song.artistId : null,
        },
      ];
    }),
  );
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
