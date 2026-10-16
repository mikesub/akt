#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { OPTIONS, OPTIONS_USAGE, checkOptions, run } from '../src/pipeline.js';
import { program, programs } from '../src/playlists.js';

const USAGE = `Usage: playlists <program> [options]

Parse every new or edited playlist in programs/<program>/playlists/ and find its tracks on Apple Music
and MusicBrainz (and on Discogs when both leave the year out), into docs/data/<program>.json.
Years and Apple Music links only: no genres.

Programs, each with a programs/<program>/playlists/ directory: ${programs().join(', ')}.
«Музыка на Свободе» (svoboda) also has bin/svoboda.js, which fetches its playlists;
Stereoplan has bin/stereoplan.js, its playlists being its feed's episode descriptions.

Options:
${OPTIONS_USAGE}  -h, --help         Show this help
`;

let opts;
try {
  const { values, positionals } = parseArgs({ options: { ...OPTIONS, help: { type: 'boolean', short: 'h' } }, allowPositionals: true });
  if (values.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  if (positionals.length !== 1) throw new Error('name one program');
  opts = { program: program(positionals[0]), ...checkOptions(values) };
} catch (err) {
  process.stderr.write(`${err.message}\n\n${USAGE}`);
  process.exit(2);
}

try {
  if ((await run(opts.program, opts)) > 0) process.exitCode = 1;
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
}
