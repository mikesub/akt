#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { OPTIONS, OPTIONS_USAGE, checkOptions, run } from '../src/pipeline.js';
import { keyOf, playlistFile, program, readPlaylists as readPlaylistsIn } from '../src/playlists.js';
import { ARTICLES, MISSING, PLAYLISTS, fetchArticle, fetchPodcast } from '../src/svoboda.js';

const USAGE = `Usage: svoboda [options]

«Музыка на Свободе»: parse every new or edited playlist in programs/svoboda/playlists/ and find its tracks
on Apple Music, MusicBrainz and Discogs, into
docs/data/svoboda.json, as \`node bin/playlists.js svoboda\` does. Years and Apple Music links
only: no genres.

Options:
  --fetch            Only fetch every article in programs/svoboda/articles.txt that has no playlist
                     file yet, and list what is still missing in programs/svoboda/MISSING.md
  --all              With --fetch, every article, for playlists not filed yet; never
                     overwrites a file
${OPTIONS_USAGE}  -h, --help         Show this help
`;

function options() {
  const { values } = parseArgs({
    options: {
      fetch: { type: 'boolean' },
      all: { type: 'boolean' },
      ...OPTIONS,
      help: { type: 'boolean', short: 'h' },
    },
  });
  return { help: values.help ?? false, fetch: values.fetch ?? false, all: values.all ?? false, ...checkOptions(values) };
}

const readPlaylists = () => readPlaylistsIn(PLAYLISTS);

/** Numbers as ranges: 1, 3–5, 9. */
function ranges(numbers) {
  const out = [];
  for (const n of numbers) {
    const last = out.at(-1);
    if (last && n === last[1] + 1) last[1] = n;
    else out.push([n, n]);
  }
  return out.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(', ');
}

/**
 * Every listed article without a playlist file yet (with `all`, every one),
 * fetched and read; its playlists written, and what could not be had listed
 * in MISSING.md. A playlist already filed from that article is left as it is.
 */
async function fetchPlaylists({ all }) {
  const urls = readFileSync(ARTICLES, 'utf8').split('\n').map((line) => line.trim()).filter((line) => line.startsWith('http'));
  const filed = readPlaylists();
  const have = new Set(filed.map((p) => p.url));
  const todo = all ? urls : urls.filter((url) => !have.has(url));
  console.log(`${urls.length} articles, ${todo.length} to fetch`);

  mkdirSync(PLAYLISTS, { recursive: true });
  const problems = [];
  let written = 0;
  for (const url of todo) {
    let article;
    try {
      article = await fetchArticle(url);
    } catch (err) {
      problems.push({ url, why: err.message });
      continue;
    }
    if (!article) problems.push({ url, why: 'not found' });
    else if (article.playlists.length === 0) problems.push({ url, ...article, why: 'no playlist' });
    // Done when it has as many files as playlists, under whatever numbers (some were renumbered by hand).
    const playlists = article?.playlists ?? [];
    if (filed.filter((p) => p.url === url).length >= playlists.length) continue;
    for (const { number, playlist } of playlists) {
      // A playlist with no number is a special outside the numbering, filed under its date.
      const key = number !== null || article.date ? keyOf({ number, date: article.date }) : null;
      const file = key && join(PLAYLISTS, `${key}.txt`);
      if (!file) problems.push({ url, ...article, why: 'a playlist with neither a number nor a date' });
      else if (filed.some((p) => p.url === url && keyOf(p) === key)) continue;
      else if (existsSync(file)) problems.push({ url, ...article, why: `a second playlist ${key}` });
      else {
        writeFileSync(file, playlistFile({ url, ...article, playlist }));
        written++;
      }
    }
  }
  console.log(`${written} playlists written, ${problems.length} articles without one`);
  writeMissing(problems, await fetchPodcast());
}

function writeMissing(problems, podcast) {
  const playlists = readPlaylists();
  const numbers = new Set(playlists.map((p) => p.number).filter((n) => n !== null));
  const top = Math.max(0, ...numbers);
  const gaps = Array.from({ length: top }, (_, i) => i + 1).filter((n) => !numbers.has(n));
  const last = playlists.map((p) => p.date).filter(Boolean).sort().at(-1) ?? '';
  const newer = podcast.filter((item) => item.date > last);
  const link = ({ date, title, url }) => `- ${date ?? '????-??-??'} [${title ?? url}](${url})`;
  // Many newer episodes repeat an older one's title, or one part of it ("Башибузук. …"): likely a
  // rerun, whose playlist is already here. A part shared by two playlists says nothing.
  const plain = (title) => (title ?? '').toLowerCase().replaceAll('ё', 'е').replace(/[^\p{L}\p{N}]/gu, '');
  const parts = (title) => [...new Set((title ?? '').split(/(?<=[.!?:])\s+/).map(plain))].filter((part) => part.length >= 8 && part !== 'музыканасвободе');
  const byTitle = new Map(playlists.filter((p) => p.title).map((p) => [plain(p.title), p]));
  const byPart = new Map();
  for (const p of playlists) for (const part of parts(p.title)) byPart.set(part, byPart.has(part) ? null : p);
  const nameOf = (p) => (p.number === null ? p.date : `#${p.number}`);
  const rerun = (item) => {
    const same = byTitle.get(plain(item.title));
    if (same) return `same title as ${nameOf(same)}`;
    const like = parts(item.title).map((part) => byPart.get(part)).find(Boolean);
    return like ? `a title like ${nameOf(like)}'s, «${like.title}»` : null;
  };
  const reruns = newer.filter(rerun).length;

  const lines = [
    '# Музыка на Свободе: missing playlists',
    '',
    `Written by \`node bin/svoboda.js --fetch\`. ${playlists.length} playlists, #1 to #${top}.`,
    'Add one as `programs/svoboda/playlists/<number>.txt` (the playlist as printed; header lines optional),',
    'or its article to `programs/svoboda/articles.txt`, then run `node bin/svoboda.js --fetch` again.',
    '',
    `## Episode numbers with no playlist (${gaps.length})`,
    '',
    gaps.length > 0 ? ranges(gaps) : 'None.',
    '',
    `## Listed articles with no usable playlist (${problems.length})`,
    '',
    ...(problems.length > 0 ? problems.map((p) => `${link(p)}: ${p.why}`) : ['None.']),
    '',
    `## Podcast episodes after the last playlist (${newer.length})`,
    '',
    `Newer than ${last || 'any playlist'}. The feed links only their audio pages, which carry no playlist.`,
    `${reruns} of them have the title, or part of the title, of an episode already here, so are likely reruns of it.`,
    '',
    ...(newer.length > 0 ? newer.map((item) => link(item) + (rerun(item) ? `: ${rerun(item)}` : '')) : ['None.']),
    '',
  ];
  writeFileSync(MISSING, lines.join('\n'));
  console.log(`missing: ${gaps.length} numbers up to #${top}, ${problems.length} articles, ${newer.length} newer podcast episodes, ${reruns} of them likely reruns (programs/svoboda/MISSING.md)`);
}

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

if (opts.fetch) {
  await fetchPlaylists(opts);
  process.exit(0);
}

try {
  if ((await run(program('svoboda'), opts)) > 0) process.exitCode = 1;
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
}
