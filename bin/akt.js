#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { appleStats, findOnApple } from '../src/apple.js';
import { fetchFeed } from '../src/feed.js';
import { applyOverrides } from '../src/overrides.js';
import { parseTracklist } from '../src/parse.js';

/** The whole archive: the only file this writes, and the file the site loads. */
const DATA = join(import.meta.dirname, '..', 'docs', 'data', 'episodes.json');

const USAGE = `Usage: akt [options]

Fetch the feed, parse every new or edited episode and find its tracks on Apple Music,
into docs/data/episodes.json.

Options:
  --limit <n>        Parse at most n episodes, newest first
  --episode <guid>   Parse this episode again even if it is unchanged
  --relink           Look every track up on Apple Music again (no new claude calls)
  -h, --help         Show this help
`;

function options() {
  const { values } = parseArgs({
    options: {
      limit: { type: 'string' },
      episode: { type: 'string' },
      relink: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const limit = values.limit === undefined ? Infinity : Number(values.limit);
  if (!(limit > 0 && (Number.isInteger(limit) || limit === Infinity))) {
    throw new Error(`--limit must be a positive integer, got: ${values.limit}`);
  }
  return { help: values.help ?? false, limit, episode: values.episode ?? null, relink: values.relink ?? false };
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
const needsApple = (episode) =>
  (opts.relink && episode.tracks !== null) || (episode.tracks?.some((track) => !('year' in track)) ?? false);

const pending = feed.filter((item, i) => needsParse(item, i) || needsApple(episodes[i]));
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
    for (const [i, track] of episode.tracks.entries()) {
      if ('year' in track && !opts.relink) continue;
      const { artist, track: title, album } = track;
      episode.tracks[i] = applyOverrides({ artist, track: title, album, ...(await findOnApple(track)) });
      save(episodes);
    }
    const found = episode.tracks.filter((track) => track.apple_id !== null).length;
    console.log(`${name}: ${episode.tracks.length} tracks, ${found} on Apple Music`);
  } catch (err) {
    failures++;
    console.error(`${name}: ${err.message}`);
  }
}
const { search, catalog, near, missed } = appleStats;
if (search + catalog + near + missed > 0) {
  console.log(`apple: ${search} by search, ${catalog} from the artist's catalog, ${near} by a near title, ${missed} not found`);
}
process.exitCode = failures > 0 ? 1 : 0;
