#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { decode, newestDump, records } from '../src/dumps.js';
import { discogsLabelNames, labelKey, notALabel, printedSpellings, readSpellings, tidy } from '../src/labels.js';
import { readLabels } from '../src/parse.js';
import { corrected } from '../src/pipeline.js';
import { keyOf, program, programs, readPlaylists } from '../src/playlists.js';

const ROOT = join(import.meta.dirname, '..');
const FILE = join(ROOT, 'labels.json');

const USAGE = `Usage: labels [<program>…] [options]

Read with \`claude\` the label each playlist prints for its tracks parsed before the parse read labels
(2026-11-12), one call a playlist, into docs/data/<program>.json: as printed (printed_label), and the
labels shown (label: src/labels.js, through labels.json; for a track whose playlist prints none, its
Discogs release's, label_from discogs). Stereoplan's descriptions are read from
programs/stereoplan/descriptions/. Resumable: a playlist read is not read again.
Every program by default. Never run it beside another run that writes the same program's data file.

Options:
  --jobs <n>       claude calls at a time (default 4)
  --limit <n>      Read at most n playlists a program
  --recode         Ask claude nothing: only set every track's labels again from labels.json
  --spellings      Ask claude nothing: propose in labels.json one spelling for each label the archive
                   prints several ways (see below), then set every track's labels again
  --labels-dump <file>  With --spellings: Discogs' labels dump, for the spelling of a label printed
                   only in lower case (default: the newest in ../discogs/; none to leave it out)
  -h, --help       Show this help

--spellings: a label's spellings are those labelKey joins (src/labels.js: they differ in case,
spacing, punctuation, accents, a leading "The", "&" for "and", or a trailing "Records", "Recordings",
"Label", "Ltd" and the like), as printed and as Discogs names a track's release's labels. The one shown
is the archive's commonest with a capital letter ("Mute" over "mute records"); for a label printed only
in lower case, Discogs' capitals for the same words (a track's own release's, else any Discogs label's
of that name: "global symphonic" → "Global Symphonic"), else as printed. A label Discogs alone names
takes its commonest spelling there. For a key of three letters or fewer only spellings with the same
words join. A printed "a/b" that is one Discogs label's name ("v/vm test") stays one label. Adds only
spellings not in labels.json yet, so a hand edit there stays; lists every change that is more than case.
`;

let opts;
try {
  const { values, positionals } = parseArgs({
    options: {
      jobs: { type: 'string' },
      limit: { type: 'string' },
      recode: { type: 'boolean' },
      spellings: { type: 'boolean' },
      'labels-dump': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });
  if (values.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  const jobs = Number(values.jobs ?? 4);
  if (!(Number.isInteger(jobs) && jobs > 0)) throw new Error(`--jobs must be a positive integer, got: ${values.jobs}`);
  const limit = values.limit === undefined ? Infinity : Number(values.limit);
  if (!(limit > 0 && (Number.isInteger(limit) || limit === Infinity))) throw new Error(`--limit must be a positive integer, got: ${values.limit}`);
  const ids = positionals.length > 0 ? positionals : [...programs(), 'stereoplan'];
  for (const id of ids) if (id !== 'stereoplan') program(id);
  if (values.spellings && positionals.length > 0) throw new Error('--spellings goes over every program: name none');
  const dump = values['labels-dump'] === 'none' ? null : (values['labels-dump'] ?? newestDump(join(ROOT, '..', 'discogs'), 'labels'));
  if (values.spellings && dump && !existsSync(dump)) throw new Error(`no labels dump at ${dump}`);
  opts = { ids, jobs, limit, recode: (values.recode || values.spellings) ?? false, spellings: values.spellings ?? false, dump };
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
  let n = 0;
  for (const episode of program.episodes) {
    if (!episode.tracks?.some((t) => !('printed_label' in t))) continue;
    if (n >= opts.limit) break;
    const text = program.textOf(episode);
    if (text === null) console.error(`${nameOf(program.id, episode)}: no playlist text, skipped`);
    else if (hash(text) !== episode.playlist_hash) console.error(`${nameOf(program.id, episode)}: playlist changed since parsed, skipped`);
    else {
      queue.push({ program, episode, text });
      n++;
    }
  }
}

let failures = 0;
if (!opts.recode) {
  console.log(`${queue.length} playlists to read for labels`);
  let done = 0;
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const { program, episode, text } = job;
      const tracks = episode.tracks;
      try {
        const printed = await readLabels(text, tracks);
        episode.tracks = tracks.map((t, i) => corrected({ ...t, printed_label: printed[i] }));
        save(program);
        console.log(`${nameOf(program.id, episode)}: ${printed.filter(Boolean).length} of ${tracks.length} with a label (${++done} done)`);
      } catch (err) {
        failures++;
        console.error(`${nameOf(program.id, episode)}: ${err.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: opts.jobs }, worker));
} else {
  if (opts.spellings) {
    await proposeSpellings();
    readSpellings();
  }
  for (const program of loaded) {
    program.episodes = program.episodes.map((e) => ({ ...e, tracks: e.tracks?.map(corrected) ?? null }));
    save(program);
  }
}

/** labels.json's new entries (--spellings): see the usage. */
async function proposeSpellings() {
  const table = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {};
  const shown = new Set(Object.values(table).flat().filter(Boolean));
  const straight = (s) => s.replace(/[`’‘]/g, "'");
  /** Counts summed by a spelling's form: straight apostrophes, and with `form` (a "Records" off) too. */
  const tally = (entries, form = (x) => x) => {
    const counts = new Map();
    for (const [x, n] of entries) counts.set(straight(form(x)), (counts.get(straight(form(x))) ?? 0) + n);
    return counts;
  };
  const words = (s) => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/&/g, ' & ').replace(/[^\p{L}\p{N}&]+/gu, ' ').trim();
  const SUFFIX = /[\s,.]+(records?|recordings?|rec\.?|recording\s+co(mpany)?\.?|label|ltd\.?|limited|inc\.?|gmbh|llc)\.?$/i;
  const commonest = (counts) => [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  const capital = (s) => s !== s.toLowerCase();

  // Every spelling, by key: as printed (how often, where first), as Discogs names the tracks' releases' labels.
  const groups = new Map();
  const group = (key) => groups.get(key) ?? groups.set(key, { printed: new Map(), discogs: new Map(), dump: new Map(), where: new Map() }).get(key);
  const slashed = new Map(); // a printed label with a "/", whole: how often, and the Discogs labels of its tracks
  const alone = new Set(); // the keys of the labels printed on their own, not as part of an "a/b"
  for (const id of [...programs(), 'stereoplan']) {
    const episodes = loaded.find((p) => p.id === id)?.episodes ?? JSON.parse(readFileSync(join(ROOT, 'docs', 'data', `${id}.json`), 'utf8'));
    for (const e of episodes) {
      for (const t of e.tracks ?? []) {
        const own = discogsLabelNames(t.discogs_labels);
        for (const d of own) {
          const g = group(labelKey(d));
          g.discogs.set(d, (g.discogs.get(d) ?? 0) + 1);
        }
        if (!t.printed_label) continue;
        const parts = printedSpellings(t.printed_label);
        if (parts.length === 1) alone.add(labelKey(parts[0]));
        if (parts.length > 1) {
          const whole = tidy(t.printed_label);
          const x = slashed.get(whole) ?? { n: 0, own: new Set(), parts };
          x.n++;
          for (const d of own) x.own.add(d);
          slashed.set(whole, x);
        }
        for (const s of parts) {
          if (notALabel(s) || !labelKey(s)) continue;
          const g = group(labelKey(s));
          g.printed.set(s, (g.printed.get(s) ?? 0) + 1);
          if (!g.where.has(s)) g.where.set(s, `${id} ${e.number ?? e.published_at}`);
        }
      }
    }
  }

  // Discogs' spellings of every label of a key we have (a "(2)" namesake mark off), from the labels dump.
  // Its records nest <label> (sublabels), but each has one <name>: its own.
  if (opts.dump) {
    const wanted = new Set([...groups.keys(), ...[...slashed.keys()].map((s) => labelKey(s))]);
    const t0 = Date.now();
    await records(opts.dump, 'name', (rec) => {
      const name = decode(rec.slice(rec.lastIndexOf('<name>') + 6, -7)).replace(/\s\(\d+\)$/, '').trim();
      const key = name && labelKey(name);
      if (!key || !wanted.has(key)) return;
      const g = group(key);
      g.dump.set(name, (g.dump.get(name) ?? 0) + 1);
    });
    console.log(`labels dump read in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }

  // A printed "a/b" that is one Discogs label's name stays one label, its spellings in its own group; but not
  // when both parts are labels the archive prints on their own too ("world village/harmonia mundi": two).
  const kept = new Set();
  for (const [whole, x] of slashed) {
    if (whole in table || x.parts.length > 2) continue;
    const g = groups.get(labelKey(whole));
    if (![...x.own].some((d) => labelKey(d) === labelKey(whole)) && !g?.dump.size) continue;
    if (x.parts.every((part) => alone.has(labelKey(part)))) continue;
    for (const part of x.parts) {
      const counts = groups.get(labelKey(part))?.printed;
      if (!counts?.has(part)) continue;
      if (counts.get(part) > x.n) counts.set(part, counts.get(part) - x.n);
      else counts.delete(part);
    }
    const own = group(labelKey(whole));
    own.printed.set(whole, (own.printed.get(whole) ?? 0) + x.n);
    kept.add(whole);
  }

  const marks = (s) => s.normalize('NFKD').length - s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').length;
  const unaccented = (s) => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  /** The spelling with the accents another spelling of it has, printed or on a track's Discogs release ("Fremeaux & Associes" → "Frémeaux & Associés"), in its own case. */
  function accented(spelling, g) {
    // Not the labels dump's: a namesake's accents ("A" is not "Ä").
    const better = [...g.printed.keys(), ...g.discogs.keys()]
      .filter((s) => unaccented(s) === unaccented(spelling) && marks(s) > marks(spelling))
      .sort((a, b) => marks(b) - marks(a))[0];
    if (!better) return spelling;
    const theirs = [...better.normalize('NFC')];
    const ours = [...spelling.normalize('NFC')];
    if (theirs.length !== ours.length) return spelling;
    return ours.map((c, i) => (c !== c.toLowerCase() ? theirs[i].toUpperCase() : theirs[i].toLowerCase())).join('');
  }

  /** The spelling shown for a key's group: see the usage. */
  const spellingOf = (key, g) => {
    const spelling = chosen(key, g);
    return spelling && accented(spelling, g);
  };
  function chosen(key, g) {
    if (g.printed.size === 0) return commonest(tally(g.discogs)) ?? null;
    const printedCaps = tally([...g.printed].filter(([s]) => capital(s)));
    const caps = new Map(printedCaps);
    // The tracks' own Discogs releases vote for the printed spelling they share ("World Village" over "World village").
    const theirs = tally([...g.discogs].filter(([d]) => capital(d) && labelKey(d.replace(SUFFIX, '')) === key), (d) => d.replace(SUFFIX, ''));
    for (const [d, n] of theirs) if (caps.has(d)) caps.set(d, caps.get(d) + n);
    const best = commonest(caps);
    if (best) {
      // A spelling printed once or twice that splits or joins the words otherwise than the tracks' releases, as
      // often, is a typo ("Cland Estine": "Clandestine", "Hear Wego": "Hear We Go"); case and punctuation stay as printed.
      const own = tally([...g.discogs].filter(([d]) => capital(d) && labelKey(d.replace(SUFFIX, '')) === key), (d) => (SUFFIX.test(best) ? d : d.replace(SUFFIX, '')));
      const discogs = commonest(own);
      // Words as joined or split, without "The" before them and with "&" for "and".
      const split = (x) => words(x).replace(/^the /, '').replace(/ & /g, ' and ');
      if (discogs && split(discogs) !== split(best) && printedCaps.get(best) <= 2 && own.get(discogs) >= printedCaps.get(best)) return discogs;
      return best;
    }
    // Printed only in lower case: Discogs' capitals for it (the group shares its key), without a "Records" the
    // playlist leaves out; a track's own release's first, else any Discogs label's of that name.
    const printed = commonest(tally(g.printed));
    const strip = (d) => (SUFFIX.test(printed) ? d : d.replace(SUFFIX, ''));
    for (const counts of [g.discogs, g.dump]) {
      const theirs = tally([...counts].filter(([d]) => capital(d) && labelKey(strip(d)) === key), strip);
      if (theirs.size > 0) return commonest(theirs);
    }
    return printed;
  }

  let added = 0;
  const changes = [];
  for (const [key, g] of groups) {
    if (g.printed.size === 0 && g.discogs.size === 0) continue;
    const spelling = spellingOf(key, g);
    if (!spelling) continue;
    for (const [s, n] of [...g.printed, ...g.discogs]) {
      // A label kept whole is in labels.json even as it is shown, so it is not split at its "/".
      if (s in table || (!kept.has(s) && (s === spelling || shown.has(s)))) continue;
      if (key.length <= 3 && words(s) !== words(spelling)) continue;
      table[s] = spelling;
      added++;
      if (s.toLowerCase() !== spelling.toLowerCase()) changes.push(`${s}\t→ ${spelling}\t(${n}, ${g.where.get(s) ?? 'discogs'})`);
    }
  }
  const sorted = Object.fromEntries(Object.entries(table).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(FILE, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(`${added} spellings added to labels.json (${Object.keys(sorted).length} in all), ${changes.length} more than case:`);
  for (const line of changes.sort((a, b) => a.localeCompare(b))) console.log(line);
  console.log(`\n${kept.size} printed "a/b" labels kept whole, one Discogs label's name:`);
  for (const whole of [...kept].sort((a, b) => a.localeCompare(b))) console.log(`${whole}\t→ ${table[whole]}\t(${slashed.get(whole).n})`);
}

const names = new Set();
for (const program of loaded) {
  const tracks = program.episodes.flatMap((e) => e.tracks ?? []);
  const count = (test) => tracks.filter(test).length;
  for (const t of tracks) for (const n of t.label ?? []) names.add(n);
  console.log(
    `${program.id}: ${tracks.length} tracks, ${count((t) => !('printed_label' in t))} not read yet, ` +
      `${count((t) => t.printed_label)} with a printed label, ${count((t) => t.label)} with a label ` +
      `(${count((t) => t.label_from === 'discogs')} from Discogs)`,
  );
}
console.log(`${names.size} labels in all`);
if (failures > 0) {
  console.error(`${failures} failed; run again to retry them`);
  process.exitCode = 1;
}
