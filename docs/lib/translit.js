/**
 * Folding names so a Latin spelling and the Cyrillic one whisper heard become
 * the same string.
 *
 * The host says «Портисхед» and the tracklist says «Portishead»; nothing in
 * the pipeline or on the site can match the two without a rule. The rule is
 * deliberately letter-by-letter rather than phonetic, because that is how the
 * transcript renders foreign names: `sh` is two sounds in Portis-head, so
 * there is no `sh → ш`. Irregular spellings (The Black Keys) are expected to
 * miss here and to be handled by synonyms.yaml instead.
 *
 * This module is shared: `align` imports it in node, the archive page imports
 * it in the browser. It therefore imports nothing and touches no DOM.
 */

/** Combining marks left over from NFD: Brücken and Брюкен both lose theirs. */
const COMBINING = /[\u0300-\u036f]/g;

/** Anything that is not a letter or a digit separates words. */
const SEPARATORS = /[^\p{L}\p{N}]+/gu;

/**
 * Two-letter sequences read as one Cyrillic letter. `ea → е` is what makes
 * `portishead` end in `хед`, and `ck → к` keeps Brücken one edit from Брюкен.
 */
const DIGRAPHS = new Map([
  ['ch', 'ч'],
  ['ck', 'к'],
  ['ea', 'е'],
  ['ee', 'и'],
  ['oo', 'у'],
  ['ou', 'у'],
  ['ph', 'ф'],
  ['th', 'т'],
  ['zh', 'ж'],
]);

/**
 * `y → и` rather than `й`: NFD has already flattened `й` to `и` on the
 * Cyrillic side, and a fold that produced a letter its own input can never
 * contain would not be idempotent.
 */
const LETTERS = new Map([
  ['a', 'а'],
  ['b', 'б'],
  ['c', 'к'],
  ['d', 'д'],
  ['e', 'е'],
  ['f', 'ф'],
  ['g', 'г'],
  ['h', 'х'],
  ['i', 'и'],
  ['j', 'дж'],
  ['k', 'к'],
  ['l', 'л'],
  ['m', 'м'],
  ['n', 'н'],
  ['o', 'о'],
  ['p', 'п'],
  ['q', 'к'],
  ['r', 'р'],
  ['s', 'с'],
  ['t', 'т'],
  ['u', 'у'],
  ['v', 'в'],
  ['w', 'в'],
  ['x', 'кс'],
  ['y', 'и'],
  ['z', 'з'],
]);

/**
 * Lowercase, without diacritics or punctuation, one space between words.
 * `ё` and `й` lose their marks with everything else, so «Ёжик» and «ежик» are
 * one word here.
 */
export function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(COMBINING, '')
    .replace(SEPARATORS, ' ')
    .trim();
}

/** Latin runs become Cyrillic; anything already Cyrillic passes through. */
export function latinToCyrillic(text) {
  const source = String(text ?? '');
  let out = '';
  for (let at = 0; at < source.length; ) {
    const digraph = DIGRAPHS.get(source.slice(at, at + 2));
    if (digraph !== undefined) {
      out += digraph;
      at += 2;
      continue;
    }
    const letter = LETTERS.get(source[at]);
    out += letter === undefined ? source[at] : letter;
    at += 1;
  }
  return out;
}

/**
 * The comparable form of a name: `fold('Portishead')` and `fold('Портисхед')`
 * are both `портисхед`. Folding a folded name changes nothing.
 */
export function fold(text) {
  return latinToCyrillic(normalize(text));
}
