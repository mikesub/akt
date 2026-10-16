import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A program's playlists, one text file each in programs/<id>/playlists/: <number>.txt,
 * or <YYYY-MM-DD>.txt for a special outside the numbering. A few "key: value"
 * header lines (url, date, title, and a note on anything done by hand), a
 * blank line, then the playlist as its source prints it. Every program but
 * Stereoplan keeps its playlists this way («Музыка на Свободе», Stereo Voodoo,
 * «Песни и пляски», «Записки из подполья», «FM Достоевский»); bin/playlists.js
 * parses them into docs/data/<id>.json.
 */

const ROOT = join(import.meta.dirname, '..');
const PROGRAMS = join(ROOT, 'programs');

/** A program by its id: where its playlists are and the data file they are parsed into. Only one with a playlists directory. */
export function program(id) {
  if (!/^[a-z]+$/.test(id ?? '')) throw new Error(`not a program id: ${id}`);
  const playlists = join(PROGRAMS, id, 'playlists');
  if (!existsSync(playlists)) throw new Error(`no playlists for ${id}: programs/${id}/playlists/ does not exist`);
  return { id, playlists, data: join(ROOT, 'docs', 'data', `${id}.json`) };
}

/** Every program in programs/ with a playlists directory, by id. */
export const programs = () =>
  readdirSync(PROGRAMS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(PROGRAMS, entry.name, 'playlists')))
    .map((entry) => entry.name);

/** A playlist file's text: its header lines, a blank line, the playlist. */
export const playlistFile = ({ url, date, title, note, playlist }) =>
  `${[url && `url: ${url}`, date && `date: ${date}`, title && `title: ${title}`, note && `note: ${note}`].filter(Boolean).join('\n')}\n\n${playlist.join('\n')}\n`;

/** A playlist's file name without .txt: its number, or a special's date. */
export const keyOf = ({ number, date }) => (number === null ? date : String(number));

/** Every playlist file in a directory, numbered ones newest first, then the specials: { number, url, date, title, text }. */
export function readPlaylists(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return names
    .filter((name) => /^(\d+|\d{4}-\d{2}-\d{2})\.txt$/.test(name))
    .map((name) => {
      const lines = readFileSync(join(dir, name), 'utf8').split('\n');
      const header = {};
      while (lines.length > 0 && /^(url|date|title|note): /.test(lines[0])) {
        const [, key, value] = lines.shift().match(/^(\w+): (.*)$/);
        header[key] = value.trim();
      }
      const stem = name.slice(0, -4);
      const special = stem.includes('-');
      return {
        number: special ? null : Number(stem),
        url: header.url ?? null,
        date: special ? stem : (header.date ?? null),
        title: header.title ?? null,
        text: lines.join('\n').trim(),
      };
    })
    .sort((a, b) => (a.number === null) - (b.number === null) || b.number - a.number || (b.date ?? '').localeCompare(a.date ?? ''));
}
