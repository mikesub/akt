import { join } from 'node:path';
import { get } from './http.js';

export { keyOf, playlistFile } from './playlists.js';

/**
 * «Музыка на Свободе» on svoboda.org. Its podcast feed has no tracklists:
 * each episode's playlist is at the end of a separate text article, after a
 * header such as «Плей-лист программы "Музыка на Свободе" (выпуск 141):» or
 * «Плейлист "Музыки на Свободе" #356». Only that list is kept; the host's
 * commentary above it is not. An article on a two-part subject carries both
 * parts' playlists, one after the other ("выпуск 19", then "выпуск 20").
 *
 * Every playlist is a text file in programs/svoboda/playlists/ (src/playlists.js),
 * <YYYY-MM-DD>.txt for a special outside the numbering (the antiwar episodes
 * of 2022–2023). `--fetch` writes them from the articles listed in
 * programs/svoboda/articles.txt; one written by hand works the same, with or without
 * the header lines.
 */

const ROOT = join(import.meta.dirname, '..', 'programs', 'svoboda');
export const ARTICLES = join(ROOT, 'articles.txt');
export const PLAYLISTS = join(ROOT, 'playlists');
export const MISSING = join(ROOT, 'MISSING.md');
const PODCAST = 'https://www.svoboda.org/podcast/?zoneId=20483';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

const decode = (text) =>
  text.replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+));/gi, (all, hex, dec, name) =>
    hex ? String.fromCodePoint(parseInt(hex, 16)) : dec ? String.fromCodePoint(Number(dec)) : (ENTITIES[name.toLowerCase()] ?? all),
  );

/** Lines the site injects into every article body: app, Telegram and Google News promos, embed labels. */
const PROMO = new Set([
  'SoundCloud',
  'YouTube',
  'Установите Мобильное приложение Радио Свобода',
  'Установить',
  'Читайте Свободу в Телеграме',
  'Войти',
  'Подпишитесь на Свободу в Google новостях',
  'Подписаться',
]);

/** The article body, the one <div class="wsw">, up to its own closing tag. */
function bodyHtml(html) {
  const open = html.match(/<div[^>]*\bclass="wsw"[^>]*>/);
  if (!open) return null;
  const tag = /<(\/?)div\b[^>]*>/gi;
  tag.lastIndex = open.index;
  for (let depth = 0, m; (m = tag.exec(html)); ) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(open.index, m.index);
  }
  return html.slice(open.index);
}

/** HTML to its text, one line per paragraph, list item or line break. */
function textOf(html) {
  return decode(
    html
      .replace(/<(script|style|svg|noscript|iframe)\b[\s\S]*?<\/\1>/gi, '')
      .replace(/<(?:br|p|div|li|h\d|tr)\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .split('\n')
    .map((line) => line.replace(/[\u200b\ufeff]/g, '').replace(/\s+/g, ' ').trim())
    .filter((line) => line && !PROMO.has(line));
}

const HEADER = /пл[еэ]й-?\s?лист|play-?\s?list|трек-?\s?лист/i;
const ENTRY = /^\d{1,2}\s?[.)]/;

/**
 * The playlists: each header line that numbered entries follow (the
 * commentary can mention a playlist too), up to the next such header or the
 * end of the body. With no header, a list that starts at "1." and runs to
 * the end of the body.
 */
function playlistsOf(lines) {
  const starts = lines.flatMap((line, i) => (HEADER.test(line) && lines.slice(i + 1, i + 4).some((l) => ENTRY.test(l)) ? [i] : []));
  // A line that only mentions the playlist, just above its header, has no entries of its own.
  const playlists = starts.map((start, k) => lines.slice(start, starts[k + 1])).filter((p) => p.slice(1).some((l) => ENTRY.test(l)));
  if (playlists.length > 0) return playlists;
  const start = lines.findLastIndex((line) => /^1\s?[.)]/.test(line));
  return start >= 0 && lines.slice(start).every((line) => ENTRY.test(line)) ? [lines.slice(start)] : [];
}

/** The episode number in the playlist header: "(выпуск 141)", "#356", "№ 200", "307-го выпуска". */
const numberOf = (header) => {
  const match = header.match(/(?:выпуск\S*|#|№)\s*(\d{1,4})|(\d{1,4})(?:\s*-?\s*(?:го|й|ый|ой))?\s+выпуск/i);
  return match ? Number(match[1] ?? match[2]) : null;
};

/** One article: its title, date and playlists, each with its number (null for a special). */
export function readArticle(html) {
  const meta = (property) => html.match(new RegExp(`<meta content="([^"]*)" property="${property}"`))?.[1];
  const title = decode(meta('og:title') ?? html.match(/<title>([^<]*)<\/title>/)?.[1] ?? '').trim() || null;
  const date = html.match(/"datePublished":"(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
  const body = bodyHtml(html);
  const playlists = body ? playlistsOf(textOf(body)) : [];
  return { title, date, playlists: playlists.map((playlist) => ({ number: numberOf(playlist[0]), playlist })) };
}

export const fetchArticle = async (url) => {
  const html = await get(url, { as: 'text' });
  return html === null ? null : readArticle(html);
};

/** The podcast feed's episodes, newest first: { title, date, url }. It has no playlists, only the audio pages. */
export async function fetchPodcast() {
  const xml = (await get(PODCAST, { as: 'text' })) ?? '';
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, item]) => {
    const tag = (name) => decode(item.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1] ?? '').trim();
    return { title: tag('title'), date: new Date(tag('pubDate')).toISOString().slice(0, 10), url: tag('link') };
  });
}
