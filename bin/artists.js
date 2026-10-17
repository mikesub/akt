#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { lookupSongs } from '../src/apple.js';
import { artistKey } from '../src/artists.js';
import { programs } from '../src/playlists.js';

const ROOT = join(import.meta.dirname, '..');
const FILE = join(ROOT, 'artists.json');

const USAGE = `Usage: artists [options]

Propose in artists.json one spelling for each artist the archive prints several ways, or only in lower
or upper case: spellings that differ in case, spacing, punctuation, accents, a leading "The" or "&"
for "and", never in a letter. The spelling is Apple Music's credit for the artist's tracks, else the
archive's most common one in mixed case, without quotation marks around it; but the archive's mixed
case wins over Apple's all-caps or all-lowercase styling and, for a Cyrillic name, over Apple's
capitals, and over Apple's when it has more punctuation for the same words ("Tam 'Echo' Tam"); an
accent the archive has is never dropped; apostrophes are straight. Apple's names come tidied, and a
garbled one ("HÃ¤ckner") is left out. A spelling that differs in more than case,
punctuation and accents (spaces between words, "The", "&" for "and") joins only when Apple credits its
own tracks so: "The Night Caps" and "Nightcaps" are two bands; and so must any change to a name of
three letters or fewer ("M", "S."), where different artists share the letters. Asks Apple about every linked track (a few minutes, by id in batches). Adds only
spellings not in artists.json yet, so a hand edit there stays; lists every change that is more than
case. Any run of the pipeline, or node bin/countries.js --recode, then applies it.

Options:
  -h, --help   Show this help
`;

try {
  const { values } = parseArgs({ options: { help: { type: 'boolean', short: 'h' } } });
  if (values.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
} catch (err) {
  process.stderr.write(`${err.message}\n\n${USAGE}`);
  process.exit(2);
}

const table = JSON.parse(readFileSync(FILE, 'utf8'));
const shown = new Set(Object.values(table));

const strip = (s) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ё/g, 'е').replace(/Ё/g, 'Е');
const marks = (s) => s.normalize('NFKD').length - strip(s).length + (s.match(/[ёЁ]/g) ?? []).length;
const flat = (s) => s === s.toLowerCase() || s === s.toUpperCase();
const cyrillic = (s) => /\p{Script=Cyrillic}/u.test(s);
/** A name without quotation marks around it: Svoboda prints «"Кино"». */
const unquoted = (s) => s.match(/^["«“„'‘](.+)["»”“'’]$/u)?.[1].trim() ?? s;
/** A name's words without case, accents or punctuation: spellings that share it differ in no more than those. */
const words = (s) => strip(s).toLowerCase().replace(/&/g, ' & ').replace(/[^\p{L}\p{N}&]+/gu, ' ').trim();
const commonest = (counts) => [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
/** Straight apostrophes: the archive prints `, ’ and ' for one. */
const straight = (s) => s.replace(/[`’]/g, "'");
/** How much punctuation a name has. */
const punctuation = (s) => (s.match(/[^\p{L}\p{N}\s]/gu) ?? []).length;
/** Apple's credit, spaces tidied; null when it is garbled (UTF-8 read as Latin-1). */
const tidy = (name) => (!name || /Ã[\u0080-\u00BF]/u.test(name) ? null : name.replace(/[\u200b\ufeff]/g, '').replace(/\s+/g, ' ').trim());

// Every spelling of each artist in the archive, how often, where first, and the tracks with an Apple Music link.
const groups = new Map();
for (const id of [...programs(), 'stereoplan']) {
  for (const episode of JSON.parse(readFileSync(join(ROOT, 'docs', 'data', `${id}.json`), 'utf8'))) {
    for (const t of episode.tracks ?? []) {
      const key = t.artist && artistKey(t.artist);
      if (!key) continue;
      const g = groups.get(key) ?? { spellings: new Map(), where: new Map(), apple: [], appleOf: new Map() };
      groups.set(key, g);
      g.spellings.set(t.artist, (g.spellings.get(t.artist) ?? 0) + 1);
      if (!g.where.has(t.artist)) g.where.set(t.artist, `${id} ${episode.number ?? episode.published_at}`);
      if (t.apple_id) {
        g.apple.push(t.apple_id);
        g.appleOf.set(t.artist, [...(g.appleOf.get(t.artist) ?? []), t.apple_id]);
      }
    }
  }
}

// Only the artists with a spelling still to settle.
const open = [...groups.values()].filter((g) => [...g.spellings.keys()].some((s) => !(s in table) && !shown.has(s) && (g.spellings.size > 1 || flat(s))));
const songs = await lookupSongs(open.flatMap((g) => g.apple));

/** One artist's spelling: Apple's, else the archive's mixed case, as the usage says; null when neither has one. */
function spellingOf(key, g) {
  const apple = new Map();
  for (const id of g.apple) {
    const name = tidy(songs.get(id)?.artistName);
    if (name && artistKey(name) === key) apple.set(name, (apple.get(name) ?? 0) + 1);
  }
  const unquotedCounts = new Map();
  for (const [s, n] of g.spellings) {
    const name = straight(unquoted(s));
    if (!flat(name)) unquotedCounts.set(name, (unquotedCounts.get(name) ?? 0) + n);
  }
  const mixed = commonest(unquotedCounts);
  let spelling = commonest(apple);
  if (!spelling || (mixed && (flat(spelling) || cyrillic(spelling)))) spelling = mixed;
  else if (mixed && words(mixed) === words(spelling) && punctuation(mixed) > punctuation(spelling) && marks(mixed) >= marks(spelling)) spelling = mixed;
  if (!spelling) return null;
  spelling = straight(spelling);
  // An accent the archive prints and the spelling lacks: put back, in the spelling's case.
  const same = (s) => strip(s).toLowerCase() === strip(spelling).toLowerCase() && [...s].length === [...spelling].length;
  const accented = [...g.spellings.keys()].filter((s) => same(s) && marks(s) > marks(spelling)).sort((a, b) => marks(b) - marks(a))[0];
  if (accented) {
    const theirs = [...accented.normalize('NFC')];
    spelling = [...spelling.normalize('NFC')].map((c, i) => (c === c.toUpperCase() ? theirs[i].toUpperCase() : theirs[i].toLowerCase())).join('');
  }
  return spelling;
}

let added = 0;
const changes = [];
for (const g of open) {
  const key = artistKey([...g.spellings.keys()][0]);
  const spelling = spellingOf(key, g);
  if (!spelling) continue;
  for (const [s, n] of g.spellings) {
    if (s === spelling || s in table || shown.has(s)) continue;
    // More than case, punctuation and accents: only when Apple credits this spelling's own tracks so.
    const own = (g.appleOf.get(s) ?? []).map((id) => tidy(songs.get(id)?.artistName)).filter(Boolean);
    const credited = own.some((name) => words(name) === words(spelling));
    if (words(s) !== words(spelling) && !credited) continue;
    if (key.length <= 3 && s.toLowerCase() !== spelling.toLowerCase() && !credited) continue;
    table[s] = spelling;
    added++;
    if (s.toLowerCase() !== spelling.toLowerCase()) changes.push(`${s}\t→ ${spelling}\t(${n}, ${g.where.get(s)})`);
  }
}

const sorted = Object.fromEntries(Object.entries(table).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(FILE, `${JSON.stringify(sorted, null, 2)}\n`);
console.log(`${added} spellings added to artists.json (${Object.keys(sorted).length} in all), ${changes.length} more than case:`);
for (const line of changes.sort((a, b) => a.localeCompare(b))) console.log(line);
