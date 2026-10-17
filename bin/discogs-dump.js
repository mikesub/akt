#!/usr/bin/env node
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { artistKey } from '../src/artists.js';
import { decode, discogsName, dumpDate, genresOf, newestDump, parseMaster, records } from '../src/dumps.js';
import { credited, main } from '../src/match.js';
import { corrected } from '../src/pipeline.js';
import { programs } from '../src/playlists.js';

const ROOT = join(import.meta.dirname, '..');

const USAGE = `Usage: discogs-dump [options]

Match the archive's tracks to Discogs masters offline, from Discogs' monthly CC0 data dumps
(data.discogs.com): a track matches a master when its lead artist is one of the master's artists (by
name, or one of that Discogs artist's name variations and aliases, from the artists dump) and its
album is the master's title, both compared without case, accents, punctuation, a leading "The" or
"&" for "and". Masters have no tracklist: an album-level match, the master's year being the first
edition's. Without --write a dry run: writes no data, only a report.

With --write, sets discogs_master_id on each track that matches exactly one master, and on one that
matches several only where they all have the same Discogs artists and year (Discogs' duplicate masters:
the lowest id); never on a match to a "Various" compilation, never over a discogs_master_id the track
has already (the API's, or an override's: the report lists where they differ), and nothing else: not
the year, not discogs_id. The API backfill (--discogs) then skips those tracks.

With --genres (also done by --write), sets discogs_genres and discogs_styles on every track with a
discogs_master_id, from that master in the dump: its genres and styles, two independent lists, as Discogs
names them, album-level (a track gets its record's). A master the dump lacks (merged or deleted since)
keeps what the track has. Run it again after a new dump, or after an override changes a master.

Options:
  --masters <file>   The masters dump (default: ../discogs_<date>_masters.xml.gz, the newest)
  --artists <file>   The artists dump, for name variations and aliases (default: the newest beside it;
                     --artists none to leave it out)
  --report <file>    Write the report there (default: stdout)
  --write            Set the masters in docs/data, then their genres and styles (see above)
  --genres           Set the genres and styles of every track's master in docs/data (see above)
  --review <file>    Write, as JSON, the matched tracks whose master is 2+ years older than their year
                     ("earlier") or who have no year ("missing"), for the owner to review; no data change
  -h, --help         Show this help
`;

let opts;
try {
  const { values } = parseArgs({
    options: {
      masters: { type: 'string' },
      artists: { type: 'string' },
      report: { type: 'string' },
      write: { type: 'boolean' },
      genres: { type: 'boolean' },
      review: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  const newest = (kind) => newestDump(join(ROOT, '..'), kind);
  const masters = values.masters ?? newest('masters');
  if (!masters || !existsSync(masters)) throw new Error('no masters dump: download discogs_<date>_masters.xml.gz from data.discogs.com next to the repo, or name it with --masters');
  const artists = values.artists === 'none' ? null : (values.artists ?? newest('artists'));
  if (artists && !existsSync(artists)) throw new Error(`no artists dump at ${artists}`);
  opts = { masters, artists, report: values.report ?? null, write: values.write ?? false, genres: (values.genres || values.write) ?? false, review: values.review ?? null };
} catch (err) {
  process.stderr.write(`${err.message}\n\n${USAGE}`);
  process.exit(2);
}

// ------------------------------------------------------------------ keys

/** A title's letters and digits, without case, accents, a leading "The" or "and" for "&". */
const titleKey = (title) => artistKey(title);

// ------------------------------------------------------------------ our tracks

const PROGRAMS = [...programs(), 'stereoplan'];
const data = new Map(PROGRAMS.map((id) => [id, JSON.parse(readFileSync(join(ROOT, 'docs', 'data', `${id}.json`), 'utf8'))]));
const tracks = [];
for (const [id, episodes] of data) {
  // An undated episode aired no later than the next dated one by number (src/pipeline.js airedBy).
  const airedBy = new Map();
  let next = null;
  for (const e of episodes.filter((e) => e.number !== null).sort((a, b) => b.number - a.number)) {
    if (e.published_at) next = Number(e.published_at.slice(0, 4));
    else if (next) airedBy.set(e.number, next);
  }
  for (const episode of episodes) {
    const aired = episode.published_at ?? null;
    const airYear = aired ? Number(aired.slice(0, 4)) : (airedBy.get(episode.number) ?? null);
    for (const t of episode.tracks ?? []) {
      tracks.push({ program: id, episode: episode.number ?? episode.published_at, aired, airYear, t, lead: t.artist ? artistKey(credited(main(t.artist))[0] ?? t.artist) : '', album: t.album ? titleKey(t.album) : '' });
    }
  }
}
const albumKeys = new Set(tracks.filter((x) => x.album && x.lead).map((x) => x.album));

// ------------------------------------------------------------------ dumps, streamed

const started = Date.now();
const candidates = []; // masters whose title is one of our albums
const ourMasters = new Set(tracks.map((x) => x.t.discogs_master_id).filter(Boolean));
const genresBy = new Map(); // master id -> { genres, styles }, for the masters our tracks have
let mastersSeen = 0;
await records(opts.masters, 'master', (rec) => {
  mastersSeen++;
  if (opts.genres) {
    const id = Number(rec.match(/<master id="(\d+)"/)?.[1]);
    if (ourMasters.has(id)) genresBy.set(id, genresOf(rec));
  }
  // The title first, cheaply: most masters are not one of our albums.
  const title = decode(rec.match(/<\/artists>[\s\S]*?<title>([\s\S]*?)<\/title>/)?.[1] ?? rec.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '');
  const key = titleKey(title);
  if (!albumKeys.has(key)) return;
  candidates.push({ ...parseMaster(rec), title, key });
});
const mastersTime = Date.now() - started;

// Each candidate artist's other names, from the artists dump: name variations and aliases.
const wanted = new Set(candidates.flatMap((m) => m.artists.map((a) => a.id)));
const otherNames = new Map();
let artistsTime = 0;
if (opts.artists) {
  const t0 = Date.now();
  await records(opts.artists, 'artist', (rec) => {
    const id = Number(rec.match(/^\s*(?:<artists>\s*)?<artist>\s*<id>(\d+)<\/id>/)?.[1]);
    if (!wanted.has(id)) return;
    const names = [
      ...[...(rec.match(/<namevariations>([\s\S]*?)<\/namevariations>/)?.[1] ?? '').matchAll(/<name>([\s\S]*?)<\/name>/g)].map(([, n]) => n),
      ...[...(rec.match(/<aliases>([\s\S]*?)<\/aliases>/)?.[1] ?? '').matchAll(/<name[^>]*>([\s\S]*?)<\/name>/g)].map(([, n]) => n),
    ].map((n) => discogsName(decode(n)));
    otherNames.set(id, names);
  });
  artistsTime = Date.now() - t0;
}

// ------------------------------------------------------------------ matching

const VARIOUS = 194; // Discogs' "Various"
const byTitle = new Map();
for (const m of candidates) byTitle.set(m.key, [...(byTitle.get(m.key) ?? []), m]);
const keysOf = (m) =>
  new Set(m.artists.flatMap((a) => [a.name, a.anv, ...(otherNames.get(a.id) ?? [])].filter(Boolean).map((n) => artistKey(discogsName(n)))));

const classes = { matched: [], ambiguous: [], unmatched: [], compilation: [], noAlbum: [] };
for (const x of tracks) {
  if (!x.album || !x.lead) {
    classes.noAlbum.push(x);
    continue;
  }
  const titled = byTitle.get(x.album) ?? [];
  const found = titled.filter((m) => keysOf(m).has(x.lead));
  if (found.length === 1) classes.matched.push({ ...x, m: found[0] });
  else if (found.length > 1) classes.ambiguous.push({ ...x, ms: found });
  else if (titled.some((m) => m.artists.some((a) => a.id === VARIOUS))) classes.compilation.push(x);
  else classes.unmatched.push(x);
}

// Agreement with what the API (or the owner) already gave.
const withMaster = tracks.filter((x) => x.t.discogs_master_id);
const masterCheck = { agree: 0, differ: [], notMatched: 0 };
for (const x of withMaster) {
  const hit = classes.matched.find((y) => y.t === x.t);
  if (!hit) masterCheck.notMatched++;
  else if (hit.m.id === x.t.discogs_master_id) masterCheck.agree++;
  else masterCheck.differ.push({ x, m: hit.m });
}
const withRelease = classes.matched.filter((x) => x.t.discogs_id);
const releaseCheck = { mainIsOurs: withRelease.filter((x) => x.m.main === x.t.discogs_id).length, total: withRelease.length };

// Years.
const years = { same: 0, earlier: [], later: [], ourMissing: [], masterMissing: 0 };
for (const x of classes.matched) {
  const ours = x.t.year;
  const theirs = x.m.year;
  if (!theirs) years.masterMissing++;
  else if (ours === null || ours === undefined) years.ourMissing.push(x);
  else if (theirs === ours) years.same++;
  else if (theirs < ours) years.earlier.push({ ...x, gap: ours - theirs });
  else years.later.push({ ...x, gap: theirs - ours });
}
const videoHits = years.ourMissing.filter((x) => x.m.videos.some((v) => titleKey(v).includes(titleKey(x.t.track ?? '') || '\u0000'))).length;

// ------------------------------------------------------------------ what --write sets

// One master for a track: its single match, or the lowest of Discogs' duplicates (same artists, same year).
const sameArtists = (a, b) => a.artists.map((x) => x.id).sort().join() === b.artists.map((x) => x.id).sort().join();
const assigned = classes.matched.map((x) => ({ x, m: x.m }));
const ambiguousTaken = [];
const ambiguousSkipped = [];
for (const x of classes.ambiguous) {
  const [first, ...rest] = [...x.ms].sort((a, b) => a.id - b.id);
  if (rest.every((m) => sameArtists(m, first) && m.year === first.year)) {
    assigned.push({ x, m: first });
    ambiguousTaken.push(x);
  } else ambiguousSkipped.push(x);
}
// Never over a master the track has: the API's (null when its release has none) or an override's.
const already = assigned.filter(({ x }) => 'discogs_master_id' in x.t);
const disagree = already.filter(({ x, m }) => x.t.discogs_master_id !== null && x.t.discogs_master_id !== m.id);
const toSet = assigned.filter(({ x }) => !('discogs_master_id' in x.t));

// ------------------------------------------------------------------ report

const count = (list, program) => list.filter((x) => !program || x.program === program).length;
const line = (x) => `${x.t.artist} — «${x.t.track}» [${x.t.album}] ${x.t.year ?? '—'} (${x.program} ${x.episode})`;
const mline = (m) => `master ${m.id} «${m.title}» by ${m.artists.map((a) => a.name).join(', ')}, ${m.year ?? 'no year'} (discogs.com/master/${m.id})`;

// A fixed sample, so reruns compare: every n-th matched track.
const step = Math.max(1, Math.floor(classes.matched.length / 25));
const sample = classes.matched.filter((_, i) => i % step === 0).slice(0, 25);

const hist = new Map();
for (const { gap } of years.earlier) {
  const bucket = gap <= 1 ? '1' : gap <= 3 ? '2–3' : gap <= 10 ? '4–10' : gap <= 20 ? '11–20' : '21+';
  hist.set(bucket, (hist.get(bucket) ?? 0) + 1);
}

const out = [];
out.push('# Discogs masters dump: dry-run match', '');
out.push(`Masters read: ${mastersSeen.toLocaleString('en')} (${(mastersTime / 1000).toFixed(0)} s); candidates (title is one of our albums): ${candidates.length.toLocaleString('en')}; artists dump: ${opts.artists ? `${otherNames.size.toLocaleString('en')} candidate artists with their other names (${(artistsTime / 1000).toFixed(0)} s)` : 'not used'}.`, '');
out.push('## Classes', '', '| program | tracks | no album | matched | ambiguous | compilation | unmatched |', '|---|---|---|---|---|---|---|');
for (const p of [...PROGRAMS, null]) {
  out.push(`| ${p ?? '**all**'} | ${count(tracks, p)} | ${count(classes.noAlbum, p)} | ${count(classes.matched, p)} | ${count(classes.ambiguous, p)} | ${count(classes.compilation, p)} | ${count(classes.unmatched, p)} |`);
}
out.push('', '## What --write sets', '');
out.push(`- single matches: ${classes.matched.length}; ambiguous taken (Discogs' duplicates, the lowest id): ${ambiguousTaken.length}, skipped: ${ambiguousSkipped.length}`);
out.push(`- of these, the track has a discogs_master_id already (left as it is): ${already.length} (${already.filter(({ x }) => x.t.discogs_master_id === null).length} null, the API's release having none); differing from the dump's: ${disagree.length}`);
for (const { x, m } of disagree) out.push(`  - ${line(x)}: ours ${x.t.discogs_master_id}, the dump's ${mline(m)}`);
out.push(`- to set: ${toSet.length} (${PROGRAMS.map((p) => `${p} ${toSet.filter(({ x }) => x.program === p).length}`).join(', ')})`);
out.push('', '## Accuracy checks', '');
out.push(`- Tracks with a discogs_master_id already (the API's or the owner's): ${withMaster.length}; the dump matches the same master for ${masterCheck.agree}, another for ${masterCheck.differ.length}, none for ${masterCheck.notMatched}.`);
for (const { x, m } of masterCheck.differ) out.push(`  - ${line(x)}: ours ${x.t.discogs_master_id}, the dump's ${mline(m)}`);
out.push(`- Matched tracks that have a discogs_id (a release the API found): ${releaseCheck.total}; the master's main release is that very release for ${releaseCheck.mainIsOurs}. (A different release is not a disagreement: a master has many.)`);
out.push('', '## Years (matched tracks)', '');
out.push(`- same as ours: ${years.same}`, `- master earlier: ${years.earlier.length}`, `- master later (a wrong match, or our year is wrong): ${years.later.length}`, `- ours missing, the master has one: ${years.ourMissing.length} (the master's videos name the track for ${videoHits} of them)`, `- master has no year: ${years.masterMissing}`);
out.push('', 'Master earlier, by how many years:', '');
for (const b of ['1', '2–3', '4–10', '11–20', '21+']) out.push(`- ${b}: ${hist.get(b) ?? 0}`);
out.push('', '## 25 matched samples to spot-check', '');
for (const x of sample) out.push(`- ${line(x)} → ${mline(x.m)}`);
out.push('', '## The 15 biggest "master earlier" gaps', '');
for (const x of years.earlier.sort((a, b) => b.gap - a.gap).slice(0, 15)) out.push(`- ${x.gap} y: ${line(x)} → ${mline(x.m)}`);
out.push('', `## Master later than our year (${years.later.length}, up to 40)`, '');
for (const x of years.later.sort((a, b) => b.gap - a.gap).slice(0, 40)) out.push(`- +${x.gap} y: ${line(x)} → ${mline(x.m)}`);
out.push('', `## Ambiguous (${classes.ambiguous.length}, up to 15)`, '');
for (const x of classes.ambiguous.slice(0, 15)) out.push(`- ${line(x)} → ${x.ms.map((m) => `${m.id} (${m.artists.map((a) => a.name).join(', ')}, ${m.year})`).join('; ')}`);

const text = `${out.join('\n')}\n`;
if (opts.report) writeFileSync(opts.report, text);
else if (!opts.write) process.stdout.write(text);

// ------------------------------------------------------------------ review list

if (opts.review) {
  const COMPILATION = /\b(best of|greatest|collection|anthology|singles|complete|hits|archives?|anniversary|remaster(ed)?|deluxe)\b/i;
  const mentions = (m, track) => {
    const key = titleKey(track ?? '');
    return key.length > 0 && m.videos.some((v) => titleKey(v).includes(key));
  };
  const review = [];
  for (const { x, m } of assigned) {
    if ('discogs_master_id' in x.t && x.t.discogs_master_id !== m.id) continue;
    const ours = x.t.year ?? null;
    if (!m.year) continue;
    const kind = ours === null ? 'missing' : ours - m.year >= 2 ? 'earlier' : null;
    if (!kind) continue;
    review.push({
      program: x.program,
      episode: x.episode,
      aired: x.aired ?? x.airYear,
      artist: x.t.artist,
      track: x.t.track,
      album: x.t.album,
      our_year: ours,
      master_id: m.id,
      master_title: m.title,
      master_artists: m.artists.map((a) => a.name).join(', '),
      master_year: m.year,
      gap: ours === null ? null : ours - m.year,
      kind,
      video_mentions_track: mentions(m, x.t.track),
      compilation_like: COMPILATION.test(m.title) || COMPILATION.test(x.t.album ?? ''),
      after_air: x.airYear !== null && m.year > x.airYear,
      // The matched Discogs artist is a namesake Discogs tells apart with " (2)": a wrong band, maybe.
      discogs_namesake: m.artists.some((a) => /\s\(\d+\)$/.test(a.name)),
    });
  }
  const order = { earlier: 0, missing: 1 };
  review.sort((a, b) => order[a.kind] - order[b.kind] || (b.gap ?? 0) - (a.gap ?? 0) || a.program.localeCompare(b.program));
  writeFileSync(opts.review, `${JSON.stringify(review, null, 2)}\n`);
  console.error(`review: ${review.length} tracks (${review.filter((r) => r.kind === 'earlier').length} earlier, ${review.filter((r) => r.kind === 'missing').length} missing) in ${opts.review}`);
}

// ------------------------------------------------------------------ masters

const changedTracks = new Set();
if (opts.write) {
  for (const { x, m } of toSet) {
    x.t.discogs_master_id = m.id;
    changedTracks.add(x.t);
  }
  console.error(`wrote ${toSet.length} masters from the dump of ${dumpDate(opts.masters)}`);
}

// ------------------------------------------------------------------ genres

if (opts.genres) {
  for (const m of candidates) if (!genresBy.has(m.id)) genresBy.set(m.id, { genres: m.genres, styles: m.styles });
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  let set = 0;
  const missing = new Set();
  for (const x of tracks) {
    const master = x.t.discogs_master_id;
    if (!master) continue;
    const g = genresBy.get(master);
    if (!g) {
      missing.add(master);
      continue;
    }
    if (same(x.t.discogs_genres, g.genres) && same(x.t.discogs_styles, g.styles)) continue;
    x.t.discogs_genres = g.genres;
    x.t.discogs_styles = g.styles;
    changedTracks.add(x.t);
    set++;
  }
  console.error(`genres and styles set on ${set} tracks from the dump of ${dumpDate(opts.masters)}; ${missing.size} masters not in the dump (their tracks keep what they have)`);
}

// ------------------------------------------------------------------ write

if (changedTracks.size) {
  const set = changedTracks;
  for (const [id, episodes] of data) {
    let changed = false;
    for (const episode of episodes) {
      if (!episode.tracks?.some((t) => set.has(t))) continue;
      // Through the pipeline's own shaping, so the key order stays (discogs_master_id after discogs_id).
      episode.tracks = episode.tracks.map((t) => (set.has(t) ? corrected(t) : t));
      changed = true;
    }
    if (!changed) continue;
    const file = join(ROOT, 'docs', 'data', `${id}.json`);
    writeFileSync(`${file}.tmp`, `${JSON.stringify(episodes, null, 2)}\n`);
    renameSync(`${file}.tmp`, file);
  }
}
console.error(`done in ${((Date.now() - started) / 1000).toFixed(0)} s: ${classes.matched.length} matched of ${tracks.length - classes.noAlbum.length} tracks with an album`);
