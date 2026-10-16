import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A playlist's printed country ("USA", "UK/Germany", "РФ", "czech rep.") to
 * its codes: ISO 3166-1 alpha-2, with England, Scotland, Wales and Northern
 * Ireland as GB-ENG, GB-SCT, GB-WLS and GB-NIR. countries.json (repo root)
 * maps each spelling, lowercased, to its codes ([] for one that names no
 * country); a spelling not in it is read part by part ("UK/USA", "Mali &
 * France"), and is unmapped unless every part is in it.
 */
const FILE = join(import.meta.dirname, '..', 'countries.json');
const SEPARATORS = /\s*(?:[/,;&+]|\s[-–—]\s|\s(?:и|and)\s)\s*/u;

const table = new Map(Object.entries(JSON.parse(readFileSync(FILE, 'utf8'))));

/** The table's key for a spelling: lowercased, zero-width characters dropped, spaces trimmed and collapsed. */
export const spelling = (printed) => printed.toLowerCase().replace(/[\u200b\ufeff]/g, '').replace(/\s+/g, ' ').trim();

/** Each printed value the table has no codes for, with how many tracks print it. */
export const unmapped = new Map();

/** A printed country's codes, in the order printed; null when nothing is printed, it names no country, or it is unmapped. */
export function countryCodes(printed) {
  if (!printed) return null;
  const whole = table.get(spelling(printed));
  const parts = whole ? [whole] : spelling(printed).split(SEPARATORS).filter(Boolean).map((part) => table.get(part));
  if (parts.length === 0 || parts.some((codes) => codes === undefined)) {
    unmapped.set(printed, (unmapped.get(printed) ?? 0) + 1);
    return null;
  }
  const codes = [...new Set(parts.flat())];
  return codes.length > 0 ? codes : null;
}
