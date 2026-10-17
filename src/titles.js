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

/** Whether a track's name is the entry's, as printed or as the entry restores it. */
const named = (entry, track, key) => entry[key] === undefined || same(entry[key], track[key]) || same(entry.restore[key], track[key]);

/**
 * The track under its restored names, if an entry names it: as printed, or
 * partly restored already (an entry that has since restored the title too
 * still finds a track that has only its artist restored). One of its names
 * must still be as printed, so a track that already had the restored names
 * (the same song elsewhere in the archive) is never touched.
 */
export function restoreTitle(track) {
  const printed = (e) => NAMES.some((key) => e[key] !== undefined && same(e[key], track[key]));
  const entry = titles.find((e) => printed(e) && NAMES.every((key) => named(e, track, key)));
  if (!entry) return track;
  const restored = { ...track, ...Object.fromEntries(NAMES.filter((key) => key in entry.restore).map((key) => [key, entry.restore[key]])) };
  if (NAMES.every((key) => restored[key] === track[key])) return track;
  // Not found under the old names: asked again under the new ones.
  // A Discogs miss takes its (empty) master with it; a master alone may well be empty.
  const missed = (key, value) => (MISSES.includes(key) && value === null) || (key === 'discogs_master_id' && restored.discogs_id === null);
  return Object.fromEntries(Object.entries(restored).filter(([key, value]) => !missed(key, value)));
}
