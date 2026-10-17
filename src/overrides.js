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

const applies = (entry, track) =>
  same(entry.artist, track.artist) &&
  (entry.track === undefined || same(entry.track, track.track)) &&
  (entry.album === undefined || same(entry.album, track.album));

/** Whether an override sets the track's country: then nothing infers one (bin/countries.js). */
export const countryOverridden = (track) => overrides.some((entry) => entry.country !== undefined && applies(entry, track));

/** The track with every matching override's fields set on it. */
export function applyOverrides(track) {
  let result = track;
  for (const entry of overrides) {
    if (!applies(entry, track)) continue;
    const fields = Object.fromEntries(Object.entries(entry).filter(([key]) => !KEYS.includes(key)));
    // A country set by hand comes from neither the archive nor MusicBrainz.
    if (fields.country !== undefined) fields.country_from = undefined;
    // A year set by hand is the owner's, ranking above every source (src/pipeline.js YEAR_RANK).
    if (fields.year != null) fields.year_from = 'owner';
    // Another song: its album and artist links are the next run's to find (src/apple.js findAppleLinks).
    if (fields.apple_id !== undefined && fields.apple_id !== result.apple_id) {
      const { apple_album_id, apple_artist_id, ...rest } = result;
      result = rest;
    }
    result = { ...result, ...fields };
  }
  return result;
}
