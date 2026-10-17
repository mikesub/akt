import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { appleStats, doubtLink, findAppleLinks, findOnApple, lookupSongs } from './apple.js';
import { discogsStats, findOnDiscogs } from './discogs.js';
import { findOnMusicBrainz, mbStats } from './musicbrainz.js';
import { countryCodes, vague } from './countries.js';
import { applyOverrides } from './overrides.js';
import { parsePlaylist } from './parse.js';
import { keyOf, readPlaylists } from './playlists.js';
import { restoreTitle } from './titles.js';

/**
 * One program's playlists to its data file: every new or edited playlist
 * parsed by `claude`, and every track found on Apple Music and MusicBrainz
 * (and on Discogs when both leave the year out). Keyed by episode number
 * (Stereoplan's by guid), in the playlists' order, stable key order;
 * resumable, a failed playlist or lookup being retried on the next run.
 * bin/playlists.js runs it for any program with playlist files
 * (src/playlists.js), bin/svoboda.js for «Музыка на Свободе», and
 * bin/stereoplan.js for Stereoplan, whose playlists are its feed's episode
 * descriptions.
 */

const SAVE_EVERY = 5_000; // ms; lookups finish many times a second between the three sources

const hash = (text) => createHash('sha256').update(text ?? '').digest('hex').slice(0, 16);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The options every program's command takes, as parseArgs options, and their values checked. */
export const OPTIONS = {
  limit: { type: 'string' },
  episode: { type: 'string' },
  'parse-only': { type: 'boolean' },
  misses: { type: 'boolean' },
  musicbrainz: { type: 'boolean' },
  relink: { type: 'boolean' },
  only: { type: 'string' },
};

/** Their lines in a command's usage text. */
export const OPTIONS_USAGE = `  --limit <n>        Parse at most n playlists, newest first
  --episode <n>      Parse playlist n again even if it is unchanged, before any other
                     (with --limit 1, only it)
  --parse-only       Parse, but look nothing up: makes no requests, so it can run
                     while another program's lookups do; a later run looks them up
  --misses           Look up again every track Apple Music or MusicBrainz did not find
  --musicbrainz      Look every track up on MusicBrainz again, and search Apple Music
                     again for each link that looks wrong
  --relink           Look every track up again from scratch (no new claude calls)
  --only <pattern>   With --misses, --musicbrainz or --relink: only the tracks whose
                     artist, title or album matches the pattern (a regular expression)
`;
export function checkOptions(values) {
  const limit = values.limit === undefined ? Infinity : Number(values.limit);
  if (!(limit > 0 && (Number.isInteger(limit) || limit === Infinity))) {
    throw new Error(`--limit must be a positive integer, got: ${values.limit}`);
  }
  let only = null;
  try {
    if (values.only !== undefined) only = new RegExp(values.only, 'u');
  } catch (err) {
    throw new Error(`--only must be a regular expression: ${err.message}`);
  }
  if (only && !(values.misses || values.musicbrainz || values.relink)) throw new Error('--only goes with --misses, --musicbrainz or --relink');
  const episode = values.episode === undefined ? null : Number(values.episode);
  if (episode !== null && !(Number.isInteger(episode) && episode > 0)) {
    throw new Error(`--episode must be a playlist number, got: ${values.episode}`);
  }
  return {
    limit,
    episode,
    parseOnly: values['parse-only'] ?? false,
    misses: values.misses ?? false,
    musicbrainz: values.musicbrainz ?? false,
    relink: values.relink ?? false,
    matching: only,
  };
}

/** Undated episodes' bound for `aired`: the year of the next dated episode by number, which they aired no later than. */
let airedBy = new Map();

/** A year, or null when it is after the episode aired: a reissue's or a later release's, never the track's. */
function aired(episode, year) {
  const latest = Number(episode.published_at?.slice(0, 4)) || airedBy.get(episode.number) || 0;
  return year !== null && latest > 0 && year > latest ? null : year;
}

/** A track with the codes of the country its playlist prints (countries.json), under its restored names (titles.json), then with its hand fixes (overrides.json). */
export const corrected = (track) => applyOverrides(shape(restoreTitle(coded(track))));

/**
 * A track's country codes, from its printed country whenever it has one, the
 * table having maybe changed since; else, or when the printed one is vague
 * ("Europe", "?"), as bin/countries.js inferred them (`country_from`: the
 * same artist elsewhere in the archive, or MusicBrainz), the vague one's
 * codes when it found none.
 */
const coded = (track) => {
  const printed = track.printed_country;
  if (printed === undefined) return track;
  if (printed && !vague(printed)) return { ...track, country: countryCodes(printed), country_from: undefined };
  if (track.country_from && track.country) return track;
  return { ...track, country: printed ? countryCodes(printed) : (track.country ?? null) };
};

/** What the parse gives a track: its names and its printed country, with that country's codes. */
const parsed = ({ artist, track, album, printed_country, country, country_from }) => ({ artist, track, album, printed_country, country, country_from });

/**
 * A track's fields in their stored order; each source's id is left out until
 * that source has been asked, and the country until the playlist was read
 * for it (bin/countries.js for tracks parsed before the parse read it).
 */
const shape = ({ artist, track, album, printed_country, country, country_from, apple_id, apple_album_id, apple_artist_id, mb_id, discogs_id, year }) => ({
  artist,
  track,
  album,
  ...(printed_country !== undefined && { printed_country, country: country ?? null }),
  ...(country_from !== undefined && { country_from }),
  ...(apple_id !== undefined && { apple_id }),
  ...(apple_album_id !== undefined && { apple_album_id }),
  ...(apple_artist_id !== undefined && { apple_artist_id }),
  ...(mb_id !== undefined && { mb_id }),
  ...(discogs_id !== undefined && { discogs_id }),
  year: year ?? null,
});

/**
 * Each source: which tracks still need it, and how its answer goes into a
 * track. The year is MusicBrainz's (the original release), else Apple's,
 * else Discogs's, whichever of the first two answers first; none counts if
 * it is after the episode aired.
 */
const sources = {
  apple: {
    needs: (track) => !('apple_id' in track),
    ask: async (track, episode) => {
      const found = await findOnApple(track);
      return (t) => ({ ...t, apple_id: found.apple_id, year: t.year ?? aired(episode, found.year) });
    },
  },
  musicbrainz: {
    needs: (track) => !('mb_id' in track),
    ask: async (track, episode) => {
      const found = await findOnMusicBrainz(track);
      return (t) => ({ ...t, mb_id: found.mb_id, year: aired(episode, found.year) ?? t.year });
    },
  },
  discogs: {
    needs: (track) => 'apple_id' in track && 'mb_id' in track && track.year === null && !('discogs_id' in track),
    ask: async (track, episode) => {
      const found = await findOnDiscogs(track);
      return (t) => ({ ...t, discogs_id: found.discogs_id, year: t.year ?? aired(episode, found.year) });
    },
  },
};

/** What the sources answered for a track: the lookups search by its artist, title and album alone. */
const LOOKED_UP = ['apple_id', 'apple_album_id', 'apple_artist_id', 'mb_id', 'discogs_id', 'year'];
const sameNames = (t) => JSON.stringify([t.artist, t.track, t.album]);

/**
 * A playlist parsed again (its text changed: a fuller source, a fix) keeps the sources' answers for every track
 * whose artist, title and album are unchanged, so only what is new is looked up; and, for one that prints no
 * country, the country inferred for it (bin/countries.js).
 */
function keepLookups(before, tracks) {
  const old = new Map((before ?? []).map((t) => [sameNames(t), t]));
  return tracks.map((t) => {
    const o = old.get(sameNames(t));
    if (!o) return t;
    const kept = Object.fromEntries(LOOKED_UP.filter((k) => k in o).map((k) => [k, o[k]]));
    const country = !t.printed_country && !o.printed_country && o.country_from ? { country: o.country, country_from: o.country_from } : {};
    return { ...t, ...kept, ...country };
  });
}

/**
 * What a run asks again by forgetting the answers, so that the sources see
 * the tracks as never asked (an override still wins): `misses` what Apple
 * Music or MusicBrainz did not find, `musicbrainz` every MusicBrainz answer,
 * `relink` everything but the parse. An interrupted run is finished by
 * running again without the option.
 */
function forget(track, { misses, musicbrainz, relink }) {
  if (relink) return { ...parsed(track), year: null };
  const { apple_id, mb_id, discogs_id, ...rest } = track;
  const keep = {
    ...(!(misses && apple_id === null) && { apple_id }),
    ...(!((misses && mb_id === null) || musicbrainz) && { mb_id }),
    // Discogs is asked again with MusicBrainz, if the year is still missing then.
    ...(!((misses && (discogs_id ?? null) === null) || musicbrainz) && { discogs_id }),
  };
  return { ...rest, ...keep };
}

/**
 * Parse and look up one program: every new or edited playlist, in the
 * order `read` gives them (newest first), and playlist `episode` (first)
 * even if unchanged, at most `limit` of them; with `parseOnly`, no lookups
 * (they make no requests, so it can run beside another program's lookups);
 * with `misses`, `musicbrainz` or `relink`, tracks asked again (see
 * forget), only those whose names match `matching` if given. A program is src/playlists.js `program`; one whose playlists are
 * not files (Stereoplan) also gives `read`, its playlists as readPlaylists
 * returns them, each with `fields`, the episode's fields in their stored
 * order (a `guid` among them keys it), and `parse`. Returns how many parses
 * and lookups failed.
 */
export async function run(
  { id, playlists: dir, data, read = () => readPlaylists(dir), parse = parsePlaylist },
  { limit = Infinity, episode: only = null, parseOnly = false, misses = false, musicbrainz = false, relink = false, matching = null } = {},
) {
  let saved = 0;
  /** Stable key order, newest episode first. Written whole and renamed into place, so a killed run leaves the previous file. */
  const save = (episodes, { now = false } = {}) => {
    if (!now && Date.now() - saved < SAVE_EVERY) return;
    mkdirSync(dirname(data), { recursive: true });
    writeFileSync(`${data}.tmp`, `${JSON.stringify(episodes, null, 2)}\n`);
    renameSync(`${data}.tmp`, data);
    saved = Date.now();
  };

  let previous = [];
  try {
    previous = JSON.parse(readFileSync(data, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  // The playlists own every episode field; `tracks` and the hash of the
  // playlist they were parsed from carry over until that playlist changes.
  const fieldsOf = (p) => p.fields ?? { number: p.number, title: p.title, published_at: p.date, url: p.url };
  const keyOfEpisode = ({ guid, number, published_at }) => guid ?? keyOf({ number, date: published_at });
  const stored = new Map(previous.map((episode) => [keyOfEpisode(episode), episode]));
  const playlists = read();
  // An undated playlist (FM Достоевский's first years) aired no later than the next dated one.
  airedBy = new Map();
  let next = 0;
  for (const p of playlists.filter((p) => p.number !== null).sort((a, b) => b.number - a.number)) {
    if (p.date) next = Number(p.date.slice(0, 4));
    else if (next) airedBy.set(p.number, next);
  }
  if (only !== null && !playlists.some((p) => p.number === only)) throw new Error(`no playlist #${only} in ${id}`);
  const text = new Map(playlists.map((p) => [keyOfEpisode(fieldsOf(p)), p.text]));
  const episodes = playlists.map((p) => {
    const fields = fieldsOf(p);
    const before = stored.get(keyOfEpisode(fields));
    const episode = { ...fields, playlist_hash: before?.playlist_hash ?? null, tracks: null };
    // A track dated after its episode got a later release's year: looked up again, under `aired` below.
    episode.tracks =
      before?.tracks?.map((t) => corrected(aired(episode, t.year) === t.year ? t : { ...parsed(t), year: null })) ?? null;
    return episode;
  });

  if (!parseOnly && (misses || musicbrainz || relink)) {
    const options = { misses, musicbrainz, relink };
    // With `musicbrainz`, each Apple Music link is checked too, by id in batches: one that looks wrong
    // (another artist or title, a live version, gone) is forgotten and searched for again.
    // With `matching` (--only), only the tracks whose names match.
    const asked = (t) => !matching || matching.test(`${t.artist}\n${t.track}\n${t.album ?? ''}`);
    const songs = musicbrainz ? await lookupSongs(episodes.flatMap((e) => e.tracks ?? []).filter(asked).map((t) => t.apple_id).filter(Boolean)) : null;
    for (const episode of episodes) {
      episode.tracks = episode.tracks?.map((t) => {
        if (!asked(t)) return t;
        const doubt = songs && t.apple_id ? doubtLink(t, songs.get(t.apple_id)) : null;
        if (doubt) console.log(`${episode.number === null ? episode.published_at : `#${episode.number}`}: ${t.artist} — ${t.track}: was ${doubt}, searching again`);
        // The doubted song's link and the year it may have given; MusicBrainz is asked again anyway.
        const { apple_id, apple_album_id, apple_artist_id, ...unlinked } = t;
        return corrected(shape(forget(doubt ? { ...unlinked, year: null } : t, options)));
      }) ?? null;
    }
  }
  save(episodes, { now: true });

  const textOf = (episode) => text.get(keyOfEpisode(episode));
  const nameOf = (episode) => (episode.number === null ? episode.published_at : `#${episode.number}`);
  // Playlist `only` first, so that with a limit of 1 it is the only one.
  const asked = (episode) => only !== null && episode.number === only;
  const toParse = episodes
    .filter((episode) => asked(episode) || episode.playlist_hash !== hash(textOf(episode)))
    .sort((a, b) => asked(b) - asked(a))
    .slice(0, limit);
  const pendingTracks = episodes.flatMap((e) => e.tracks ?? []).filter((t) => sources.apple.needs(t) || sources.musicbrainz.needs(t)).length;
  console.log(`${id}: ${episodes.length} playlists, ${toParse.length} to parse, ${pendingTracks} tracks already parsed to look up`);

  let failures = 0;
  let parsing = true;
  const asking = new Set(['apple', 'musicbrainz']); // Discogs waits on both

  async function parseAll() {
    for (const episode of toParse) {
      try {
        const tracks = await parse(textOf(episode));
        episode.tracks = keepLookups(episode.tracks, tracks.map((track) => corrected(shape(track)))).map(corrected);
        episode.playlist_hash = hash(textOf(episode));
        save(episodes);
        console.log(`${nameOf(episode)}: ${tracks.length} tracks`);
      } catch (err) {
        failures++;
        console.error(`${nameOf(episode)}: ${err.message}`);
      }
    }
    parsing = false;
  }

  /**
   * One source's lookups, newest episode first, one at a time (src/http.js
   * paces each host). The three sources run side by side, being three hosts.
   * A failed lookup is left for the next run.
   */
  async function lookUp(name) {
    const { needs, ask } = sources[name];
    const failed = new Set();
    let done = 0;
    for (;;) {
      let next = null;
      for (const episode of episodes) {
        const i = episode.tracks?.findIndex((track, j) => needs(track) && !failed.has(`${nameOf(episode)}:${j}`)) ?? -1;
        if (i >= 0) {
          next = { episode, tracks: episode.tracks, i };
          break;
        }
      }
      if (!next) {
        if (!parsing && (name !== 'discogs' || asking.size === 0)) break;
        await sleep(2_000);
        continue;
      }
      const { episode, tracks, i } = next;
      try {
        const update = await ask(tracks[i], episode);
        // Dropped if the playlist was parsed again meanwhile.
        if (episode.tracks === tracks) {
          tracks[i] = applyOverrides(shape(update(tracks[i])));
          save(episodes);
        }
      } catch (err) {
        failures++;
        failed.add(`${nameOf(episode)}:${i}`);
        console.error(`${nameOf(episode)} ${name}: ${tracks[i].artist} — ${tracks[i].track}: ${err.message}`);
      }
      if (++done % 100 === 0) console.log(`${name}: ${done} tracks`);
    }
    asking.delete(name);
  }

  await Promise.all([parseAll(), ...(parseOnly ? [] : [lookUp('apple'), lookUp('musicbrainz'), lookUp('discogs')])]);
  // The album and artist links of every Apple Music link without them, a few lookups by id for all.
  if (!parseOnly) {
    try {
      const links = await findAppleLinks(episodes.flatMap((episode) => episode.tracks ?? []));
      for (const episode of episodes) episode.tracks = episode.tracks?.map((t) => (links.has(t) ? shape({ ...t, ...links.get(t) }) : t)) ?? null;
    } catch (err) {
      failures++;
      console.error(`apple album and artist links: ${err.message}`);
    }
  }
  save(episodes, { now: true });

  const tracks = episodes.flatMap((episode) => episode.tracks ?? []);
  const count = (test) => tracks.filter(test).length;
  console.log(
    `${id}: ${episodes.length} playlists, ${tracks.length} tracks: ${count((t) => t.apple_id)} on Apple Music, ` +
      `${count((t) => t.mb_id)} on MusicBrainz, ${count((t) => t.discogs_id)} from Discogs, ${count((t) => t.year !== null)} with a year`,
  );
  const { search, catalog, album, near, missed } = appleStats;
  if (search + catalog + album + near + missed > 0) {
    console.log(`apple: ${search} by search, ${catalog} from the artist's catalog, ${album} from the album, ${near} by a near title, ${missed} not found`);
  }
  if (mbStats.search + mbStats.artist + mbStats.near + mbStats.missed > 0) {
    console.log(`musicbrainz: ${mbStats.search} by search, ${mbStats.artist} through the artist, ${mbStats.near} by a near title, ${mbStats.missed} not found`);
  }
  if (discogsStats.track + discogsStats.album + discogsStats.missed > 0) {
    console.log(`discogs: ${discogsStats.track} by the track, ${discogsStats.album} by the album, ${discogsStats.missed} not found`);
  }
  if (failures > 0) console.error(`${failures} failed; run again to retry them`);
  return failures;
}
