import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Each artist under one spelling, the one the artist uses: playlists print
 * the same artist many ways ("2RAUMWOHNUNG", "2raum wohnung", "goat" and
 * "Goat"), FM Достоевский's later sources all in lower case. artists.json
 * (repo root) maps a spelling as printed to the one to show; bin/artists.js
 * proposes the entries, from Apple Music's credit and the archive's own
 * spellings, and only for spellings that differ in case, spacing,
 * punctuation, accents, a leading "The" or "&" for "and" (artistKey), never
 * in a letter: «2ва самолёта» stays as printed beside «Два Самолёта».
 * Applied before titles.json's names are looked up again and before the
 * lookups, so these search for the spelling shown; a lookup that had found
 * nothing is asked again only when more than the case changed. The playlist
 * files stay as their sources print them.
 */
const FILE = join(import.meta.dirname, '..', 'artists.json');
const MISSES = ['apple_id', 'mb_id', 'discogs_id'];

const spellings = new Map(Object.entries(JSON.parse(readFileSync(FILE, 'utf8'))));

/** The letters and digits of a name, without case, accents, a leading "The" or "and" for "&": one artist's spellings share it. */
export const artistKey = (name) =>
  name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ё/g, 'е')
    .replace(/Ё/g, 'Е')
    .toLowerCase()
    .replace(/^the\s+/, '')
    .replace(/\s+(and|и)\s+/g, '&')
    .replace(/[^\p{L}\p{N}&]/gu, '');

/** The track under its artist's spelling, if artists.json has another for it. */
export function restoreArtist(track) {
  const artist = track.artist && spellings.get(track.artist);
  if (!artist || artist === track.artist) return track;
  const restored = { ...track, artist };
  if (artist.toLowerCase() === track.artist.toLowerCase()) return restored;
  // Not found under the old spelling: asked again under the new one.
  return Object.fromEntries(Object.entries(restored).filter(([key, value]) => !(MISSES.includes(key) && value === null)));
}
