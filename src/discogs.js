import { get } from './http.js';
import { credited, main, nearTitles, plain, sameAlbum, sameArtist, sameTitle, searchable } from './match.js';

/**
 * A track's Discogs release, for a link, and its year, used only when Apple
 * Music and MusicBrainz leave it out (no key, no login: 25 requests a minute,
 * paced by src/http.js). Only the year and the release id are kept, never
 * anything else.
 *
 * A release search by the host's artist and title, earliest first; a
 * release counts only when it is credited to the host's artist and its own
 * tracklist has the host's title (see hasTitle). Failing that, the host's
 * album by the host's artist: its year, unless it is a compilation. A reissue's year is its master's, the first issue's.
 * Anything less certain is "not found": no guessing. Two to six requests a
 * track.
 */

const API = 'https://api.discogs.com';
const CHECKED = 3; // releases whose tracklist is read, earliest first
const NOT_FOUND = { discogs_id: null, year: null };

/** How each lookup ended, for the run's summary line. */
export const discogsStats = { track: 0, album: 0, missed: 0 };

async function search(params) {
  const query = new URLSearchParams({ ...searchable(params), type: 'release', per_page: '100' });
  return (await get(`${API}/database/search?${query}`))?.results ?? [];
}

/** A search result's artist and title: Discogs names a release "Artist - Title", with "(2)" and "*" marks on the artist. */
function parts(result) {
  const [artist, ...title] = (result.title ?? '').split(' - ');
  return { artist: artist.replace(/\s\(\d+\)/g, '').replaceAll('*', '').trim(), title: title.join(' - ') };
}

const yearOf = (release) => (Number(release.year) > 1800 ? Number(release.year) : null);
const byYear = (a, b) => (yearOf(a) ?? 9999) - (yearOf(b) ?? 9999);

/** A search result's year, or a reissue's master's: a reissue alone on Discogs still dates the first issue. */
async function firstYear(result) {
  if (!(result.format ?? []).includes('Reissue')) return yearOf(result);
  const master = result.master_id ? await get(`${API}/masters/${result.master_id}`) : null;
  return master ? yearOf(master) : null;
}

/** Every title on a release: the parts of a multi-part track, and each language of a "Title = Перевод" one. */
const titlesOf = (release) =>
  (release.tracklist ?? [])
    .flatMap((t) => [t.title, ...(t.sub_tracks ?? []).map((sub) => sub.title)])
    .flatMap((title) => (title ?? '').split(/\s+=\s+/));

/**
 * The host's title is on the release: the same, a near one, or the start of
 * one when the host shortens a long title to three words or more
 * ("Звёзды всегда хороши" for "Звёзды Всегда Хороши, Особенно Ночью").
 */
function hasTitle(release, title) {
  const host = plain(title);
  const long = host.split(' ').length >= 3;
  return titlesOf(release).some(
    (t) => sameTitle(title, t) || nearTitles(title, t) || (long && `${plain(t)} `.startsWith(`${host} `)),
  );
}

/** The Discogs release id and year for one track, both empty when nothing matches. */
export async function findOnDiscogs(track) {
  if (!track.artist || !track.track) {
    discogsStats.missed++;
    return NOT_FOUND;
  }
  const artist = credited(main(track.artist))[0]?.trim() || track.artist;
  const ours = (results) => results.filter((r) => sameArtist(track.artist, parts(r).artist)).sort(byYear);

  // The search matches titles loosely, so each release's own tracklist decides.
  for (const result of ours(await search({ artist, track: track.track })).slice(0, CHECKED)) {
    const release = await get(`${API}/releases/${result.id}`);
    if (!release || !hasTitle(release, track.track)) continue;
    discogsStats.track++;
    return { discogs_id: release.id, year: await firstYear(result) };
  }

  if (track.album) {
    const album = ours(await search({ artist, release_title: track.album })).find((r) => sameAlbum(track.album, parts(r).title));
    if (album) {
      discogsStats.album++;
      const compilation = (album.format ?? []).includes('Compilation');
      return { discogs_id: album.id, year: compilation ? null : await firstYear(album) };
    }
  }
  discogsStats.missed++;
  return NOT_FOUND;
}
