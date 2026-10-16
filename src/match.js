/**
 * How a playlist's names compare with a source's: artists, titles and albums
 * the same despite case, accents, punctuation, Cyrillic against Latin
 * ("Звуки Му" and "Zvuki Mu"), a leading "The", guests, spelled numbers, a
 * typo. Shared by the Apple Music, MusicBrainz and Discogs lookups.
 */

const CYRILLIC = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l',
  м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch',
  ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', і: 'i', ї: 'yi', є: 'ye', ґ: 'g', ў: 'u',
};

/** Letters that look alike in the two scripts, each way. */
const TO_LATIN = {
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's', г: 'r', п: 'n',
  А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', Х: 'X', І: 'I', Ј: 'J', Ѕ: 'S',
};
const TO_CYRILLIC = {
  a: 'а', e: 'е', o: 'о', p: 'р', c: 'с', y: 'у', x: 'х', i: 'і', ï: 'ї',
  A: 'А', B: 'В', E: 'Е', K: 'К', M: 'М', H: 'Н', O: 'О', P: 'Р', C: 'С', T: 'Т', X: 'Х', I: 'І', Ï: 'Ї',
};

/**
 * Each word that mixes the two scripts in one: a Latin word with Cyrillic
 * look-alikes («Мооn Safari», «Pour Cole Рortег», «Son оf») is written in
 * Latin, a Cyrillic one with Latin look-alikes («Воплi Вiдоплясова»,
 * «Украïни») in Cyrillic, whichever every letter allows; a word neither
 * allows («Deadушки», «Zубкерман») stays as it is.
 */
export function unmixed(text) {
  return text.replace(/[\p{L}'’`]+/gu, (word) => {
    const cyrillic = [...word].filter((c) => /\p{Script=Cyrillic}/u.test(c));
    const latin = [...word].filter((c) => /\p{Script=Latin}/u.test(c));
    if (!cyrillic.length || !latin.length) return word;
    const swap = (table) => [...word].map((c) => table[c] ?? c).join('');
    if (cyrillic.every((c) => c in TO_LATIN)) return swap(TO_LATIN);
    if (latin.every((c) => c in TO_CYRILLIC)) return swap(TO_CYRILLIC);
    return word;
  });
}

/**
 * Lowercase Latin letters and digits only: Cyrillic transliterated (the Dutch
 * store lists Звуки Му as Zvuki Mu), "&" read as "and", accents, punctuation
 * and a bracketed or "- Remastered"-style suffix dropped.
 */
export function plain(text) {
  return [...unmixed(text ?? '').toLowerCase()]
    .map((c) => CYRILLIC[c] ?? c)
    .join('')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/\s[([].*$/, '')
    .replace(/\s[-–—]\s.*\b(remaster(ed)?|version|mix|edit|mono|stereo|live)\b.*$/, '')
    .replaceAll('&', ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * A request's parameters as a source is searched for them: a backtick read
 * as the apostrophe it stands for (FM Достоевский's playlists print «Don`t»),
 * which the sources' searches do not take for one, and each word in one
 * script (see unmixed).
 */
export const searchable = (params) =>
  Object.fromEntries(Object.entries(params).map(([key, value]) => [key, unmixed(String(value)).replaceAll('`', "'")]));

/** The credit without its guests: "A ft B" is A. */
export const main = (artist) => (artist ?? '').split(/\s+(?:ft\.?|feat\.?|featuring)\s+/i)[0].trim();

/** Each name a credit lists, as written: "A & B", "A and B", "A y B", "A / B", "A, B" and "A + B" are A and B. */
export const credited = (artist) =>
  (artist ?? '').split(/\s+(?:ft\.?|feat\.?|featuring|with|vs\.?|and|&|и|y|\+)\s+|\s*[/,;]\s*/i).filter((name) => name.trim());

/** A credited name for comparing: plain, without a leading "The". */
export const bare = (name) => plain(name).replace(/^the\s+/, '');

/** The first credited name, so "A ft B", "A & B" and "A and B" all compare as A. */
export const lead = (artist) => bare(credited(artist)[0]);

function distance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    row = next;
  }
  return row[b.length];
}

/** Equal, or close enough for a typo or a transliteration variant. Never for short names. */
export function close(a, b, ratio) {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 5) return false;
  return distance(a, b) <= Math.floor(ratio * Math.max(a.length, b.length));
}

const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10, xi: 11, xii: 12 };
const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };

/** A word read as a number ("2", "ii", "two" are all "2"), else null. */
const numberOf = (word) => (/^\d+$/.test(word) ? String(Number(word)) : String(ROMAN[word] ?? WORDS[word] ?? '') || null);

/** The numbers in a plain title: "pt ii", "part 2" and "part two" all give "2". */
function numbers(title) {
  return title.split(' ').map(numberOf).filter(Boolean).sort().join(',');
}

/**
 * A plain title with its numbers as digits, "pt" as "part" and no leading
 * "the": "pt 1" and "part one" read the same, as do "The House of the Rising
 * Sun" and "House of the Rising Sun".
 */
const counted = (title) =>
  title
    .replace(/^the\s+/, '')
    .split(' ')
    .map((word) => (word === 'pt' ? 'part' : (numberOf(word) ?? word)))
    .join(' ');

/** A near title: a typo or spelling variant, never a different part ("1" against "IV"). */
export const nearTitle = (a, b) => close(a, b, 0.2) && numbers(a) === numbers(b);

/**
 * The plain forms a source's title can match: the whole title, without its
 * bracketed words ("(Rope) Away"), and each half of a bilingual one
 * ("Черные Цветы / Chernye Cvety"), but not of a medley ("Sugar Baby /
 * Kriminaltango"), whose halves are different songs.
 */
function forms(title) {
  const forms = [plain(title), plain((title ?? '').replace(/\s*[([][^)\]]*[)\]]\s*/g, ' '))];
  const halves = (title ?? '').split(/\s+\/\s+/).map(plain);
  if (halves.length === 2 && close(halves[0], halves[1], 0.3)) forms.push(...halves);
  return [...new Set(forms)].filter(Boolean);
}

export const squash = (text) => text.replaceAll(' ', '');

/** The host's title and a source's are the same, spaces and spelled numbers aside ("Kriminal Tango", "Kriminaltango"). */
export const sameTitle = (host, other) =>
  forms(other).some((form) => squash(counted(form)) === squash(counted(plain(host))));

/** The host's title and a source's are near (see nearTitle). */
export const nearTitles = (host, other) => forms(other).some((form) => nearTitle(counted(plain(host)), counted(form)));

/**
 * Album titles compare like song titles, spaces aside ("In Flux", "inFLUX"),
 * and with or without a subtitle after a dash ("Nouse Luonto - Lauluja Monimuotoisuudesta").
 */
export const sameAlbum = (host, other) => {
  const want = squash(plain(host));
  if (want === '') return false;
  return [other, (other ?? '').split(/\s[-–—]\s/)[0]].some((title) => squash(plain(title)) === want);
};

/**
 * The same artist: the host's first credited name is one of the source's, or
 * the source's first is one of the host's (guests after "ft" aside), so
 * "Janis Joplin / Big Brother & The Holding Company" and "Big Brother & The
 * Holding Company & Janis Joplin" match, and a typo or transliteration passes.
 */
export const sameArtist = (host, other) => {
  const hosts = credited(main(host)).map(bare).filter(Boolean);
  const others = credited(main(other)).map(bare).filter(Boolean);
  if (hosts.length === 0 || others.length === 0) return false;
  return others.some((name) => close(hosts[0], name, 0.2)) || hosts.some((name) => close(name, others[0], 0.2));
};
