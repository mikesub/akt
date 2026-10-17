#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { unmapped, vague } from '../src/countries.js';
import { findArtistCountry, mbCountryStats } from '../src/musicbrainz.js';
import { countryOverridden } from '../src/overrides.js';
import { readCountries } from '../src/parse.js';
import { corrected } from '../src/pipeline.js';
import { keyOf, program, programs, readPlaylists } from '../src/playlists.js';

const ROOT = join(import.meta.dirname, '..');

const USAGE = `Usage: countries [<program>…] [options]

Read with \`claude\` the country each playlist prints for its tracks parsed before the parse read
countries, one call a playlist, into docs/data/<program>.json: as printed (printed_country) and as
codes (country, from countries.json). Stereoplan's descriptions are read from
programs/stereoplan/descriptions/. A track whose playlist prints no country gets the one the same artist
has most often elsewhere in the archive (country_from: archive), and so does one that prints only
"Europe" or a placeholder ("?"); with --musicbrainz, one still without
gets its artists' countries from MusicBrainz (country_from: musicbrainz), asked once. Then lists the
printed countries countries.json has no codes for.
Every program by default. Never run it beside another run of the same program: both write its data file;
nor, with --musicbrainz, beside any other run that looks tracks up: requests are paced per process.

Options:
  --jobs <n>       claude calls at a time (default 4)
  --recode         Ask claude nothing: only code the printed countries again from countries.json,
                   fill in from the archive, and list the spellings it has no codes for
  --musicbrainz    Then ask MusicBrainz for every track still without a country, never asked before
  -h, --help       Show this help
`;

let opts;
try {
  const { values, positionals } = parseArgs({
    options: { jobs: { type: 'string' }, recode: { type: 'boolean' }, musicbrainz: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
    allowPositionals: true,
  });
  if (values.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  const jobs = Number(values.jobs ?? 4);
  if (!(Number.isInteger(jobs) && jobs > 0)) throw new Error(`--jobs must be a positive integer, got: ${values.jobs}`);
  const ids = positionals.length > 0 ? positionals : [...programs(), 'stereoplan'];
  for (const id of ids) if (id !== 'stereoplan') program(id);
  opts = { ids, jobs, recode: values.recode ?? false, musicbrainz: values.musicbrainz ?? false };
} catch (err) {
  process.stderr.write(`${err.message}\n\n${USAGE}`);
  process.exit(2);
}

// As src/pipeline.js hashes a playlist: one changed since its tracks were parsed waits for the next parse.
const hash = (text) => createHash('sha256').update(text ?? '').digest('hex').slice(0, 16);

/** A program's data file, its episodes, and each episode's playlist text as the pipeline parsed it. */
function load(id) {
  const data = join(ROOT, 'docs', 'data', `${id}.json`);
  const episodes = JSON.parse(readFileSync(data, 'utf8'));
  let textOf;
  if (id === 'stereoplan') {
    // Kept as the feed's description plus a newline (bin/stereoplan.js).
    const dir = join(ROOT, 'programs', 'stereoplan', 'descriptions');
    textOf = (e) => {
      const file = join(dir, `${e.number ?? e.guid}.html`);
      return existsSync(file) ? readFileSync(file, 'utf8').replace(/\n$/, '') : null;
    };
  } else {
    const texts = new Map(readPlaylists(program(id).playlists).map((p) => [keyOf(p), p.text]));
    textOf = (e) => texts.get(keyOf({ number: e.number, date: e.published_at })) ?? null;
  }
  return { id, data, episodes, textOf };
}

/** Written whole and renamed into place, as the pipeline does. */
function save({ data, episodes }) {
  writeFileSync(`${data}.tmp`, `${JSON.stringify(episodes, null, 2)}\n`);
  renameSync(`${data}.tmp`, data);
}

const nameOf = (id, e) => `${id} ${e.number === null ? e.published_at : `#${e.number}`}`;

const loaded = opts.ids.map(load);
const queue = [];
for (const program of loaded) {
  for (const episode of program.episodes) {
    if (!episode.tracks?.some((t) => !('printed_country' in t))) continue;
    const text = program.textOf(episode);
    if (text === null) console.error(`${nameOf(program.id, episode)}: no playlist text, skipped`);
    else if (hash(text) !== episode.playlist_hash) console.error(`${nameOf(program.id, episode)}: playlist changed since parsed, skipped`);
    else queue.push({ program, episode, text });
  }
}

let failures = 0;
if (!opts.recode) {
  console.log(`${queue.length} playlists to read for countries`);
  let done = 0;
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const { program, episode, text } = job;
      const tracks = episode.tracks;
      try {
        const printed = await readCountries(text, tracks);
        episode.tracks = tracks.map((t, i) => corrected({ ...t, printed_country: printed[i] }));
        save(program);
        console.log(`${nameOf(program.id, episode)}: ${printed.filter(Boolean).length} of ${tracks.length} with a country (${++done} done)`);
      } catch (err) {
        failures++;
        console.error(`${nameOf(program.id, episode)}: ${err.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: opts.jobs }, worker));
}

// Every printed country coded again from the table as it is now.
unmapped.clear();
for (const program of loaded) {
  program.episodes = program.episodes.map((e) => ({ ...e, tracks: e.tracks?.map((t) => ('printed_country' in t ? corrected(t) : t)) ?? null }));
}

// A track that prints no country, or only a vague one ("Europe", "?"): the codes its artist has most
// often where the archive prints a clear one (every program's, a tie left out), which wins over
// MusicBrainz; one filled so before and no longer is asked again.
const artistKey = (name) => name?.toLowerCase().replace(/^the\s+/, '').replace(/\s+/g, ' ').trim() || null;
const printedBy = new Map();
for (const id of [...programs(), 'stereoplan']) {
  const episodes = loaded.find((p) => p.id === id)?.episodes ?? JSON.parse(readFileSync(join(ROOT, 'docs', 'data', `${id}.json`), 'utf8'));
  for (const t of episodes.flatMap((e) => e.tracks ?? [])) {
    if (!t.printed_country || vague(t.printed_country) || !t.country || !artistKey(t.artist)) continue;
    const counts = printedBy.get(artistKey(t.artist)) ?? new Map();
    const codes = t.country.join('/');
    printedBy.set(artistKey(t.artist), counts.set(codes, (counts.get(codes) ?? 0) + 1));
  }
}
function fromArchive(artist) {
  const counts = [...(printedBy.get(artistKey(artist)) ?? [])].sort((a, b) => b[1] - a[1]);
  return counts.length > 0 && counts[0][1] > (counts[1]?.[1] ?? 0) ? counts[0][0].split('/') : null;
}
const unprinted = (t) => 'printed_country' in t && (!t.printed_country || vague(t.printed_country)) && !countryOverridden(t);
for (const program of loaded) {
  for (const e of program.episodes) {
    e.tracks = e.tracks?.map((t) => {
      if (!unprinted(t)) return t;
      const codes = fromArchive(t.artist);
      if (codes) return corrected({ ...t, country: codes, country_from: 'archive' });
      if (t.country_from === 'archive') return corrected({ ...t, country: null, country_from: undefined });
      return t;
    }) ?? null;
  }
  save(program);
}

if (opts.musicbrainz) {
  const asks = loaded.flatMap((program) =>
    program.episodes.flatMap((episode) => (episode.tracks ?? []).map((t, i) => ({ program, episode, i, t })).filter(({ t }) => unprinted(t) && t.country_from === undefined)),
  );
  console.log(`${asks.length} tracks to ask MusicBrainz for their artists' countries`);
  let done = 0;
  let saved = Date.now();
  for (const { program, episode, i, t } of asks) {
    try {
      const codes = await findArtistCountry(t);
      episode.tracks[i] = corrected({ ...episode.tracks[i], country: codes.length > 0 ? codes : null, country_from: 'musicbrainz' });
    } catch (err) {
      failures++;
      console.error(`${nameOf(program.id, episode)} musicbrainz: ${t.artist} — ${t.track}: ${err.message}`);
    }
    if (++done % 50 === 0) console.log(`musicbrainz: ${done} of ${asks.length}`);
    if (Date.now() - saved > 10_000) {
      loaded.forEach(save);
      saved = Date.now();
    }
  }
  loaded.forEach(save);
  const { recording, name, missed } = mbCountryStats;
  console.log(`musicbrainz: ${recording} through the recording, ${name} by the artist's name, ${missed} not found`);
}

for (const program of loaded) {
  const tracks = program.episodes.flatMap((e) => e.tracks ?? []);
  const count = (test) => tracks.filter(test).length;
  console.log(
    `${program.id}: ${tracks.length} tracks, ${count((t) => !('printed_country' in t))} not read yet, ` +
      `${count((t) => t.printed_country)} with a printed country, ${count((t) => t.country)} coded ` +
      `(${count((t) => t.country_from === 'archive')} from the archive, ${count((t) => t.country_from === 'musicbrainz' && t.country)} from MusicBrainz)`,
  );
}
if (unmapped.size > 0) {
  console.log(`\n${unmapped.size} printed countries not in countries.json:`);
  for (const [printed, n] of [...unmapped].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) console.log(`${n}\t${printed}`);
}
if (failures > 0) {
  console.error(`${failures} failed; run again to retry them`);
  process.exitCode = 1;
}
