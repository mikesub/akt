import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Hand corrections, for what no source gets right (a song Apple only has on
 * a reissue). Each entry names an artist and a track, an album, or both, and
 * the fields to set; `why` says where the value comes from. Applied on every
 * run, after the Apple Music and MusicBrainz lookups, so a --relink never
 * undoes them.
 */
const FILE = join(import.meta.dirname, '..', 'overrides.json');
const KEYS = ['artist', 'track', 'album', 'why'];

const same = (a, b) => (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();

const overrides = JSON.parse(readFileSync(FILE, 'utf8'));

/** The track with every matching override's fields set on it. */
export function applyOverrides(track) {
  let result = track;
  for (const entry of overrides) {
    const applies =
      same(entry.artist, track.artist) &&
      (entry.track === undefined || same(entry.track, track.track)) &&
      (entry.album === undefined || same(entry.album, track.album));
    if (!applies) continue;
    const fields = Object.fromEntries(Object.entries(entry).filter(([key]) => !KEYS.includes(key)));
    result = { ...result, ...fields };
  }
  return result;
}
