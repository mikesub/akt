import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fold } from '../docs/lib/translit.js';
import { UsageError } from './errors.js';

/**
 * Artist aliases, read from a flat subset of YAML.
 *
 * Two consumers need the same groups: `align`, to recognise «Битлз» as The
 * Beatles in a transcript, and the site's search. A YAML package would be a
 * third runtime dependency for a file of the shape
 *
 *   The Beatles: [Beatles, Битлз]
 *   Depeche Mode:
 *     - Депеш Мод
 *
 * so this reader supports exactly that and refuses anything else, with the
 * line number, rather than guessing at real YAML.
 */

export const DEFAULT_SYNONYMS_PATH = join(import.meta.dirname, '..', 'synonyms.yaml');

const COMMENT = /^\s*#/;
const ALIAS = /^\s+-\s*(.+)$/;
const GROUP = /^(\S[^:]*):\s*(.*)$/;

/** `[a, b]`, `"a"` and `'a'` are the only quoting this subset understands. */
function names(list) {
  const inner = list.trim().replace(/^\[(.*)]$/, '$1');
  return inner
    .split(',')
    .map((name) => name.trim().replace(/^['"](.*)['"]$/, '$1'))
    .filter((name) => name !== '');
}

/** Every folded name of a group points at the one shared list of names. */
function register(map, group, name) {
  const key = fold(name);
  if (key === '') return;
  if (!group.includes(name)) group.push(name);
  map.set(key, group);
}

/**
 * A Map from every folded name to the whole group it belongs to. A name that
 * appears in two groups belongs to the later one.
 */
export function parseSynonyms(text) {
  const map = new Map();
  let group = null;

  for (const [index, raw] of String(text ?? '')
    .split('\n')
    .entries()) {
    const line = raw.replace(/\s+$/, '');
    if (line === '' || COMMENT.test(line)) continue;

    const alias = ALIAS.exec(line);
    if (alias) {
      if (group === null) throw new Error(`line ${index + 1}: an alias before any name: ${line}`);
      register(map, group, names(alias[1])[0] ?? '');
      continue;
    }

    const named = GROUP.exec(line);
    if (!named) {
      const shape = 'expected "Name: [alias, ...]" or an indented "- alias"';
      throw new Error(`line ${index + 1}: ${shape}, got: ${line.trim()}`);
    }
    group = [];
    register(map, group, named[1].trim());
    for (const alias of named[2] === '' ? [] : names(named[2])) register(map, group, alias);
  }

  return map;
}

/**
 * The groups on disk. Aliases are optional, so a missing file is an empty Map;
 * a file that is there but unreadable is a usage error, because a typo in it
 * would otherwise quietly change how every episode is aligned.
 */
export function loadSynonyms(path = DEFAULT_SYNONYMS_PATH) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return new Map();
    throw err;
  }
  try {
    return parseSynonyms(text);
  } catch (err) {
    throw new UsageError(`${path}: ${err.message}`);
  }
}
