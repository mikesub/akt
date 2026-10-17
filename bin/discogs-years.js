#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { masterYear } from '../src/discogs.js';
import { newestDump, parseMaster, records } from '../src/dumps.js';
import { programs } from '../src/playlists.js';

const ROOT = join(import.meta.dirname, '..');
const CACHE = join(ROOT, '.cache', 'discogs-masters.json');
const API_MAX = 300; // more than that is the dump's job: some 6 minutes at Discogs' pace

const USAGE = `Usage: discogs-years [<program>…] [options]

List the tracks whose Discogs master (discogs_master_id) is older than their year: a master's year
is its first edition's, so these are years that may be a reissue's or a remaster's. For the owner
to review; writes nothing to the data. The masters' years come from Discogs' masters dump (the newest
discogs_<date>_masters.xml.gz beside the repo), else one API request a master, at most ${API_MAX}
a run; both cached in .cache/discogs-masters.json, so a rerun asks only masters not seen before.
Every program by default; biggest gap first.

Options:
  --masters <file>   The masters dump (default: the newest beside the repo; none: the API only)
  -h, --help         Show this help
`;

let ids;
let dump;
try {
  const { values, positionals } = parseArgs({ options: { masters: { type: 'string' }, help: { type: 'boolean', short: 'h' } }, allowPositionals: true });
  if (values.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  ids = positionals.length > 0 ? positionals : [...programs(), 'stereoplan'];
  dump = values.masters === 'none' ? null : (values.masters ?? newestDump(join(ROOT, '..'), 'masters'));
  if (dump && !existsSync(dump)) throw new Error(`no masters dump at ${dump}`);
} catch (err) {
  process.stderr.write(`${err.message}\n\n${USAGE}`);
  process.exit(2);
}

const cache = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {};
const saveCache = () => {
  mkdirSync(join(ROOT, '.cache'), { recursive: true });
  writeFileSync(CACHE, `${JSON.stringify(cache, null, 2)}\n`);
};

const rows = [];
for (const id of ids) {
  for (const episode of JSON.parse(readFileSync(join(ROOT, 'docs', 'data', `${id}.json`), 'utf8'))) {
    for (const t of episode.tracks ?? []) {
      if (t.discogs_master_id) rows.push({ program: id, episode: episode.number ?? episode.published_at, t });
    }
  }
}

let masters = [...new Set(rows.map((r) => r.t.discogs_master_id))].filter((m) => !(m in cache));
if (dump && masters.length > 0) {
  const wanted = new Set(masters);
  await records(dump, 'master', (rec) => {
    const id = Number(rec.match(/<master id="(\d+)"/)?.[1]);
    if (!wanted.has(id)) return;
    const { year, title } = parseMaster(rec);
    cache[id] = { year, title };
  });
  saveCache();
  masters = masters.filter((m) => !(m in cache));
}
console.log(`${rows.length} tracks with a master, ${masters.length} masters to ask Discogs about`);
if (masters.length > API_MAX) {
  console.log(`more than ${API_MAX}: asking none; download Discogs' masters dump beside the repo (data.discogs.com)`);
  masters = [];
}
let asked = 0;
for (const m of masters) {
  try {
    cache[m] = await masterYear(m);
  } catch (err) {
    console.error(`master ${m}: ${err.message}`);
    continue;
  }
  if (++asked % 50 === 0) saveCache();
}
saveCache();

const older = rows
  .map((r) => ({ ...r, master: cache[r.t.discogs_master_id] }))
  .filter((r) => r.master?.year && (r.t.year === null || r.master.year < r.t.year))
  .sort((a, b) => (b.t.year ?? b.master.year) - b.master.year - ((a.t.year ?? a.master.year) - a.master.year) || a.program.localeCompare(b.program));

for (const id of ids) {
  const mine = older.filter((r) => r.program === id);
  if (mine.length === 0) continue;
  console.log(`\n${id}: ${mine.length}`);
  for (const { episode, t, master } of mine) {
    const gap = t.year === null ? `no year → ${master.year}` : `${t.year} → ${master.year} (${t.year - master.year})`;
    console.log(`  #${episode}\t${t.artist} — ${t.track}${t.album ? ` [${t.album}]` : ''}\t${gap}\t«${master.title}» https://www.discogs.com/master/${t.discogs_master_id}`);
  }
}
console.log(`\n${older.length} tracks whose master is older than their year (or who have none)`);
