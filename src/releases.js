import { decode, discogsName, genresOf, parseMaster, records } from './dumps.js';
import { bare, close, credited, main, plain, titleTest } from './match.js';

/**
 * Tracks matched to Discogs releases offline, from the monthly CC0 releases
 * dump: what src/discogs.js findOnDiscogs does online, on the whole catalogue
 * at once. A release matches a track when one of its tracks has the track's
 * title (hasTitle, as online) and is credited, on that track or on the
 * release, to the track's artist (as sameArtist does online: the host's
 * first credited name is one of the release's, or the release's first is one
 * of the host's; or a Discogs artist whose name variations include the
 * host's, from the artists dump). Unlike the API, which reads three releases
 * a track, every release in the dump is read.
 *
 * Per track, of all matching releases: the release kept is the first official
 * one that is neither a compilation nor a reissue, with a master, earliest;
 * else the earliest of the rest. Its year is the earliest of the matches'
 * own years (a compilation's not counted, a reissue's by its master's).
 * Two different Discogs artists of the same name behind the matches (or one
 * other than the artist the archive's masters already name) leave the track
 * unmatched, as do titles too short or generic to tell songs apart.
 */

const GENERIC = /^(intro|outro|interlude|untitled|unknown|hidden track|bonus track|track \d+|\d+)$/;

/** A title worth matching: not one or two letters, not "Intro" or "Untitled". */
export const matchable = (title) => {
  const p = plain(title ?? '');
  return p.replace(/\s/g, '').length > 2 && !GENERIC.test(p);
};

/** The `<artists>` blocks of an XML fragment (not `<extraartists>`: credits, not performers) as { id, name, anv }. */
const artistsIn = (xml) =>
  [...xml.matchAll(/<artists>([\s\S]*?)<\/artists>/g)].flatMap(([, block]) =>
    [...block.matchAll(/<artist>([\s\S]*?)<\/artist>/g)].map(([, a]) => ({
      id: Number(a.match(/<id>(\d+)<\/id>/)?.[1]) || null,
      name: discogsName(decode(a.match(/<name>([\s\S]*?)<\/name>/)?.[1] ?? '')),
      anv: decode(a.match(/<anv>([\s\S]*?)<\/anv>/)?.[1] ?? '').replace(/\*$/, '').trim(),
    })),
  );

/** A release's tracks: each one's titles (with its sub-tracks') and own performers, if it names any. */
function tracksOf(rec) {
  const list = rec.match(/<tracklist>([\s\S]*?)<\/tracklist>/)?.[1] ?? '';
  const out = [];
  // Top-level <track>s; a medley's <sub_tracks> hold <track>s of their own.
  let depth = 0;
  let start = -1;
  for (const m of list.matchAll(/<(\/?)(track|sub_tracks)>/g)) {
    const closing = m[1] === '/';
    if (m[2] === 'track' && !closing) {
      if (depth === 0) start = m.index;
      depth++;
    } else if (m[2] === 'track' && closing) {
      depth--;
      if (depth === 0 && start >= 0) {
        const inner = list.slice(start, m.index);
        const own = inner.replace(/<sub_tracks>[\s\S]*<\/sub_tracks>/, '');
        const titles = [
          decode(own.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? ''),
          ...[...(inner.match(/<sub_tracks>([\s\S]*)<\/sub_tracks>/)?.[1] ?? '').matchAll(/<title>([\s\S]*?)<\/title>/g)].map(([, t]) => decode(t)),
        ].filter(Boolean);
        out.push({ titles, artists: artistsIn(own) });
        start = -1;
      }
    }
  }
  return out;
}

/** A release's fields, for one that passed the artist filter. */
function parseRelease(rec) {
  const formats = rec.match(/<formats>([\s\S]*?)<\/formats>/)?.[1] ?? '';
  const descriptions = [...formats.matchAll(/<description>([\s\S]*?)<\/description>/g)].map(([, d]) => decode(d));
  const head = rec.slice(0, rec.indexOf('<title>') >= 0 ? rec.indexOf('<title>') : 0);
  return {
    id: Number(rec.match(/<release id="(\d+)"/)[1]),
    title: decode(rec.match(/<\/artists><title>([\s\S]*?)<\/title>/)?.[1] ?? rec.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? ''),
    artists: artistsIn(head),
    year: Number(rec.match(/<released>(\d{4})/)?.[1]) || null,
    master: Number(rec.match(/<master_id[^>]*>(\d+)<\/master_id>/)?.[1]) || null,
    compilation: descriptions.includes('Compilation'),
    reissue: descriptions.some((d) => /^(Reissue|Repress|Remastered)$/.test(d)),
    unofficial: descriptions.includes('Unofficial Release'),
    country: decode(rec.match(/<country>([\s\S]*?)<\/country>/)?.[1] ?? ''),
    ...genresOf(rec),
    tracks: tracksOf(rec),
  };
}

/** A Discogs name's keys as sameArtist compares them (each credited name, plain, no leading "The"), cached: names repeat across millions of releases. */
const cache = new Map();
const keysOf = (name) => {
  let keys = cache.get(name);
  if (keys) return keys;
  if (cache.size > 300_000) cache.clear();
  keys = credited(main(name)).map(bare).filter(Boolean);
  cache.set(name, keys);
  return keys;
};

/** The host's names as sameArtist compares them: the first, and all of them. */
const hostNames = (artist) => credited(main(artist)).map(bare).filter(Boolean);

/**
 * The host's first credited name is one of `artists` (by name or ANV, a typo
 * allowed, as sameArtist), or a Discogs artist the host's names map to. Not
 * sameArtist's other way round (the release's first artist one of the host's
 * names): offline, on every release, it matched a composer's record for
 * "Performer/Composer" and "The Walkers" for "The Frank & Walters".
 */
function sameArtistOn(host, artists, ids) {
  if (artists.some((a) => a.id && ids.has(a.id))) return true;
  const first = hostNames(host)[0];
  if (!first) return false;
  return artists.some((a) => [a.name, a.anv].filter(Boolean).flatMap(keysOf).some((n) => close(first, n, 0.2)));
}

/** A match that names the host's first name exactly (no typo allowed), or a Discogs artist it maps to: good enough for a year. */
export function exact(x, { entryArtists }, ids = new Set()) {
  const first = hostNames(x.t.artist)[0];
  return entryArtists.some((a) => (a.id && ids.has(a.id)) || [a.name, a.anv].filter(Boolean).flatMap(keysOf).includes(first));
}

/**
 * Match `wanted` tracks ({ t, … } as bin/discogs-dump.js builds them) against
 * the releases dump. `byRelease` asks for release ids alone (a release the API
 * found, for its master). Returns, per track, every matching release with the
 * Discogs artists it matched, and the releases asked for by id.
 */
export async function matchReleases({ releasesFile, artistsFile, wanted, byRelease }) {
  // The host names worth a look, and the Discogs artists whose name variations are one of them.
  const keyTracks = new Map();
  for (const x of wanted) for (const k of hostNames(x.t.artist)) keyTracks.set(k, [...(keyTracks.get(k) ?? []), x]);
  const idTracks = new Map();
  const idsOf = new Map(); // track -> Set of Discogs artist ids
  let artistsTime = 0;
  if (artistsFile) {
    const t0 = Date.now();
    await records(artistsFile, 'artist', (rec) => {
      const id = Number(rec.match(/^\s*(?:<artists>\s*)?<artist>\s*<id>(\d+)<\/id>/)?.[1]);
      if (!id) return;
      const names = [
        rec.match(/<name>([\s\S]*?)<\/name>/)?.[1] ?? '',
        ...[...(rec.match(/<namevariations>([\s\S]*?)<\/namevariations>/)?.[1] ?? '').matchAll(/<name>([\s\S]*?)<\/name>/g)].map(([, n]) => n),
      ];
      for (const n of names) {
        const list = keyTracks.get(bare(discogsName(decode(n))));
        if (!list) continue;
        idTracks.set(id, [...new Set([...(idTracks.get(id) ?? []), ...list])]);
        for (const x of list) idsOf.set(x, new Set([...(idsOf.get(x) ?? []), id]));
      }
    });
    artistsTime = Date.now() - t0;
  }

  // Each track's title test, built once (src/discogs.js hasTitle, made fast: see titleTest).
  const tests = new Map(wanted.map((x) => [x, titleTest(x.t.track)]));
  const t0 = Date.now();
  const matches = new Map(); // track -> [{ release, entryArtists }]
  const releasesById = new Map();
  let seen = 0;
  let parsed = 0;
  await records(releasesFile, 'release', (rec) => {
    if (++seen % 1_000_000 === 0) console.error(`releases: ${seen / 1_000_000}M read, ${parsed} with a wanted performer, ${matches.size} tracks matched, ${((Date.now() - t0) / 60000).toFixed(1)} min`);
    const id = Number(rec.match(/<release id="(\d+)"/)?.[1]);
    const asked = byRelease.has(id);
    // Cheap first: is any performer one we want, by name, ANV or id?
    const performers = artistsIn(rec);
    const candidates = new Set();
    for (const a of performers) {
      for (const n of [a.name, a.anv]) for (const k of n ? keysOf(n) : []) for (const x of keyTracks.get(k) ?? []) candidates.add(x);
      for (const x of (a.id && idTracks.get(a.id)) || []) candidates.add(x);
    }
    if (!candidates.size && !asked) return;
    parsed++;
    const release = parseRelease(rec);
    // Copied out (a JSON round trip): a substring would keep the whole record, and the dump's buffer, alive.
    if (asked) releasesById.set(id, JSON.parse(JSON.stringify({ id, master: release.master, genres: release.genres, styles: release.styles, year: release.year })));
    let kept = null;
    for (const x of candidates) {
      const ids = idsOf.get(x) ?? new Set();
      for (const entry of release.tracks) {
        const performersHere = entry.artists.length ? entry.artists : release.artists;
        // As hasTitle's titlesOf: each part of a "Title = Перевод" title counts.
        const test = tests.get(x);
        if (!entry.titles.some((title) => title.split(/\s+=\s+/).some(test))) continue;
        if (!sameArtistOn(x.t.artist, performersHere, ids)) continue;
        kept ??= JSON.parse(JSON.stringify({ id: release.id, title: release.title, artists: release.artists.map(({ id, name }) => ({ id, name })), year: release.year, master: release.master, compilation: release.compilation, reissue: release.reissue, unofficial: release.unofficial }));
        const list = matches.get(x) ?? [];
        list.push({ release: kept, entryArtists: JSON.parse(JSON.stringify(performersHere.map(({ id, name, anv }) => ({ id, name, anv })))) });
        matches.set(x, list);
        break;
      }
    }
  });
  return { matches, releasesById, seen, parsed, artistsTime, releasesTime: Date.now() - t0 };
}

/** The Discogs artist ids behind a track's matches that carry the host's lead name (a namesake check; a guest or partner is another artist, not a namesake). */
export function matchedArtistIds(x, list) {
  const hosts = new Set(hostNames(x.t.artist).slice(0, 1));
  const ids = new Set();
  for (const { entryArtists } of list) {
    for (const a of entryArtists) {
      const names = [a.name, a.anv].filter(Boolean).flatMap(keysOf);
      if (a.id && names.some((n) => hosts.has(n))) ids.add(a.id);
    }
  }
  return ids;
}

/** The release kept for a track, of its matches (see above), and the earliest year among them. */
export function choose(list, masterYears, yearOk = () => true) {
  const rank = ({ release: r }) => [r.unofficial ? 1 : 0, r.compilation || r.reissue ? 1 : 0, r.master ? 0 : 1, r.year ?? 9999, r.id];
  const sorted = [...list].sort((a, b) => {
    const x = rank(a), y = rank(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return 0;
  });
  const years = list
    .filter(yearOk)
    .map(({ release: r }) => (r.compilation || r.unofficial ? null : r.reissue ? (r.master ? masterYears.get(r.master) ?? null : null) : r.year))
    .filter((y) => y && y > 1800);
  return { release: sorted[0].release, year: years.length ? Math.min(...years) : null };
}

export { parseMaster };
