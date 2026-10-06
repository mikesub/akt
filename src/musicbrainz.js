import { close, credited, lead, main, nearTitles, plain, sameAlbum, sameArtist, sameTitle } from './apple.js';
import { get } from './http.js';

/**
 * The original release year and genres of a track from MusicBrainz (no key,
 * no login, paced by src/http.js at its one request a second).
 *
 * A recording search by title and artist; a result counts only when one of
 * its credited artists is the host's (by name or one of MusicBrainz's
 * aliases, Cyrillic as stored or transliterated) and its title is the host's
 * (or, when none is, a near one). When the phrase search finds nothing, the
 * artist is searched by name and alias and their recordings searched by id.
 * A match is then searched for earlier recordings by the same artist ids
 * (any credit, any punctuation). Anything less certain is "not found": no
 * guessing. Two to four requests a track, fewer for an artist or album
 * already seen in the run.
 *
 * The year is the earliest first release among the matching studio
 * recordings (live, demo and remixed ones left out): MusicBrainz keeps each
 * recording once with every release it is on, so a reissue does not hide the
 * original. Genres are MusicBrainz's genres (not free-form tags), the top
 * few by votes, from the recording, else its album, else the artist.
 */

const API = 'https://musicbrainz.org/ws/2';
const LIMIT = 100; // results per search, MusicBrainz's maximum
const TOP_GENRES = 3;
const NOT_FOUND = { mb_id: null, year: null, genres: [] };

/** How each lookup ended, for the run's summary line. */
export const mbStats = { search: 0, artist: 0, near: 0, missed: 0 };

/** A recording that is not the studio song: live, a demo, a remix, as its title or disambiguation says. */
const NOT_STUDIO = /\b(live|demo|remix|rmx|karaoke|rehearsal|re-?recording|instrumental)\b/i;
/** Release-group types whose recordings are not the studio song. */
const NOT_STUDIO_TYPES = new Set(['Live', 'Demo', 'Remix', 'DJ-mix']);

async function mb(path, params = {}) {
  return get(`${API}/${path}?${new URLSearchParams({ ...params, fmt: 'json' })}`);
}

/** Lucene: a quoted phrase, and loose words with every special character escaped. */
const phrase = (text) => `"${text.replace(/["\\]/g, '\\$&')}"`;
const words = (text) =>
  `(${text
    .replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, '\\$&')
    .replace(/\b(AND|OR|NOT)\b/g, (w) => w.toLowerCase())})`;

/** The host's title without bracketed words ("(Remix)", "(Вспомни) Люся"), as MusicBrainz is searched for it. */
const bareTitle = (title) => title.replace(/\s*[([][^)\]]*[)\]]\s*/g, ' ').trim() || title;

/** A recording search: its first page, and how many results there are in all. */
async function search(query) {
  const found = await mb('recording', { query, limit: String(LIMIT) });
  return { recordings: found?.recordings ?? [], count: found?.count ?? 0 };
}

const byIds = (ids) => `(${ids.map((id) => `arid:${id}`).join(' OR ')})`;

const artistIds = new Map();

/** MusicBrainz artist ids whose name or an alias is the host's first name, searched once per name and run. */
async function findArtists(name) {
  const key = lead(name);
  if (!artistIds.has(key)) {
    const found = (await mb('artist', { query: `artist:${phrase(name)} OR alias:${phrase(name)}`, limit: '10' }))?.artists ?? [];
    const ids = found.filter((a) => namesOf(a).some((n) => close(key, lead(n), 0.2))).map((a) => a.id);
    artistIds.set(key, ids.slice(0, 3));
  }
  return artistIds.get(key);
}

/** An artist's own name and aliases. */
const namesOf = (artist) => [artist?.name, ...(artist?.aliases ?? []).map((a) => a.name)].filter(Boolean);

/**
 * The credited artist ({id, name}) that is the host's, or null: the host's
 * first name against each credit's name, artist and aliases; or the credit
 * as a whole against the host's credit (see sameArtist), for "A / B" and the
 * like.
 */
function hostArtist(host, recording) {
  const credits = recording['artist-credit'] ?? [];
  const want = lead(host);
  const named = credits.find((c) => [c.name, ...namesOf(c.artist)].some((n) => close(want, lead(n), 0.2)));
  if (named) return named.artist;
  const joined = credits.map((c) => c.name + (c.joinphrase ?? '')).join('');
  return sameArtist(host, joined) ? credits[0]?.artist ?? null : null;
}

function isStudio(recording, host) {
  const hostTitle = host.track ?? '';
  if (NOT_STUDIO.test(recording.title ?? '') && !NOT_STUDIO.test(hostTitle)) return false;
  if (NOT_STUDIO.test(recording.disambiguation ?? '')) return false;
  const releases = recording.releases ?? [];
  if (releases.length === 0) return true;
  // Studio when at least one release is neither a bootleg nor a live, demo or remix release.
  return releases.some(
    (r) => r.status !== 'Bootleg' && !(r['release-group']?.['secondary-types'] ?? []).some((t) => NOT_STUDIO_TYPES.has(t)),
  );
}

const yearOf = (recording) => {
  const year = Number(recording['first-release-date']?.slice(0, 4));
  return year > 1800 && year <= new Date().getFullYear() + 1 ? year : null;
};

/** The release groups a recording is on, from the search result's releases, with their dates. */
const groupsOf = (recording) =>
  (recording.releases ?? [])
    .filter((r) => r['release-group'])
    .map((r) => ({ ...r['release-group'], date: r.date ?? '9999', release: r.title }));

const onAlbum = (recording, album) => groupsOf(recording).some((g) => sameAlbum(album, g.title) || sameAlbum(album, g.release));

/**
 * The host's recordings among search results: credited to the host's artist,
 * with the host's title (and near ones, when they are more), studio versions
 * only, each with the credited artist that matched. Artists of different
 * names pool ("Hugo Montenegro" and "Hugo Montenegro and His Orchestra" are
 * one act to the host); two artists of the same name are told apart as
 * sameNamed says, and when they can't be, the track is not found.
 */
function matching(results, host) {
  const byArtist = results.map((r) => ({ r, artist: hostArtist(host.artist, r) })).filter((x) => x.artist?.id);
  const exact = byArtist.filter((x) => sameTitle(host.track, x.r.title) || sameTitle(bareTitle(host.track), x.r.title));
  const nearly = byArtist.filter((x) => !exact.includes(x) && nearTitles(host.track, x.r.title));
  // A near title counts when nothing has the host's, or when most of MusicBrainz spells it so: the
  // host and one stray entry can share a typo ("Crequee Alley" for "Creeque Alley").
  const near = exact.length === 0;
  const titled = nearly.length > exact.length ? [...exact, ...nearly] : exact;
  let studio = titled.filter((x) => isStudio(x.r, host));

  const idsByName = new Map();
  for (const { artist } of studio) {
    const key = plain(artist.name);
    idsByName.set(key, (idsByName.get(key) ?? new Set()).add(artist.id));
  }
  for (const ids of idsByName.values()) {
    if (ids.size < 2) continue;
    const pick = sameNamed(studio.filter((x) => ids.has(x.artist.id)), host.album);
    if (pick === null) return null;
    studio = studio.filter((x) => !ids.has(x.artist.id) || x.artist.id === pick);
  }
  return studio.length > 0 ? { near, recordings: studio } : null;
}

/**
 * Which of several artists of the same name is the host's, by their
 * recordings of the title: the one with the host's album, else the one with
 * most of them (three or more, and three times all the others': the band
 * MusicBrainz knows well, not a namesake with one entry), else null.
 */
function sameNamed(matches, album) {
  const count = (list) => {
    const counts = new Map();
    for (const x of list) counts.set(x.artist.id, (counts.get(x.artist.id) ?? 0) + 1);
    return counts;
  };
  const withAlbum = count(matches.filter((x) => onAlbum(x.r, album)));
  if (withAlbum.size === 1) return [...withAlbum.keys()][0];
  const counts = count(withAlbum.size > 1 ? matches.filter((x) => withAlbum.has(x.artist.id)) : matches);
  const [best, ...rest] = [...counts].sort((a, b) => b[1] - a[1]);
  const others = rest.reduce((sum, [, n]) => sum + n, 0);
  return best[1] >= 3 && best[1] >= 3 * others ? best[0] : null;
}

/**
 * The recording that stands for the song: the earliest on the host's album
 * when that is not a compilation, else the earliest with a date (ties: the
 * one on the most releases, the merged original).
 */
function primary(matches, album) {
  const byDate = [...matches].sort(
    (a, b) => (yearOf(a.r) ?? 9999) - (yearOf(b.r) ?? 9999) || (b.r.releases?.length ?? 0) - (a.r.releases?.length ?? 0),
  );
  const own = byDate.filter((x) =>
    groupsOf(x.r).some(
      (g) => (sameAlbum(album, g.title) || sameAlbum(album, g.release)) && !(g['secondary-types'] ?? []).includes('Compilation'),
    ),
  );
  return own[0] ?? byDate[0];
}

/** The album a recording stands on: the host's, else its earliest studio album, EP or single, else its earliest release group. */
function albumOf(recording, album) {
  const groups = groupsOf(recording).sort((a, b) => a.date.localeCompare(b.date));
  return (
    groups.find((g) => sameAlbum(album, g.title) && !(g['secondary-types'] ?? []).includes('Compilation')) ??
    groups.find((g) => ['Album', 'EP', 'Single'].includes(g['primary-type']) && (g['secondary-types'] ?? []).length === 0) ??
    groups.find((g) => !(g['secondary-types'] ?? []).includes('Compilation')) ??
    groups[0] ??
    null
  );
}

/** The top genres by votes, Title Cased like Apple's ("post-punk" is "Post-Punk"). */
function top(genres) {
  return (genres ?? [])
    .filter((g) => g.count > 0)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, TOP_GENRES)
    .map((g) => titleCase(g.name));
}

const UPPER = new Set(['idm', 'ebm', 'edm', 'mpb', 'uk', 'us', 'dj', 'r&b', 'nwobhm', 'dnb', 'ccm', 'aor', 'mor', 'ndw']);
const SMALL = new Set(['and', 'n', 'of', 'the', 'de', 'la', 'y']);

export function titleCase(name) {
  return name
    .split(' ')
    .map((word, i) =>
      UPPER.has(word)
        ? word.toUpperCase()
        : i > 0 && SMALL.has(word)
          ? word
          : word.replace(/(^|-)(\p{L})/gu, (_, sep, c) => sep + c.toUpperCase()),
    )
    .join(' ');
}

const groupGenres = new Map();
const artistGenres = new Map();

/** A release group's genres, once per group and run; the lookup brings its artists' genres too. */
async function genresOfGroup(id) {
  if (!groupGenres.has(id)) {
    const group = await mb(`release-group/${id}`, { inc: 'genres artists' });
    groupGenres.set(id, group?.genres ?? []);
    for (const c of group?.['artist-credit'] ?? []) {
      if (c.artist?.genres && !artistGenres.has(c.artist.id)) artistGenres.set(c.artist.id, c.artist.genres);
    }
  }
  return groupGenres.get(id);
}

async function genresOfArtist(id) {
  if (!artistGenres.has(id)) artistGenres.set(id, (await mb(`artist/${id}`, { inc: 'genres' }))?.genres ?? []);
  return artistGenres.get(id);
}

/**
 * Genres from the recording, else its album, else the artist. A recording
 * with no tags at all has no genres (genres are votes on tags), so it is
 * looked up only when the search shows tags on it.
 */
async function genresFor(recording, artist, album) {
  if ((recording.tags ?? []).length > 0) {
    const own = top((await mb(`recording/${recording.id}`, { inc: 'genres' }))?.genres);
    if (own.length > 0) return own;
  }
  const group = albumOf(recording, album);
  if (group) {
    const own = top(await genresOfGroup(group.id));
    if (own.length > 0) return own;
  }
  return top(await genresOfArtist(artist));
}

/** The MusicBrainz recording id, original year and genres for one track, all empty when nothing matches. */
export async function findOnMusicBrainz(track) {
  if (!track.artist || !track.track) {
    mbStats.missed++;
    return NOT_FOUND;
  }
  // Each name the host credits, so "Janis Joplin / Big Brother & The Holding Company" finds either.
  const names = credited(main(track.artist)).map((n) => n.trim());
  const name = names[0] || track.artist;
  const title = bareTitle(track.track);
  const artists = names.length > 1 ? `(${names.map(phrase).join(' OR ')})` : phrase(name);
  const pool = new Map();
  const add = ({ recordings }) => recordings.forEach((r) => pool.set(r.id, r));
  add(await search(`recording:${phrase(title)} AND artist:${artists}`));
  let match = matching([...pool.values()], track);
  let via = 'search';
  if (!match) {
    const ids = await findArtists(name);
    if (ids.length > 0) {
      add(await search(`${byIds(ids)} AND recording:${words(title)}`));
      match = matching([...pool.values()], track);
      via = 'artist';
    }
  }
  if (!match) {
    mbStats.missed++;
    return NOT_FOUND;
  }

  // Earlier recordings by the same artists, which the first search can miss: under another
  // credit ("1910 Fruitgum Company" for "1910 Fruitgum Co."), punctuated otherwise ("Walk – Don't
  // Run"), or past the first page of a song with hundreds of recordings. Asked again only while
  // the answer is cut off and keeps getting earlier.
  for (let round = 0, earliest = Infinity; round < 3; round++) {
    const years = match.recordings.map((x) => yearOf(x.r)).filter(Boolean);
    const year = years.length > 0 ? Math.min(...years) : null;
    if (year !== null && year >= earliest) break;
    earliest = year ?? -Infinity;
    const ids = [...new Set(match.recordings.map((x) => x.artist.id))].slice(0, 5);
    const before = year === null ? '' : ` AND firstreleasedate:{* TO ${year}}`;
    const more = await search(`${byIds(ids)} AND recording:${words(title)}${before}`);
    add(more);
    match = matching([...pool.values()], track) ?? match;
    if (year === null || more.count <= more.recordings.length) break;
  }
  mbStats[match.near ? 'near' : via]++;

  const chosen = primary(match.recordings, track.album);
  const years = match.recordings.map((x) => yearOf(x.r)).filter(Boolean);
  return {
    mb_id: chosen.r.id,
    year: years.length > 0 ? Math.min(...years) : null,
    genres: await genresFor(chosen.r, chosen.artist.id, track.album),
  };
}

/** Apple's genre first (the site's genre filter), then MusicBrainz's, each once whatever its spelling. */
export function combineGenres(apple, musicbrainz) {
  const seen = new Set();
  return [...apple, ...musicbrainz].filter((genre) => {
    const key = plain(genre).replaceAll(' ', '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
