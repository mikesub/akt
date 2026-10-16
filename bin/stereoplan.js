#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { parseTracklist } from '../src/parse.js';
import { OPTIONS, OPTIONS_USAGE, checkOptions, run } from '../src/pipeline.js';
import { fetchFeed } from '../src/stereoplan.js';

const ROOT = join(import.meta.dirname, '..');
/** Each episode's description as the feed has it, so the playlists outlive the feed. */
const DESCRIPTIONS = join(ROOT, 'programs', 'stereoplan', 'descriptions');

const USAGE = `Usage: stereoplan [options]

«Стереоплан Троицкого»: fetch the feed, keep each episode's description in
programs/stereoplan/descriptions/, parse every new or edited one and find its tracks on Apple Music
and MusicBrainz (and on Discogs when both leave the year out), into
docs/data/stereoplan.json, as \`node bin/playlists.js\` does for the other programs.

Options:
${OPTIONS_USAGE}  -h, --help         Show this help
`;

let opts;
try {
  const { values } = parseArgs({ options: { ...OPTIONS, help: { type: 'boolean', short: 'h' } } });
  if (values.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  opts = checkOptions(values);
} catch (err) {
  process.stderr.write(`${err.message}\n\n${USAGE}`);
  process.exit(2);
}

try {
  const feed = await fetchFeed();

  // The raw descriptions, <number>.html (the guid for an unnumbered one), kept as published: an edit
  // upstream overwrites the file, so its git history is the record.
  mkdirSync(DESCRIPTIONS, { recursive: true });
  for (const item of feed) {
    const file = join(DESCRIPTIONS, `${item.number ?? item.guid}.html`);
    const text = `${item.description.trim()}\n`;
    if (!existsSync(file) || readFileSync(file, 'utf8') !== text) writeFileSync(file, text);
  }

  // The feed owns every episode field; keyed by guid, its numbers being read from the titles.
  const playlists = feed.map((item) => ({
    number: item.number,
    date: item.published_at,
    text: item.description,
    fields: {
      guid: item.guid,
      number: item.number,
      title: item.title,
      published_at: item.published_at,
      url: item.url,
      mp3_url: item.mp3_url,
      duration_sec: item.duration_sec,
    },
  }));
  const program = { id: 'stereoplan', data: join(ROOT, 'docs', 'data', 'stereoplan.json'), read: () => playlists, parse: parseTracklist };
  if ((await run(program, opts)) > 0) process.exitCode = 1;
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
}
