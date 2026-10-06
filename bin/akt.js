#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { appleStats, doubtLink, findOnApple, lookupSongs } from '../src/apple.js';
import { fetchFeed } from '../src/feed.js';
import { combineGenres, findOnMusicBrainz, mbStats } from '../src/musicbrainz.js';
import { applyOverrides } from '../src/overrides.js';
import { parseTracklist } from '../src/parse.js';

/** The whole archive: the only file this writes, and the file the site loads. */
const DATA = join(import.meta.dirname, '..', 'docs', 'data', 'episodes.json');

const USAGE = `Usage: akt [options]

Fetch the feed, parse every new or edited episode and find its tracks on Apple Music
and MusicBrainz, into docs/data/episodes.json.

Options:
  --limit <n>        Parse at most n episodes, newest first
  --episode <guid>   Parse this episode again even if it is unchanged
  --relink           Look every track up on Apple Music and MusicBrainz again (no new claude calls)
  --musicbrainz      Look every track up on MusicBrainz again, and re-check its Apple Music link
  -h, --help         Show this help
`;

function options() {
  const { values } = parseArgs({
    options: {
      limit: { type: 'string' },
      episode: { type: 'string' },
      relink: { type: 'boolean' },
      musicbrainz: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const limit = values.limit === undefined ? Infinity : Number(values.limit);
  if (!(limit > 0 && (Number.isInteger(limit) || limit === Infinity))) {
    throw new Error(`--limit must be a positive integer, got: ${values.limit}`);
  }
  return {
    help: values.help ?? false,
    limit,
    episode: values.episode ?? null,
    relink: values.relink ?? false,
    musicbrainz: values.musicbrainz ?? false,
  };
}

function load() {
  try {
    return JSON.parse(readFileSync(DATA, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

/** Stable key order and feed order, so a diff of the file shows only real changes. */
function save(episodes) {
  mkdirSync(dirname(DATA), { recursive: true });
  writeFileSync(DATA, `${JSON.stringify(episodes, null, 2)}\n`);
}

const hash = (text) => createHash('sha256').update(text ?? '').digest('hex').slice(0, 16);

let opts;
try {
  opts = options();
} catch (err) {
  process.stderr.write(`${err.message}\n\n${USAGE}`);
  process.exit(2);
}
if (opts.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}

const stored = new Map(load().map((episode) => [episode.guid, episode]));
const feed = await fetchFeed();
if (opts.episode && !feed.some((item) => item.guid === opts.episode)) {
  process.stderr.write(`no episode ${opts.episode} in the feed\n`);
  process.exit(2);
}

// The feed owns every episode field; `tracks` and the hash of the description
// they were parsed from carry over until that description changes.
const episodes = feed.map((item) => {
  const previous = stored.get(item.guid);
  return {
    guid: item.guid,
    number: item.number,
    title: item.title,
    published_at: item.published_at,
    mp3_url: item.mp3_url,
    duration_sec: item.duration_sec,
    description_hash: previous?.description_hash ?? null,
    tracks: previous?.tracks?.map(applyOverrides) ?? null,
  };
});
save(episodes);

const needsParse = (item, i) =>
  item.guid === opts.episode || episodes[i].description_hash !== hash(item.description);
// A track without `year` has not been looked up on Apple Music yet, one without `mb_id` not on MusicBrainz.
const needsApple = (track) => opts.relink || !('year' in track);
const needsMusicBrainz = (track) => opts.relink || opts.musicbrainz || !('mb_id' in track);
const needsLookup = (episode) => episode.tracks?.some((track) => needsApple(track) || needsMusicBrainz(track)) ?? false;

/** A track's fields in their stored order; `mb_id` is left out until MusicBrainz has been asked. */
const shape = ({ artist, track, album, apple_id, mb_id, year, genres }) => ({
  artist,
  track,
  album,
  apple_id,
  ...(mb_id !== undefined && { mb_id }),
  year,
  genres,
});

const pending = feed.filter((item, i) => needsParse(item, i) || needsLookup(episodes[i]));
const todo = pending.slice(0, opts.limit);
console.log(`${feed.length} episodes in the feed, ${pending.length} to do, doing ${todo.length}`);

let failures = 0;
for (const item of todo) {
  const index = feed.indexOf(item);
  const episode = episodes[index];
  const name = item.number === null ? item.guid : `#${item.number}`;
  try {
    if (needsParse(item, index)) {
      episode.tracks = await parseTracklist(item.description);
      episode.description_hash = hash(item.description);
      save(episodes);
    }
    // Saved after every track, so an interrupted run resumes mid-episode.
    const searched = new Set();
    for (const [i, track] of episode.tracks.entries()) {
      if (!needsApple(track)) continue;
      const { artist, track: title, album } = track;
      episode.tracks[i] = applyOverrides(shape({ artist, track: title, album, ...(await findOnApple(track)) }));
      searched.add(i);
      save(episodes);
    }

    // One Apple lookup by id for the episode: each link's song, to check it and for its genre in English.
    const toFind = [...episode.tracks.keys()].filter((i) => needsMusicBrainz(episode.tracks[i]));
    const songs = await lookupSongs(toFind.map((i) => episode.tracks[i].apple_id).filter((id) => id !== null));
    for (const i of toFind) {
      let track = episode.tracks[i];
      let appleGenres = track.apple_id === null ? [] : track.genres.slice(0, 1);
      const song = songs.get(track.apple_id);
      if (song?.primaryGenreName) appleGenres = [song.primaryGenreName];

      // A link that looks wrong (another artist or title, a live version, gone) is searched for again.
      const doubt = track.apple_id !== null && !searched.has(i) ? doubtLink(track, song) : null;
      if (doubt) {
        const found = await findOnApple(track);
        const relinked = applyOverrides(shape({ ...track, ...found }));
        if (relinked.apple_id !== track.apple_id) {
          appleStats.relinked++;
          console.log(`${name}: ${track.artist} — ${track.track}: was ${doubt}, now ${relinked.apple_id ?? 'not on Apple Music'}`);
          track = relinked;
          appleGenres = found.genres;
        }
      }

      // MusicBrainz's year is the original release; Apple's stays only when MusicBrainz has none.
      const found = await findOnMusicBrainz(track);
      const genres = combineGenres(appleGenres, found.genres);
      episode.tracks[i] = applyOverrides(shape({ ...track, mb_id: found.mb_id, year: found.year ?? track.year, genres }));
      save(episodes);
    }

    const count = (key) => episode.tracks.filter((track) => track[key] !== null).length;
    console.log(`${name}: ${episode.tracks.length} tracks, ${count('apple_id')} on Apple Music, ${count('mb_id')} on MusicBrainz`);
  } catch (err) {
    failures++;
    console.error(`${name}: ${err.message}`);
  }
}
const { search, catalog, near, missed, relinked } = appleStats;
if (search + catalog + near + missed > 0) {
  const replaced = relinked > 0 ? `; ${relinked} doubtful links replaced` : '';
  console.log(`apple: ${search} by search, ${catalog} from the artist's catalog, ${near} by a near title, ${missed} not found${replaced}`);
}
const mb = mbStats;
if (mb.search + mb.artist + mb.near + mb.missed > 0) {
  console.log(`musicbrainz: ${mb.search} by search, ${mb.artist} through the artist, ${mb.near} by a near title, ${mb.missed} not found`);
}
process.exitCode = failures > 0 ? 1 : 0;
