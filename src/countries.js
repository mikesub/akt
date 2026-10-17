import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A playlist's printed country ("USA", "UK/Germany", "РФ", "czech rep.") to
 * its codes: ISO 3166-1 alpha-2, with England, Scotland, Wales and Northern
 * Ireland as GB-ENG, GB-SCT, GB-WLS and GB-NIR, and a territory no state is
 * recognized for as X-<NAME> (X-TIBET, X-KURDISTAN). countries.json (repo root)
 * maps each spelling, lowercased, to its codes: [] for one that names no
 * country on purpose ("International", "Sahara"), null for a placeholder
 * ("?", or a joke such as "magic land"), which says nothing. A spelling not in it is read part by part
 * ("UK/USA", "Mali & France", "РФ/?"), and is unmapped unless every part is
 * in it.
 */
const FILE = join(import.meta.dirname, '..', 'countries.json');
const SEPARATORS = /\s*(?:[/,;&+]|\s[-–—]\s|\s(?:и|and)\s)\s*/u;

const table = new Map(Object.entries(JSON.parse(readFileSync(FILE, 'utf8'))));

/** The table's key for a spelling: lowercased, zero-width characters dropped, spaces trimmed and collapsed. */
export const spelling = (printed) => printed.toLowerCase().replace(/[\u200b\ufeff]/g, '').replace(/\s+/g, ' ').trim();

/** Each printed value the table has no codes for, with how many tracks print it. */
export const unmapped = new Map();

/** A printed country's table entries: the whole spelling's, else each part's; undefined for one not in the table. */
function entries(printed) {
  const key = spelling(printed);
  return table.has(key) ? [table.get(key)] : key.split(SEPARATORS).filter(Boolean).map((part) => table.get(part));
}

/** A printed country's codes, in the order printed; null when nothing is printed, it names no country, it is only a placeholder, or it is unmapped. */
export function countryCodes(printed) {
  if (!printed) return null;
  const parts = entries(printed);
  if (parts.length === 0 || parts.some((codes) => codes === undefined)) {
    unmapped.set(printed, (unmapped.get(printed) ?? 0) + 1);
    return null;
  }
  const codes = [...new Set(parts.flat().filter(Boolean))];
  return codes.length > 0 ? codes : null;
}

/**
 * Whether a printed country says too little to stand against the artist's
 * country found elsewhere: only placeholders ("?"), or only "Europe" (EU).
 * Such a track's country is inferred as for one that prints none, the
 * printed one kept when nothing better is found.
 */
export function vague(printed) {
  if (!printed) return false;
  const parts = entries(printed);
  if (parts.some((codes) => codes === undefined)) return false;
  const codes = parts.flat().filter(Boolean);
  return parts.every((codes) => codes === null) || (codes.length > 0 && codes.every((code) => code === 'EU'));
}
