import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Original names restored by hand, for a playlist that prints them in
 * another form: FM Достоевский's early playlists, from the XLS, give Russian
 * names in Latin letters, transliterated («Zvuki Mu») or translated («NOM —
 * Love Of An Engineer»). Each entry names an artist and a track, an album, or
 * both, as the playlist prints them, then `restore`, the names to show
 * instead (an artist, track or album the artist really released, as on
 * MusicBrainz or elsewhere in the archive), and `why`, where they come from.
 * Applied before the lookups, so these search for the restored names; a
 * lookup that had found nothing under the old names is asked again, one that
 * had found the song is kept. The playlist files stay as their sources
 * print them.
 */
const FILE = join(import.meta.dirname, '..', 'titles.json');
const NAMES = ['artist', 'track', 'album'];
const MISSES = ['apple_id', 'mb_id', 'discogs_id'];

const same = (a, b) => (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();

const titles = JSON.parse(readFileSync(FILE, 'utf8'));

/** The track under its restored names, if an entry names it as printed. */
export function restoreTitle(track) {
  const entry = titles.find(
    (e) => same(e.artist, track.artist) && (e.track === undefined || same(e.track, track.track)) && (e.album === undefined || same(e.album, track.album)),
  );
  if (!entry) return track;
  const restored = { ...track, ...Object.fromEntries(NAMES.filter((key) => key in entry.restore).map((key) => [key, entry.restore[key]])) };
  if (NAMES.every((key) => restored[key] === track[key])) return track;
  // Not found under the old names: asked again under the new ones.
  return Object.fromEntries(Object.entries(restored).filter(([key, value]) => !(MISSES.includes(key) && value === null)));
}
