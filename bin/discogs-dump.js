#!/usr/bin/env node
import { createReadStream, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createGunzip } from 'node:zlib';
import { artistKey } from '../src/artists.js';
import { credited, main } from '../src/match.js';
import { programs } from '../src/playlists.js';

const ROOT = join(import.meta.dirname, '..');

const USAGE = `Usage: discogs-dump [options]

Match the archive's tracks to Discogs masters offline, from Discogs' monthly CC0 data dumps
(data.discogs.com): a track matches a master when its lead artist is one of the master's artists (by
name, or one of that Discogs artist's name variations and aliases, from the artists dump) and its
album is the master's title, both compared without case, accents, punctuation, a leading "The" or
"&" for "and". Masters have no tracklist: an album-level match, the master's year being the first
edition's. A dry run: writes no data, only a report.

Options:
  --masters <file>   The masters dump (default: ../discogs_<date>_masters.xml.gz, the newest)
  --artists <file>   The artists dump, for name variations and aliases (default: the newest beside it;
                     --artists none to leave it out)
  --report <file>    Write the report there (default: stdout)
  -h, --help         Show this help
`;

let opts;
try {
  const { values } = parseArgs({
    options: { masters: { type: 'string' }, artists: { type: 'string' }, report: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  const newest = (kind) => {
    const dir = join(ROOT, '..');
    const files = readdirSync(dir).filter((f) => new RegExp(`^discogs_\\d{8}_${kind}\\.xml\\.gz$`).test(f)).sort();
    return files.length ? join(dir, files.at(-1)) : null;
  };
  const masters = values.masters ?? newest('masters');
  if (!masters || !existsSync(masters)) throw new Error('no masters dump: download discogs_<date>_masters.xml.gz from data.discogs.com next to the repo, or name it with --masters');
  const artists = values.artists === 'none' ? null : (values.artists ?? newest('artists'));
  if (artists && !existsSync(artists)) throw new Error(`no artists dump at ${artists}`);
  opts = { masters, artists, report: values.report ?? null };
} catch (err) {
  process.stderr.write(`${err.message}\n\n${USAGE}`);
  process.exit(2);
}

// ------------------------------------------------------------------ keys

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s) =>
  s.replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+));/gi, (all, hex, dec, name) =>
    hex ? String.fromCodePoint(parseInt(hex, 16)) : dec ? String.fromCodePoint(Number(dec)) : (ENTITIES[name] ?? all),
  );

/** A Discogs artist name without its " (2)" disambiguation and its trailing "*" (an ANV mark). */
const discogsName = (name) => name.replace(/\s\(\d+\)$/, '').replace(/\*$/, '').trim();

/** A title's letters and digits, without case, accents, a leading "The" or "and" for "&". */
const titleKey = (title) => artistKey(title);

// ------------------------------------------------------------------ our tracks

const PROGRAMS = [...programs(), 'stereoplan'];
const tracks = [];
for (const id of PROGRAMS) {
  for (const episode of JSON.parse(readFileSync(join(ROOT, 'docs', 'data', `${id}.json`), 'utf8'))) {
    for (const t of episode.tracks ?? []) {
      tracks.push({ program: id, episode: episode.number ?? episode.published_at, t, lead: t.artist ? artistKey(credited(main(t.artist))[0] ?? t.artist) : '', album: t.album ? titleKey(t.album) : '' });
    }
  }
}
const albumKeys = new Set(tracks.filter((x) => x.album && x.lead).map((x) => x.album));

// ------------------------------------------------------------------ dumps, streamed

/** Each `<tag …>…</tag>` record of a gzipped dump, as a string, to `each`. */
async function records(file, tag, each) {
  const end = `</${tag}>`;
  let buffer = '';
  const stream = createReadStream(file).pipe(createGunzip());
  stream.setEncoding('utf8');
  for await (const chunk of stream) {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf(end)) >= 0) {
      each(buffer.slice(0, at + end.length));
      buffer = buffer.slice(at + end.length);
    }
  }
}

const started = Date.now();
const candidates = []; // masters whose title is one of our albums
let mastersSeen = 0;
await records(opts.masters, 'master', (rec) => {
  mastersSeen++;
  const title = decode(rec.match(/<\/artists>[\s\S]*?<title>([\s\S]*?)<\/title>/)?.[1] ?? rec.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '');
  const key = titleKey(title);
  if (!albumKeys.has(key)) return;
  const head = rec.replace(/<videos>[\s\S]*<\/videos>/, '');
  const artists = [...(head.match(/<artists>([\s\S]*?)<\/artists>/)?.[1] ?? '').matchAll(/<artist>([\s\S]*?)<\/artist>/g)].map(([, a]) => ({
    id: Number(a.match(/<id>(\d+)<\/id>/)?.[1]),
    name: decode(a.match(/<name>([\s\S]*?)<\/name>/)?.[1] ?? ''),
    anv: decode(a.match(/<anv>([\s\S]*?)<\/anv>/)?.[1] ?? ''),
  }));
  const videos = [...(rec.match(/<videos>([\s\S]*)<\/videos>/)?.[1] ?? '').matchAll(/<video [^>]*>\s*<title>([\s\S]*?)<\/title>/g)].map(([, v]) => decode(v));
  candidates.push({
    id: Number(rec.match(/<master id="(\d+)"/)[1]),
    main: Number(head.match(/<main_release>(\d+)<\/main_release>/)?.[1]) || null,
    year: Number(head.match(/<year>(\d+)<\/year>/)?.[1]) || null,
    title,
    key,
    quality: head.match(/<data_quality>([\s\S]*?)<\/data_quality>/)?.[1] ?? null,
    artists,
    videos,
  });
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
else process.stdout.write(text);
console.error(`done in ${((Date.now() - started) / 1000).toFixed(0)} s: ${classes.matched.length} matched of ${tracks.length - classes.noAlbum.length} tracks with an album`);
