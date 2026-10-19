#!/usr/bin/env node
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * «FM Достоевский» (#1–#820): rebuild every programs/fmd/playlists/<number>.txt from
 * the sources saved in programs/fmd/sources/ (see programs/fmd/NOTES.md), offline and
 * deterministically, plus programs/fmd/CROSSCHECK.md (how the sources agree where
 * they overlap) and programs/fmd/MISSING.md (what no source has, or has only in part).
 *
 * Each file is laid out as programs/svoboda/playlists/*.txt: url/date/title/note
 * lines, a blank line, then the playlist, one entry per line as the source
 * prints it (the host's per-track notes, footers and site chrome dropped).
 * Nothing is parsed into tracks here: the pipeline does that later.
 *
 * Source per episode, highest first: Финам FM's pages (and its 2010 RSS),
 * fmd.soyuz.ru's pages and #802's print page (the program's own sites) >
 * radar.lv's episode posts > the playlists in a fans' collection's mp3 tags >
 * radar.lv's CUE sheets > the XLS export of radar.lv's dead playlist database >
 * the owner's lists, by ear > Tilgor Kraut's spreadsheet of that database,
 * unless a lower source has the complete list where the higher one is cut short.
 *
 * Usage: node bin/fmd-playlists.js
 */

const ROOT = join(import.meta.dirname, '..', 'programs', 'fmd');
const SOURCES = join(ROOT, 'sources');
const PLAYLISTS = join(ROOT, 'playlists');
const FIRST = 1;
const LAST = 820;
/** Finam FM's own count: its №1 aired 05.09.2010 as #702. */
const FINAM_OFFSET = 701;

/**
 * Copies filed under the wrong number. radar.lv's post «FM Достоевский 148 от
 * 8 декабря 1999 года» and its CUE sheet N148_1999.12.08 hold the list the XLS
 * gives #147, dated 1999-12-08 too; the XLS's #148 (1999-12-15) is another
 * list, and the weekly run (#146 on 12-01, #149 on 12-22) leaves 12-08 to #147.
 */
const MOVED = {
  'radar.lv/node/998': { number: 147, why: 'radar.lv files it as #148, but its list and its date (8 Dec 1999) are the XLS\'s #147: the weekly run (#146 on 1 Dec, #149 on 22 Dec) makes 8 Dec #147, and the XLS\'s #148 (15 Dec) is another list' },
  'FM_Dostoevsky_N148_1999.12.08.cue': { number: 147, why: 'the sheet is named #148, but its songs and date (1999-12-08) are the XLS\'s #147' },
};

/**
 * Air dates no source gets right, with why. fmd.soyuz.ru dates #595 and #596
 * both 2008-08-18 (a Monday); the fans' collection names them «17.08.2008» and
 * «24.08.2008», a week apart, as every other episode then. radar.lv's playlist
 * database dates #318 2003-04-05, as it does #317 (Tilgor Kraut's spreadsheet). radar.lv's CUE sheet
 * dates #683 2010-04-24; Эхо Москвы's listing has it on 25.04.2010 at 01:08,
 * the Saturday-night slot every other episode then is dated by (Sunday's date),
 * as the fans' collection does.
 */
const DATES = {
  595: { date: '2008-08-17', why: "2008-08-17, as the fans' collection names it («595. #595 17.08.2008.mp3»), a week after #594 and before #596; fmd.soyuz.ru gives 2008-08-18, a Monday, which it gives #596 too" },
  596: { date: '2008-08-24', why: "2008-08-24, as the fans' collection names it («596. #596 24.08.2008.mp3»), a week after #595 and before #597 (2008-08-31); fmd.soyuz.ru gives 2008-08-18, #595's" },
  683: { date: '2010-04-25', why: "2010-04-25, the Sunday it aired at 01:08 on Эхо Москвы (its program listing), as the fans' collection names it («683. #683 25.04.2010.mp3»); radar.lv's CUE sheet says 2010-04-24" },
  666: { date: '2009-12-27', why: "2009-12-27, the Sunday between #665 (2009-12-20) and #667 (2010-01-03), the weekly slot then, as Tilgor Kraut's spreadsheet has it; the owner's list has no date" },
  318: { date: '2003-04-12', why: "2003-04-12, as fmd.soyuz.ru has it, a week after #317 (2003-04-05 in Tilgor Kraut's spreadsheet, the only source of #317) and before #319 (2003-04-19); radar.lv's post and CUE sheet and the XLS, all from radar.lv's playlist database, give 2003-04-05, #317's date" },
};

/** Copies left out, with why. */
const IGNORED = {
  'FM_Dostoevsky_N675_2010.02.28_0.cue':
    "#675's second sheet: #675's timings, but the names of #674's 16 songs (as #674's own sheet has them) plus a 17th, «zakopower \"kiebys ty\"»",
};

// ---------------------------------------------------------------- helpers

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', bdquo: '„', copy: '©' };

const decode = (text) =>
  text.replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+));/gi, (all, hex, dec, name) =>
    hex ? String.fromCodePoint(parseInt(hex, 16)) : dec ? String.fromCodePoint(Number(dec)) : (ENTITIES[name.toLowerCase()] ?? all),
  );

const clean = (line) => line.replace(/[\u200b\ufeff]/g, '').replace(/\s+/g, ' ').trim();

/** HTML to its text, one line per paragraph, list item, row or line break. */
const textLines = (html) =>
  decode(
    html
      .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(?:br|p|div|li|h\d|tr|table)\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .split(/\r\n|\r|\n/)
    .map(clean)
    .filter(Boolean);

const readJson = (...path) => JSON.parse(readFileSync(join(SOURCES, ...path), 'utf8'));

const iso = (d, m, y) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** "21.10.2002", "04/03/2012", "2009.01.25" to YYYY-MM-DD; null if it is no date. */
function isoDate(text) {
  let m = text?.match(/(\d{1,2})[./](\d{1,2})[./](\d{4})/);
  if (m) return valid(iso(m[1], m[2], m[3]));
  m = text?.match(/(\d{4})\.(\d{2})\.(\d{2})/);
  return m ? valid(iso(m[3], m[2], m[1])) : null;
}
const valid = (date) => {
  const [y, m, d] = date.split('-').map(Number);
  return m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1997 && y <= 2013 ? date : null;
};

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

/** A numbered playlist line: "1. artist …", "1 artist …", "1.artist …", "1) …". */
const NUMBERED = /^(\d{1,2})(?:\s*[.)]\s*|\s+)(?=\S)/;
/** What sets an entry apart from a note that happens to start with a number. */
const LOOKS_LIKE_ENTRY = /\bcd\b|"|'|«/i;

/**
 * Entries run together on one line ("… (domino)16 fraser fifield …", or a
 * whole list in one paragraph): split where the next number follows a
 * closing parenthesis.
 */
function splitRunTogether(line) {
  const first = Number(line.match(NUMBERED)?.[1]);
  if (!first) return [line];
  const parts = [];
  let rest = line;
  for (let next = first + 1; ; next++) {
    const at = rest.search(new RegExp(`\\)\\s*${next}\\s*[.)]?\\s*(?=[^\\s.)])`));
    if (at < 0) break;
    parts.push(rest.slice(0, at + 1).trim());
    rest = rest.slice(at + 1).trim();
  }
  return [...parts, rest];
}

/**
 * The playlist in a run of text lines: from the first numbered entry to the
 * last line that continues it. A number alone on its line takes the next line
 * as its entry ("1." then "artist (country) …", as Finam's №7–№8 print them).
 * A note between two entries is skipped when the next line carries the next
 * number («album of 2012 - I» after #816's 13th, before its 14th and 15th).
 */
function entriesIn(lines) {
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (/^\d{1,2}\s*[.)]?$/.test(line) && i + 1 < lines.length && LOOKS_LIKE_ENTRY.test(lines[i + 1])) {
      line = `${line} ${lines[++i]}`;
    }
    if (NUMBERED.test(line) && LOOKS_LIKE_ENTRY.test(line)) {
      if (entries.length === 0) entries.start = i;
      entries.push(...splitRunTogether(line));
    } else if (entries.length > 0) {
      const next = lines[i + 1] ?? '';
      const last = Number(entries.at(-1).match(NUMBERED)?.[1]);
      if (!(last && Number(next.match(NUMBERED)?.[1]) === last + 1 && LOOKS_LIKE_ENTRY.test(next))) break;
    }
  }
  return entries;
}

/**
 * The entries among a post's lines, where the host's note on each entry
 * follows it on a line of its own: every numbered line that looks like an
 * entry and carries the next number (or names a CD), the rest skipped.
 */
function entriesAmong(lines) {
  const entries = [];
  let last = 0;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (/^\d{1,2}\s*[.)]?$/.test(line) && i + 1 < lines.length && LOOKS_LIKE_ENTRY.test(lines[i + 1])) line = `${line} ${lines[++i]}`;
    const n = Number(line.match(NUMBERED)?.[1]);
    if (!n || !LOOKS_LIKE_ENTRY.test(line)) continue;
    if (entries.length > 0 && n !== last + 1 && !/\bcd\b/i.test(line)) continue;
    entries.push(line);
    last = n;
  }
  return entries;
}

const playlistFile = ({ url, date, title, note, entries }) =>
  `${[url && `url: ${url}`, date && `date: ${date}`, title && `title: ${title}`, note && `note: ${note}`].filter(Boolean).join('\n')}\n\n${entries.join('\n')}\n`;

// ------------------------------------------------------------------ Finam

/** The text of a Finam episode page's body, from its «archivetextcontent» block on. */
function finamBody(html) {
  const at = html.indexOf('id="archivetextcontent"');
  return at < 0 ? null : html.slice(html.indexOf('>', at) + 1);
}

/** Финам FM's episode pages: number → source. */
function readFinam() {
  const dir = join(SOURCES, 'finam.fm');
  const files = new Set(readdirSync(dir));
  const items = new Map(readJson('finam.fm', 'items.json'));
  const out = new Map();
  for (const [finamNumber, { id, date }] of readJson('finam.fm', 'found.json')) {
    const number = finamNumber + FINAM_OFFSET;
    const near = items.get(String(id))?.near;
    const candidates = [
      files.has(`near-${id}.html`) && { file: `near-${id}.html`, url: `https://web.archive.org/web/${near ?? 2014}/http://finam.fm/archive-view/${id}/` },
      files.has(`${id}.html`) && { file: `${id}.html`, url: `https://web.archive.org/web/2014/http://finam.fm/archive-view/${id}/` },
      files.has(`${id}-print.html`) && { file: `${id}-print.html`, url: `https://web.archive.org/web/2012/http://finam.fm/archive-view/${id}/print/`, print: true },
    ].filter(Boolean);
    for (const { file, url, print } of candidates) {
      const html = readFileSync(join(dir, file), 'utf8');
      const body = print ? html.slice(html.indexOf('<body')) : finamBody(html);
      if (!body) continue;
      const lines = textLines(body);
      const entries = entriesIn(lines);
      if (entries.length === 0) continue;
      const header = lines.slice(0, entries.start).find((l) => /playlist|#\d{3}|№\s?\d/i.test(l)) ?? null;
      const said = header?.match(/#\s?(\d{3})|playlist\s+(\d{3})\b/i);
      if (said && Number(said[1] ?? said[2]) !== number) throw new Error(`${file}: header says #${said[1] ?? said[2]}, found.json says #${number}`);
      const stamp = html.match(/(\d{2})\/(\d{2})\/(\d{4}) \d{2}:\d{2}/);
      const pageDate = isoDate(header) ?? isoDate(date) ?? (stamp ? iso(stamp[1], stamp[2], stamp[3]) : null);
      out.set(number, {
        kind: 'finam',
        label: print ? 'Финам FM print page' : 'Финам FM page',
        url,
        date: pageDate,
        entries,
        note: print
          ? `from the print version of Финам FM's episode page (Wayback capture; the page itself was captured broken); Finam's №${finamNumber}`
          : `from Финам FM's episode page (Wayback capture); Finam's №${finamNumber}${header ? '' : '; the page has no «PLAYLIST» header line'}`,
      });
      break;
    }
  }
  return out;
}

/** Финам FM's feed as of Nov 2010 (№1–№12): number → source. */
function readFinamRss() {
  const xml = readFileSync(join(SOURCES, 'finam.fm', 'rss-2010.xml'), 'utf8');
  const out = new Map();
  for (const [, item] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const finamNumber = Number(item.match(/<title>[^<]*?(\d+)\s*<\/title>/)?.[1]);
    const description = item.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/)?.[1] ?? '';
    const lines = textLines(description);
    const entries = entriesIn(lines);
    if (!finamNumber || entries.length === 0) continue;
    out.set(finamNumber + FINAM_OFFSET, {
      kind: 'rss',
      label: "Финам FM's 2010 RSS feed",
      url: 'https://web.archive.org/web/20101124162850/http://finam.fm/broadcast/29/rss/',
      date: isoDate(lines.find((l) => /^PLAYLIST/i.test(l))) ?? isoDate(description),
      entries,
      note: `from Финам FM's RSS feed as of Nov 2010 (Wayback capture); Finam's №${finamNumber}`,
    });
  }
  return out;
}

// ------------------------------------------------------------ fmd.soyuz.ru

const CP1251 = new TextDecoder('windows-1251');
const CP866 = new TextDecoder('ibm866');
const RUSSIAN = /ст|но|то|на|ен|ов|ни|ра|во|ко|ро|ли|ер|ал/g;

/**
 * fmd.soyuz.ru's pages are not UTF-8, and not all one encoding: those
 * captured from the site's first years are DOS cp866, the later ones cp1251.
 * Decode both ways and keep the one that reads as Russian.
 */
function decodeRussian(bytes) {
  const a = CP1251.decode(bytes);
  const b = CP866.decode(bytes);
  const score = (s) => (s.match(RUSSIAN) ?? []).length;
  return score(b) > score(a) ? { text: b, encoding: 'cp866' } : { text: a, encoding: 'cp1251' };
}

/** fmd.soyuz.ru's playlist pages: number → [source] (#350 is on two pages). */
function readSoyuz() {
  const cdx = readJson('web.archive.org', 'fmd.soyuz.ru-cdx.json');
  const out = new Map();
  for (const { id, ts, number } of readJson('fmd.soyuz.ru', 'index.json')) {
    if (number === null) continue;
    const { text: html, encoding } = decodeRussian(readFileSync(join(SOURCES, 'fmd.soyuz.ru', `${id}.html`)));
    const header = html.match(/PLAYLIST\s*#?\s*(\d+)\s+([\d.]+)/);
    if (!header || Number(header[1]) !== number) throw new Error(`fmd.soyuz.ru ${id}.html: header ${header?.[0]} is not #${number}`);
    const entries = [];
    const rows = /<td nowrap>[\s\S]*?<b>\s*(\d+)\s*<\/b>[\s\S]*?<\/td>\s*<td width=100%>([\s\S]*?)<\/td>/gi;
    for (const [, n, cell] of html.matchAll(rows)) {
      // The entry is the cell's first line; the host's note follows in <i>.
      const entry = clean(decode(cell.replace(/<!--[\s\S]*?-->/g, '').split(/<br\b[^>]*>|<i>/i)[0].replace(/<[^>]+>/g, ' ')));
      if (entry) entries.push(`${n}. ${entry}`);
    }
    const original = cdx.find(([t, url]) => t === ts && new RegExp(`id_playlist=${id}$`).test(url))?.[1].replace(/&amp;/g, '&');
    const source = {
      kind: 'soyuz',
      label: `fmd.soyuz.ru (page id ${id})`,
      id,
      url: `https://web.archive.org/web/${ts}/${original ?? `http://fmd.soyuz.ru/?s=_ARCHIVE&id_playlist=${id}`}`,
      date: isoDate(header[2]),
      entries,
      encoding,
      note: 'from fmd.soyuz.ru, the program\'s site (Wayback capture)',
    };
    out.set(number, [...(out.get(number) ?? []), source]);
  }
  return out;
}

// ------------------------------------------------------------- radar.lv posts

/** Lines of a post's P.S. that say what actually aired, kept for the note. */
const AIRED = /вместо|выкинул|отсутству|без начала/i;

/** A note in «[…]» can run over a line break («… (Disko B) [» then «…]»): join its lines. */
function joinBrackets(lines) {
  const out = [];
  for (const line of lines) {
    const prev = out.at(-1);
    if (prev !== undefined && (prev.match(/\[/g) ?? []).length > (prev.match(/\]/g) ?? []).length) out[out.length - 1] = `${prev}${line}`;
    else out.push(line);
  }
  return out;
}

/** radar.lv's episode posts: number → [source]. */
function readRadar() {
  const out = new Map();
  for (const [path, rawTitle] of readJson('radar.lv', 'posts.json')) {
    const title = decode(rawTitle);
    const m = title.match(/^(FM|ФМ) Достоевский\s+(\d+)\s+от\s+(.+)$/);
    if (!m) continue;
    const [, style, n, when] = m;
    const node = path.split('/').pop();
    let html;
    try {
      html = readFileSync(join(SOURCES, 'radar.lv', `node-${node}.html`), 'utf8');
    } catch {
      continue;
    }
    const start = html.indexOf('<div class="content">', html.indexOf('<div class="node">'));
    const end = html.indexOf('<div class="links">', start);
    const lines = joinBrackets(textLines(html.slice(start, end > 0 ? end : undefined)))
      .filter((l) => !/^\[.*\]$/.test(l)) // the host's notes, «[…]»
      .filter((l) => !/^Файл\s*Размер|^FM_Dostoevsky_N\d/.test(l)); // the attachment table
    // A note can follow its entry on the same line (#129): «… (Intuition) [Если бы …]».
    const entries = entriesAmong(lines).map((e) => e.replace(/\s*\[[^\]]*\]$/, ''));
    if (entries.length === 0) continue;
    const ps = lines.filter((l, i) => AIRED.test(l) && (l.startsWith('P.S.') || lines[i - 1] === 'P.S.')).map((l) => l.replace(/^P\.S\.\s*/, ''));
    const words = when.match(/(\d{1,2})\s+(\S+)\s+(\d{4})/);
    const date = isoDate(when) ?? (words && MONTHS.includes(words[2]) ? iso(words[1], MONTHS.indexOf(words[2]) + 1, words[3]) : null);
    const moved = MOVED[`radar.lv/node/${node}`];
    const source = {
      kind: style === 'ФМ' ? 'radar-lower' : 'radar',
      moved: moved && { from: Number(n), why: moved.why },
      label: `radar.lv post ${node}`,
      node,
      url: `https://radar.lv/node/${node}`,
      date,
      entries,
      ps,
      note:
        style === 'ФМ'
          ? "from radar.lv's archive of the program, a fans' copy of the program's own list"
          : "from radar.lv's archive of the program, a fans' site: its posts «FM Достоевский N от …» come from the same playlist database as the XLS",
    };
    const number = moved?.number ?? Number(n);
    out.set(number, [...(out.get(number) ?? []), source]);
  }
  return out;
}

// --------------------------------------------------------------- CUE sheets

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** A CUE sheet's text: UTF-8 if the whole file is, else cp1251. */
function decodeCue(bytes) {
  try {
    return UTF8.decode(bytes).replace(/^\ufeff/, '');
  } catch {
    return CP1251.decode(bytes);
  }
}

const TALK = /^\(?Track \d+\)?$/i;

/** The songs of a CUE sheet: every track with a performer that is not the host talking. */
function cueSongs(text) {
  const [, ...blocks] = text.split(/^\s*TRACK \d+ AUDIO\s*$/m);
  const field = (block, key) => block.match(new RegExp(`^\\s*${key}\\s+"(.*)"\\s*$`, 'm'))?.[1] ?? null;
  return blocks
    .map((block) => ({
      title: field(block, 'TITLE'),
      performer: field(block, 'PERFORMER'),
      album: block.match(/^\s*REM FMDALBUM\s+(.*?)\s*$/m)?.[1] ?? null,
    }))
    .filter(({ title, performer }) => performer && !TALK.test(title ?? ''));
}

/** One song as a playlist line. The early sheets put album and label in the performer: «Artist [Album, Label]». */
function cueEntry({ title, performer, album }, i) {
  let artist = clean(performer);
  let label = null;
  const bracket = artist.match(/^(.*?)\s*\[(.*)\]$/);
  if (!album && bracket) {
    artist = bracket[1];
    const comma = bracket[2].lastIndexOf(', ');
    [album, label] = comma < 0 ? [bracket[2], null] : [bracket[2].slice(0, comma), bracket[2].slice(comma + 2)];
  }
  return `${i + 1}. ${artist} "${clean(title ?? '')}"${album ? ` CD "${clean(album)}"` : ''}${label ? ` (${clean(label)})` : ''}`;
}

/** radar.lv's CUE sheets: number → [source], one per sheet with any song. */
function readCue() {
  const dir = join(SOURCES, 'radar.lv', 'cue');
  const urls = readFileSync(join(dir, 'urls.txt'), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  const out = new Map();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.cue')).sort()) {
    if (IGNORED[file]) continue;
    const named = Number(file.match(/_N(\d+)_/)[1]);
    const moved = MOVED[file];
    const number = moved?.number ?? named;
    const songs = cueSongs(decodeCue(readFileSync(join(dir, file))));
    const source = {
      kind: 'cue',
      label: `radar.lv CUE sheet ${file}`,
      moved: moved && { from: named, why: moved.why },
      file,
      url: urls.find((u) => u.endsWith(`/${file}`)) ?? `https://radar.lv/files/${file}`,
      date: isoDate(file.replace(/^FM_Dostoevsky_N\d+_/, '')),
      entries: songs.map(cueEntry),
      songs,
      note: "from radar.lv's CUE sheet for its recording of the episode (song tracks only; the host's talk between them left out)",
    };
    out.set(number, [...(out.get(number) ?? []), source]);
  }
  return out;
}

// --------------------------------------------------------------- mp3 tags

/**
 * The playlists in a fans' collection of the program's mp3s (#129–#707, 494 episodes), each in its file's ID3
 * comment, saved as programs/fmd/sources/mp3-tags/tags.json (number → its file's name, title, track and comment;
 * two labels given as e-mail addresses left out). A line reads «1 \tArtist (Country) "Song" CD "Album" (Label)»,
 * the early years' with the host's note after a comma, «…(Label), (Note)», which is left out as elsewhere.
 * The file's name gives a date ("623. #623 01.03.2009.mp3"), used only where no other source dates the episode:
 * a few names slip («#417 19.03.2006» for 2005, «#596 24.08.2008»); its leading number is the episode's (the
 * title's «#…» slips too: «209. #206 07.03.2001» is #209).
 */
function readTags() {
  const tags = JSON.parse(readFileSync(join(SOURCES, 'mp3-tags', 'tags.json'), 'utf8'));
  const out = new Map();
  for (const [number, { file, comment }] of Object.entries(tags)) {
    const entries = comment
      .split(/\r?\n/)
      .map((line) => line.match(/^\s*(\d{1,2})[.)]?\s+(\S.*)$/))
      .filter(Boolean)
      .map(([, n, rest]) => `${Number(n)}. ${clean(rest).replace(/\)\s*,\s*\((?:[^()]|\([^()]*\))*\)\s*$/, ')')}`);
    if (!entries.length) continue;
    out.set(Number(number), {
      kind: 'tags',
      label: `the mp3 tags of ${file}`,
      file,
      url: null,
      date: isoDate(file.replace(/^\d+\.\s*#\d+\s*/, '').replace(/\.mp3$/i, '')),
      entries,
      note: `from the ID3 comment of a fans' collection's mp3 of the episode («${file}»; programs/fmd/sources/mp3-tags/tags.json)`,
    });
  }
  return out;
}

// ------------------------------------------------------------ the owner's

/**
 * Playlists the owner wrote down by ear for episodes no other source has, as they wrote them:
 * programs/fmd/sources/owner/<number>.txt. An entry is a numbered line, «1 Artist "Song" — "Album" (Country)
 * 2009», in no fixed layout; the line after it (the record's Discogs or Apple Music page, or "not on discogs")
 * is the owner's pointer, left out of the playlist.
 */
function readOwner() {
  const out = new Map();
  const dir = join(SOURCES, 'owner');
  for (const file of readdirSync(dir).filter((f) => /^\d+\.txt$/.test(f))) {
    const entries = readFileSync(join(dir, file), 'utf8')
      .split(/\r?\n/)
      .map((line) => line.match(/^\s*(\d{1,2})[.)]?\s+(\S.*)$/))
      .filter(Boolean)
      .map(([, n, rest]) => `${Number(n)}. ${clean(rest)}`);
    out.set(Number(file.replace('.txt', '')), {
      kind: 'owner',
      label: `the owner's list (${file})`,
      file,
      url: null,
      date: null,
      entries,
      note: `from the owner's own list, written down by ear (programs/fmd/sources/owner/${file})`,
    });
  }
  return out;
}

// --------------------------------------------------------------------- XLS

/** RFC 4180 CSV. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') field += text[i++];
      else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ',') row.push(field), (field = '');
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field), rows.push(row), (row = []), (field = '');
    } else field += c;
  }
  if (field || row.length > 0) row.push(field), rows.push(row);
  return rows;
}

/** The XLS (read from its UTF-8 CSV copy): number → source. */
function readXls() {
  const [head, ...rows] = parseCsv(readFileSync(join(SOURCES, 'radar.lv', 'fmd_up499.csv'), 'utf8').replace(/^\ufeff/, ''));
  const records = rows.filter((r) => r.length > 1).map((r) => Object.fromEntries(head.map((h, i) => [h, clean(r[i] ?? '')])));
  const byNumber = new Map();
  for (const r of records) byNumber.set(Number(r.bNum), [...(byNumber.get(Number(r.bNum)) ?? []), r]);
  const out = new Map();
  for (const [number, list] of byNumber) {
    // In track-number order; a row with no number goes after the row entered just before it.
    const numbered = list.filter((r) => r.sNum !== '').sort((a, b) => Number(a.sNum) - Number(b.sNum) || Number(a.ID) - Number(b.ID));
    for (const r of list.filter((r) => r.sNum === '')) {
      const before = numbered.filter((x) => Number(x.ID) < Number(r.ID)).sort((a, b) => Number(b.ID) - Number(a.ID))[0];
      numbered.splice(before ? numbered.indexOf(before) + 1 : 0, 0, r);
    }
    list.splice(0, list.length, ...numbered);
    const entries = list.map(
      (r) => `${r.sNum === '' ? '' : `${r.sNum}. `}${r.Artist}${r.Country ? ` (${r.Country})` : ''} "${r.Song}"${r.CD ? ` CD "${r.CD}"` : ''}${r.Label ? ` (${r.Label})` : ''}`,
    );
    const dates = [...new Set(list.map((r) => r.Date).filter(Boolean))].sort();
    const numbers = list.filter((r) => r.sNum !== '').map((r) => Number(r.sNum));
    const quirks = [];
    const blank = list.filter((r) => r.sNum === '').map((r) => r.Artist);
    if (blank.length) quirks.push(`its row${blank.length > 1 ? 's' : ''} for ${blank.map((a) => `«${a}»`).join(', ')} ${blank.length > 1 ? 'have' : 'has'} no track number: placed after the row entered before ${blank.length > 1 ? 'each' : 'it'}`);
    const repeated = [...new Set(numbers.filter((n, i) => numbers.indexOf(n) !== i))];
    if (repeated.length) quirks.push(`its track number${repeated.length > 1 ? 's' : ''} ${repeated.join(', ')} appear${repeated.length > 1 ? '' : 's'} twice`);
    const skipped = [];
    for (let n = Math.min(...numbers) + 1; n < Math.max(...numbers); n++) if (!numbers.includes(n)) skipped.push(n);
    if (skipped.length) quirks.push(`its track numbers skip ${skipped.join(', ')}`);
    if (dates.length > 1) quirks.push(`its rows give two dates, ${dates.join(' and ')}`);
    out.set(number, {
      kind: 'xls',
      label: 'the XLS',
      url: null,
      date: dates[0] ?? null,
      entries,
      rows: list,
      quirks,
      note: `from the XLS export of radar.lv's dead playlist database (programs/fmd/sources/radar.lv/fmd_up499.xls), the least trusted source${
        number <= 100 ? ': in its early years Russian names and titles are mostly transliterated or translated into English' : ''
      }`,
    });
  }
  return out;
}

// ---------------------------------------------------- Tilgor Kraut's sheet

/**
 * Tilgor Kraut's spreadsheet of the program's playlists, «FMD (for all).xlsx» (2026-10-19), read from its
 * UTF-8 CSV copy: radar.lv's playlist database again, as the XLS has it, carried on to the end (#820, then
 * Stereo Voodoo as #821–#951, its own number in the Date column; not read here). Columns `bN7m, Date, sNum,
 * ARTIST, Country, Song, CD, Label, Comment AKT` and two counts of plays (not wanted, nor the host's note).
 * Lower case throughout, labels merged («warner» for «Warner Bros.»), typos fixed and a few made: not a
 * second witness to the XLS or the later sources. Ranked last, below the owner's list: it gives the episodes
 * nothing else has, its date only where no other source dates the episode.
 */
function readKraut() {
  const [, ...rows] = parseCsv(readFileSync(join(SOURCES, 'tilgor-kraut', 'fmd-for-all.csv'), 'utf8'));
  const byNumber = new Map();
  for (const r of rows.filter((r) => r.length > 1).map((r) => r.map(clean))) {
    const number = Number(r[0]);
    if (number >= FIRST && number <= LAST) byNumber.set(number, [...(byNumber.get(number) ?? []), r]);
  }
  const out = new Map();
  for (const [number, list] of byNumber) {
    const entries = list.map(
      ([, , n, artist, country, song, cd, label]) => `${n === '' ? '' : `${n}. `}${artist}${country ? ` (${country})` : ''} "${song}"${cd ? ` CD "${cd}"` : ''}${label ? ` (${label})` : ''}`,
    );
    const dates = [...new Set(list.map((r) => r[1]).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort();
    out.set(number, {
      kind: 'kraut',
      label: "Tilgor Kraut's spreadsheet",
      url: null,
      date: dates[0] ?? null,
      entries,
      note: `from Tilgor Kraut's spreadsheet of the program's playlists (programs/fmd/sources/tilgor-kraut/FMD (for all).xlsx): radar.lv's playlist database, as the XLS has it, carried on to the program's end, in lower case throughout${
        number >= 797 && number <= 817 ? "; its date is the spreadsheet's, a Sunday: Финам FM's own pages date the episodes either side (#797–#817) on the Friday two days before the Sunday the spreadsheet gives them" : ''
      }`,
    });
  }
  return out;
}

// ------------------------------------------------------------ cross-check

const CYRILLIC = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', і: 'i', ї: 'i', є: 'e', ў: 'u' };

/** A name or title reduced for comparison: case, accents, punctuation, a leading "the", Cyrillic spelled in Latin. */
const norm = (s) =>
  (s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[а-яёіїєў]/g, (c) => CYRILLIC[c] ?? c)
    .replace(/&/g, 'and')
    .replace(/^the\s+/, '')
    .replace(/\b(kh|x)/g, 'h')
    .replace(/[^a-z0-9]/g, '');

function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const keep = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = keep;
    }
  }
  return row[b.length];
}

/** Same name, allowing for spelling and transliteration and one listing more of a collaboration than the other. */
function similar(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return x === y;
  if (x === y) return true;
  if (Math.min(x.length, y.length) >= 4 && (x.startsWith(y) || y.startsWith(x) || x.includes(y) || y.includes(x))) return true;
  return distance(x, y) <= Math.max(2, Math.floor(0.3 * Math.max(x.length, y.length)));
}

/** An entry split into artist and title, whatever the source's layout. */
function partsOf(entry) {
  const text = entry.replace(NUMBERED, '').replace(/[`’]/g, "'").trim();
  // Titles are in double quotes; #802's print page alone uses single ones.
  const marks = /["«]/.test(text) ? /["«»]/ : /'/;
  const quote = text.search(marks);
  const head = quote < 0 ? text : text.slice(0, quote);
  const artist = head.replace(/\s*\([^()]*\)\s*$/, '').replace(/\s*\(.*$/, '').trim();
  const title = quote < 0 ? '' : text.slice(quote + 1).split(marks)[0];
  return { artist: artist || head.trim(), title };
}

/** Longest run of entries matched in order by artist: pairs of indices. */
function align(a, b) {
  const n = a.length;
  const m = b.length;
  const same = a.map((x) => b.map((y) => similar(x.artist, y.artist)));
  const L = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = same[i][j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const pairs = [];
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (same[i][j] && L[i][j] === L[i + 1][j + 1] + 1) pairs.push([i, j]), i++, j++;
    else if (L[i + 1][j] >= L[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

const hasCyrillic = (s) => /[а-яё]/i.test(s);

/** Two sources' lists of one episode compared: how many entries, which artists, and (for the XLS) which titles. */
function compare(a, b) {
  const pa = a.entries.map(partsOf);
  const pb = b.entries.map(partsOf);
  const pairs = align(pa, pb);
  const onlyA = pa.filter((_, i) => !pairs.some(([x]) => x === i)).map((p) => p.artist);
  const onlyB = pb.filter((_, j) => !pairs.some(([, y]) => y === j)).map((p) => p.artist);
  // Artists both have, but in another order.
  const reordered = onlyA.filter((x) => onlyB.some((y) => similar(x, y)));
  const titles = { same: 0, cyrillic: 0, other: 0, otherExamples: [] };
  const untitled = []; // entries of a with no title that b has
  for (const [i, j] of pairs) {
    const ta = pa[i].title;
    const tb = pb[j].title;
    if (!ta.trim() && tb.trim()) untitled.push({ entry: i + 1, title: tb });
    if (ta && tb && hasCyrillic(ta) !== hasCyrillic(tb)) titles.cyrillic++;
    else if (!ta || !tb || similar(ta, tb)) titles.same++;
    else titles.other++, titles.otherExamples.push(`«${ta}» / «${tb}»`);
  }
  const agree = pa.length === pb.length && onlyA.length === 0;
  let kind = 'agree';
  if (!agree) {
    if (pa.length !== pb.length) kind = 'count';
    else if (reordered.length === onlyA.length && onlyA.length === onlyB.length) kind = 'order';
    else kind = 'artists';
  }
  return { kind, countA: pa.length, countB: pb.length, onlyA, onlyB, reordered, titles, untitled, matched: pairs.length };
}

/** Is a difference material: a song one source has and the other has not? */
const material = (c) => c.kind === 'count' || c.kind === 'artists';

const list = (names, max = 3) => names.slice(0, max).map((n) => `«${n}»`).join(', ') + (names.length > max ? ` and ${names.length - max} more` : '');

function describe(c, a, b) {
  const parts = [];
  if (c.countA !== c.countB) parts.push(`${c.countA} entries in ${a} vs ${c.countB} in ${b}`);
  else parts.push(`${c.countA} entries in both`);
  const onlyA = c.onlyA.filter((x) => !c.reordered.includes(x));
  const onlyB = c.onlyB.filter((y) => !c.reordered.some((x) => similar(x, y)));
  if (onlyA.length) parts.push(`only in ${a}: ${list(onlyA)}`);
  if (onlyB.length) parts.push(`only in ${b}: ${list(onlyB)}`);
  if (c.reordered.length) parts.push(`order differs (${list(c.reordered, 2)})`);
  return parts.join('; ');
}

// --------------------------------------------------------------- choosing

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

const RANK = { finam: 0, rss: 1, soyuz: 2, 'radar-lower': 3, radar: 4, tags: 5, cue: 6, xls: 7, owner: 8, kraut: 9 };
const SHORT = { finam: 'the Finam page', rss: 'the Finam RSS', soyuz: 'fmd.soyuz.ru', 'radar-lower': "radar.lv's «ФМ» post", radar: "radar.lv's «FM» post", tags: "the mp3's tags", cue: 'the CUE sheet', xls: 'the XLS', owner: "the owner's list", kraut: "Tilgor Kraut's spreadsheet" };
/** Copies of radar.lv's playlist database, which can list a row twice: never counted as the longer list. */
const DATABASE = new Set(['xls', 'kraut']);

/**
 * The best source of an episode: the highest ranked, unless its list is
 * shorter than another source's by two or more, when the next complete one
 * is taken (a CUE sheet or a page can be cut short; the XLS and Tilgor Kraut's
 * spreadsheet can list a row twice, so they never count as the longer list).
 */
function choose(sources) {
  const ranked = [...sources].sort((a, b) => RANK[a.kind] - RANK[b.kind]);
  const longest = Math.max(...ranked.filter((s) => !DATABASE.has(s.kind)).map((s) => s.entries.length), 0);
  return ranked.find((s) => DATABASE.has(s.kind) || s.entries.length >= longest - 1) ?? ranked[0];
}

/** Among several sources of one kind for one episode (#350's two pages, sheets of one recording), the fullest. */
const fullest = (list) => [...list].sort((a, b) => b.entries.length - a.entries.length || a.label.localeCompare(b.label))[0];

// --------------------------------------------------------------------- main

function main() {
  const finam = readFinam();
  const rss = readFinamRss();
  const soyuz = readSoyuz();
  const radar = readRadar();
  const cue = readCue();
  const tags = readTags();
  const xls = readXls();
  const owner = readOwner();
  const kraut = readKraut();

  const episodes = new Map();
  const extra = []; // findings on alternative copies of one source
  for (let number = FIRST; number <= LAST; number++) {
    const sources = [];
    if (finam.has(number)) sources.push(finam.get(number));
    if (rss.has(number)) sources.push(rss.get(number));
    if (soyuz.has(number)) {
      const pages = soyuz.get(number);
      const page = fullest(pages);
      if (pages.length > 1) {
        const other = pages.find((p) => p !== page);
        const c = compare(page, other);
        extra.push(`#${number}: on two fmd.soyuz.ru pages, ids ${page.id} and ${other.id}; ${c.kind === 'agree' ? 'their lists agree' : describe(c, `id ${page.id}`, `id ${other.id}`)}; id ${page.id} used`);
      }
      sources.push(page);
    }
    if (radar.has(number)) {
      const posts = radar.get(number);
      for (const kind of ['radar-lower', 'radar']) {
        const own = posts.filter((p) => p.kind === kind);
        if (own.length) sources.push(fullest(own));
      }
    }
    if (cue.has(number)) {
      const all = cue.get(number);
      if (all.length > 1) {
        const named = all.filter((s) => s.entries.length > 0);
        const empty = all.filter((s) => s.entries.length === 0).map((s) => s.file);
        const same = named.length > 1 && named.every((s) => s.entries.join('\n') === named[0].entries.join('\n'));
        extra.push(
          `#${number}: ${all.length} CUE sheets; ${named.length === 0 ? 'all hold timings only, no names' : `${named.length > 1 ? (same ? `${named.length} list the same songs` : `${named.length} differ`) : `${named[0].file} names the songs`}`}${empty.length && named.length ? `; ${empty.join(', ')} ${empty.length > 1 ? 'hold' : 'holds'} timings only` : ''}`,
        );
      }
      const sheets = all.filter((s) => s.entries.length > 0);
      if (sheets.length) sources.push(fullest(sheets));
    }
    if (tags.has(number)) {
      // Its date only where no other source has one: the file names slip now and then.
      const t = tags.get(number);
      if (sources.some((s) => s.date) || (xls.get(number)?.date ?? null)) t.date = null;
      sources.push(t);
    }
    if (xls.has(number)) sources.push(xls.get(number));
    if (owner.has(number)) sources.push(owner.get(number));
    // Its date only where no other source has one: the XLS's database again, not a second witness.
    if (kraut.has(number)) sources.push(sources.some((s) => s.date) ? { ...kraut.get(number), date: null } : kraut.get(number));
    if (sources.length) episodes.set(number, { number, sources, best: choose(sources) });
  }

  // Cross-check: the chosen list against every other source, and every pair the summary reports on.
  const PAIRS = [
    ['finam', 'rss'],
    ['finam', 'cue'],
    ['soyuz', 'radar-lower'],
    ['soyuz', 'radar'],
    ['soyuz', 'cue'],
    ['soyuz', 'xls'],
    ['radar-lower', 'radar'],
    ['radar', 'cue'],
    ['radar-lower', 'cue'],
    ['soyuz', 'tags'],
    ['radar', 'tags'],
    ['radar-lower', 'tags'],
    ['tags', 'cue'],
    ['tags', 'xls'],
    ['radar', 'xls'],
    ['radar-lower', 'xls'],
    ['cue', 'xls'],
    ['finam', 'kraut'],
    ['soyuz', 'kraut'],
    ['tags', 'kraut'],
    ['xls', 'kraut'],
  ];
  const stats = new Map(PAIRS.map(([a, b]) => [`${a}|${b}`, { a, b, episodes: [], agree: 0, count: 0, order: 0, artists: 0, titles: { same: 0, cyrillic: 0, other: 0 }, examples: [] }]));
  const differences = new Map(); // number → [line]
  for (const { number, sources, best } of episodes.values()) {
    const of = Object.fromEntries(sources.map((s) => [s.kind, s]));
    for (const [a, b] of PAIRS) {
      if (!of[a] || !of[b]) continue;
      const c = compare(of[a], of[b]);
      const s = stats.get(`${a}|${b}`);
      s.episodes.push(number);
      s[c.kind]++;
      for (const k of ['same', 'cyrillic', 'other']) s.titles[k] += c.titles[k];
      if (c.titles.otherExamples.length && s.examples.length < 8) s.examples.push(`#${number} ${c.titles.otherExamples[0]}`);
    }
    for (const other of sources) {
      if (other === best) continue;
      const c = compare(best, other);
      if (!material(c)) continue;
      const line = describe(c, SHORT[best.kind], SHORT[other.kind]);
      differences.set(number, [...(differences.get(number) ?? []), { other, c, line }]);
    }
  }

  // Write the playlists.
  rmSync(PLAYLISTS, { recursive: true, force: true });
  mkdirSync(PLAYLISTS, { recursive: true });
  const counts = {};
  const incomplete = [];
  const dateNotes = [];
  const krautDates = []; // where Tilgor Kraut's spreadsheet gives another date than the one used
  const lastSongs = cueLastSongs(episodes);
  const primary = new Map([...episodes.values()].map(({ number, sources, best }) => [number, best.date ?? sources.find((s) => s.date)?.date ?? null]));
  const near = (number, step) => {
    for (let n = number + step; n >= FIRST && n <= LAST; n += step) if (primary.get(n)) return primary.get(n);
    return null;
  };
  for (const { number, sources, best } of episodes.values()) {
    const notes = [best.note];
    if (best.kind === 'soyuz' && soyuz.get(number).length > 1) {
      const other = soyuz.get(number).find((p) => p !== best);
      notes.push(`the episode is on two fmd.soyuz.ru pages: this one (id ${best.id}) is the fuller, the other (id ${other.id}) has ${other.entries.length} ${other.entries.length === 1 ? 'entry' : 'entries'}`);
    }
    if (best.kind === 'cue' && cue.get(number).length > 1) notes.push(`one of ${cue.get(number).length} sheets for this episode, the fullest (${best.file})`);
    if (best.kind === 'cue' && sources.length === 1) notes.push(cueOnly(lastSongs));
    if (best.kind === 'xls' && best.quirks.length) notes.push(best.quirks.join('; '));
    if (best.ps?.length) notes.push(`the post adds: «${best.ps.join(' ')}»`);
    for (const s of sources) if (s.moved) notes.push(s === best ? s.moved.why : `${SHORT[s.kind]}: ${s.moved.why}`);
    if (EPISODE_NOTES[number]) notes.push(EPISODE_NOTES[number]);
    const feed = sources.find((s) => s.kind === 'rss');
    if (best.kind === 'finam' && feed && compare(best, feed).kind === 'agree') notes.push("Финам FM's RSS feed as of Nov 2010 has the same list");
    const skipped = sources.filter((s) => RANK[s.kind] < RANK[best.kind]);
    for (const s of skipped) notes.push(`${SHORT[s.kind]} has only ${s.entries.length} entries (cut short), so this fuller list is used`);
    // The owner's lines have no fixed layout: a title not in quotes is not missing.
    for (const other of sources.filter((s) => s !== best && best.kind !== 'owner')) {
      for (const { entry, title } of compare(best, other).untitled) notes.push(`entry ${entry} has no title; ${SHORT[other.kind]} has «${title}»`);
    }
    const diffs = (differences.get(number) ?? []).filter(({ other }) => !skipped.includes(other));
    if (diffs.length) notes.push(`another source differs: ${diffs.map(({ other, c, line }) => noteLine(best, other, c, line)).join('; ')}`);
    const reason = incompleteReason(number, best, sources);
    if (reason) notes.push(reason), incomplete.push({ number, reason });
    // A self-released CD's label can be the artist's e-mail address: a personal contact, never written out.
    const entries = best.entries.map((e) => e.replace(EMAIL, 'e-mail address left out'));
    if (entries.some((e, i) => e !== best.entries[i])) notes.push("a label given as the artist's e-mail address is left out");
    const { date, note: dateNote } = DATES[number] ? { date: DATES[number].date, note: `date: ${DATES[number].why}` } : dateOf(best, sources, near(number, -1), near(number, 1));
    if (dateNote) notes.push(dateNote), dateNotes.push(`#${number}: ${dateNote}`);
    const sheetDate = kraut.get(number)?.date;
    if (sheetDate && sheetDate !== date) krautDates.push(`#${number} (${sheetDate}; ${date} used)`);
    writeFileSync(
      join(PLAYLISTS, `${number}.txt`),
      // A source with no page of its own (the mp3 tags) links to another source's: the episode keeps its link.
      playlistFile({ url: best.url ?? sources.find((x) => x.url)?.url ?? null, date, title: `FM Достоевский #${number}`, note: `${notes.map((n) => (/^[a-z]+\.[a-z]/.test(n) ? n : n[0].toUpperCase() + n.slice(1))).join('. ')}.`.replace(/\.\./g, '.'), entries }),
    );
    counts[best.kind] = (counts[best.kind] ?? 0) + 1;
  }

  const missing = [];
  for (let number = FIRST; number <= LAST; number++) if (!episodes.has(number)) missing.push(number);

  writeFileSync(join(ROOT, 'CROSSCHECK.md'), crosscheck({ episodes, stats, differences, extra, dateNotes, krautDates, xls, lastSongs }));
  writeFileSync(join(ROOT, 'MISSING.md'), missingReport({ missing, incomplete }));

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`${total} playlists written: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}`);
  console.log(`${missing.length} missing, ${incomplete.length} incomplete; ${differences.size} episodes where another source differs`);
}

/** How often a CUE sheet of the later years lacks the playlist's last song, where a playlist can tell. */
function cueLastSongs(episodes) {
  let compared = 0;
  let lacking = 0;
  for (const { number, sources } of episodes.values()) {
    const list = sources.find((s) => s.kind === 'finam' || s.kind === 'soyuz');
    const sheet = sources.find((s) => s.kind === 'cue');
    if (number < 484 || !list || !sheet || sheet.entries.length < 10) continue;
    compared++;
    const c = compare(list, sheet);
    const last = partsOf(list.entries.at(-1)).artist;
    if (c.countB < c.countA && c.onlyA.includes(last)) lacking++;
  }
  return { compared, lacking };
}

const cueOnly = ({ compared, lacking }) =>
  `a CUE sheet lists what radar.lv's recording holds: of the ${compared} sheets from #484 on that a playlist can be compared with, ${lacking} lack the playlist's last song (not aired, or the recording ends early), so this list may lack one at the end`;

/** Notes on single episodes, from reading the sources side by side. */
const EPISODE_NOTES = {
  701: 'complete with 5 songs: the rest of the hour is talk, the last episode on Эхо Москвы before Финам FM (the owner listened, 2026-10-18)',
  148: "radar.lv's post and CUE sheet titled #148 hold #147's list (see programs/fmd/CROSSCHECK.md); this is the XLS's #148, found nowhere else",
  674: "radar.lv's second sheet for #675 (FM_Dostoevsky_N675_2010.02.28_0.cue) names these same 16 songs and a 17th after them, «zakopower \"kiebys ty\"»: perhaps this episode's last song, which this sheet lacks",
};

/** A difference in a note: a CUE sheet that lacks songs is the recording, not the plan. */
function noteLine(best, other, c, line) {
  const name = SHORT[other.kind];
  if (other.kind === 'cue' && c.countB < c.countA && c.onlyB.length === 0 && c.onlyA.length > 2) {
    return `${name} of radar.lv's recording stops after ${c.countB} songs`;
  }
  if (other.kind === 'cue' && c.countB < c.countA && c.onlyB.length === 0) {
    return `${name} of radar.lv's recording lacks ${list(c.onlyA)} (not aired, or the recording is cut short)`;
  }
  return `${name}: ${line}`;
}

/**
 * The air date: the chosen source's, unless two or more other sources agree
 * on another date and none on its, or its date falls outside the episodes
 * either side of it and another source's does not: then that one is taken.
 * Either way the note says what the others give.
 */
function dateOf(best, sources, before, after) {
  const dated = sources.filter((s) => s.date);
  const mine = best.date ?? dated[0]?.date ?? null;
  const others = dated.filter((s) => s !== best && s.date !== mine);
  if (!mine || others.length === 0) return { date: mine, note: null };
  const votes = new Map();
  for (const s of others) votes.set(s.date, [...(votes.get(s.date) ?? []), SHORT[s.kind]]);
  const agreeing = dated.filter((s) => s !== best && s.date === mine).length;
  const [top, names] = [...votes].sort((a, b) => b[1].length - a[1].length)[0];
  const said = [...votes].map(([d, n]) => `${n.join(' and ')} ${n.length > 1 ? 'say' : 'says'} ${d}`).join(', ');
  if (names.length >= 2 && agreeing === 0) return { date: top, note: `date: ${SHORT[best.kind]} says ${mine}, but ${said}, which is used` };
  const fits = (d) => (!before || d > before) && (!after || d < after);
  const fitting = [...votes.keys()].find(fits);
  if (!fits(mine) && fitting) {
    return { date: fitting, note: `date: ${SHORT[best.kind]} says ${mine}, out of order with the episodes either side, but ${said}; ${fitting} is used` };
  }
  return { date: mine, note: `date: ${said}` };
}

/** Why an episode's chosen list is short, if it is. */
function incompleteReason(number, best, sources) {
  if (number === 701) return null; // complete with 5 songs: see EPISODE_NOTES
  const others = sources.filter((s) => s !== best && !DATABASE.has(s.kind));
  const longest = Math.max(0, ...others.map((s) => s.entries.length));
  if (longest >= best.entries.length + 2) return `incomplete: ${best.entries.length} entries where another source lists ${longest}`;
  if (best.entries.length < 10) return `incomplete: only ${best.entries.length} entries, where an episode usually has 13–17`;
  return null;
}

// ----------------------------------------------------------------- reports

const range = (numbers) => {
  const out = [];
  for (let i = 0; i < numbers.length; ) {
    let j = i;
    while (j + 1 < numbers.length && numbers[j + 1] === numbers[j] + 1) j++;
    out.push(i === j ? `#${numbers[i]}` : `#${numbers[i]}–#${numbers[j]}`);
    i = j + 1;
  }
  return out.join(', ');
};

const NAMES = {
  finam: 'Finam page',
  rss: 'Finam 2010 RSS',
  soyuz: 'fmd.soyuz.ru',
  'radar-lower': 'radar.lv post («ФМ Достоевский …», lower case)',
  radar: 'radar.lv post («FM Достоевский …», Title Case)',
  cue: 'CUE sheet',
  tags: "mp3 tags (a fans' collection)",
  xls: 'XLS',
  owner: "the owner's list, by ear",
  kraut: "Tilgor Kraut's spreadsheet",
};

function crosscheck({ episodes, stats, differences, extra, dateNotes, krautDates, xls, lastSongs }) {
  const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : '–');
  const out = [];
  out.push('# «FM Достоевский»: how the sources agree');
  out.push('');
  out.push('Written by `node bin/fmd-playlists.js` (do not edit by hand). For every episode two or more');
  out.push('sources have, their lists are compared entry by entry: the same number of entries, and the');
  out.push('same artists in the same order (ignoring case, accents and punctuation, a leading «the», and');
  out.push('allowing for transliteration and small spelling differences). Titles are compared the same way');
  out.push('wherever the artists match. The source each playlist file uses is the highest ranked (see');
  out.push('programs/fmd/NOTES.md); where another source lists other songs, its `note:` says so.');
  out.push('');
  out.push('## Summary');
  out.push('');
  out.push('| Sources compared | Episodes | Agree | Count differs | Artists differ | Order only | Titles: same | Titles: Russian vs Latin | Titles: other |');
  out.push('|---|---|---|---|---|---|---|---|---|');
  for (const s of stats.values()) {
    const n = s.episodes.length;
    if (!n) continue;
    const t = s.titles.same + s.titles.cyrillic + s.titles.other;
    out.push(
      `| ${NAMES[s.a]} vs ${NAMES[s.b]} (${range(s.episodes).split(', ').length > 3 ? `#${s.episodes[0]}–#${s.episodes.at(-1)}` : range(s.episodes)}) | ${n} | ${s.agree} (${pct(s.agree, n)}) | ${s.count} | ${s.artists} | ${s.order} | ${pct(s.titles.same, t)} | ${pct(s.titles.cyrillic, t)} | ${pct(s.titles.other, t)} |`,
    );
  }
  out.push('');
  out.push('«Titles: Russian vs Latin» counts matched entries whose title is in Cyrillic in one source and in');
  out.push('Latin letters in the other: a transliteration or an English translation. «Titles: other» are');
  out.push('titles that differ some other way (a typo, another song by the same artist). Some examples:');
  out.push('');
  for (const s of stats.values()) if (s.examples.length) out.push(`- ${NAMES[s.a]} vs ${NAMES[s.b]}: ${s.examples.slice(0, 4).join('; ')}`);
  out.push('');
  out.push(findings(stats, xls, lastSongs, episodes));
  out.push('');
  for (const [file, why] of Object.entries(IGNORED)) extra.push(`${file} is left out: ${why}`);
  if (extra.length) {
    out.push('## Copies of one source');
    out.push('');
    for (const line of extra) out.push(`- ${line}`);
    out.push('');
  }
  out.push('## Dates the sources disagree on');
  out.push('');
  out.push('The date used is the chosen source\'s, unless two or more others agree on another and none on');
  out.push('its, or its date is out of order with the episodes either side and another source\'s is not. A');
  out.push('date a day or two off may be the day a list was posted rather than the day it aired.');
  out.push('');
  for (const line of dateNotes) out.push(`- ${line}`);
  out.push('');
  out.push("Tilgor Kraut's spreadsheet's dates are used only where no other source dates the episode. Where");
  out.push(`it gives another date than the one used (${krautDates.length}): ${krautDates.join(', ')}.`);
  out.push('');
  out.push('## Episodes where the sources list different songs');
  out.push('');
  out.push('The source used (first named) against each source that differs materially: another number of');
  out.push('entries, or an artist one has and the other has not. Differences of spelling, titles or order');
  out.push('alone are not listed.');
  out.push('');
  for (const [number, diffs] of [...differences].sort((a, b) => a[0] - b[0])) {
    const best = episodes.get(number).best;
    out.push(`- #${number} (${SHORT[best.kind]}): ${diffs.map(({ other, line }) => `vs ${SHORT[other.kind]}: ${line}`).join('; ')}`);
  }
  out.push('');
  return out.join('\n');
}

/** XLS rows by artists from Russia and its neighbours, per 50 episodes: how many are spelled in Cyrillic. */
function xlsCyrillic(xls) {
  const out = [];
  for (let from = 1; from <= 499; from += 50) {
    let cyrillic = 0;
    let latin = 0;
    for (let n = from; n < from + 50; n++) {
      for (const r of xls.get(n)?.rows ?? []) {
        if (!/russia|ussr|рф|росси|ukrain|украин|belarus|беларус/i.test(r.Country)) continue;
        if (hasCyrillic(`${r.Artist} ${r.Song} ${r.CD}`)) cyrillic++;
        else latin++;
      }
    }
    out.push({ from, to: Math.min(from + 49, 499), cyrillic, latin });
  }
  return out;
}

/** What the comparison says, in words, with the numbers it rests on. */
function findings(stats, xls, lastSongs, episodes) {
  const s = (a, b) => stats.get(`${a}|${b}`);
  const n = (x) => x.episodes.length;
  const sx = s('soyuz', 'xls');
  const sc = s('soyuz', 'cue');
  const rx = s('radar', 'xls');
  const sl = s('soyuz', 'radar-lower');
  const kx = s('xls', 'kraut');
  const ks = s('soyuz', 'kraut');
  const kf = s('finam', 'kraut');
  const kt = s('tags', 'kraut');
  const onlyKraut = [...episodes.values()].filter((e) => e.best.kind === 'kraut').map((e) => e.number);
  const table = xlsCyrillic(xls)
    .map(({ from, to, cyrillic, latin }) => `| #${from}–#${to} | ${cyrillic} | ${latin} |`)
    .join('\n');
  return `## What it says

- **The radar.lv posts titled «FM Достоевский N от …» (#129–#353) and the XLS are one source, not
  two.** Both come from radar.lv's playlist database: the same Title Case, the same backquote for
  an apostrophe («Jim O\`Rourke»), the same host's notes; they agree in ${rx.agree} of ${n(rx)} episodes.
  Their agreement says nothing about either's accuracy. The posts titled «ФМ Достоевский N от …»
  (#304–#457, lower case, notes on lines of their own) are copies of the program's own lists: they
  agree with fmd.soyuz.ru in ${sl.agree} of ${n(sl)} episodes.
- **The XLS is right about which songs an episode had, wherever it can be checked.** Against
  fmd.soyuz.ru (${n(sx)} episodes, #289–#499) it has the same artists in the same order in ${sx.agree}; in
  ${sx.count} it lacks one entry, in ${sx.artists} the two differ by a duplicated row (#333, where every source has
  a copying slip). Every title matched, Russian ones included: in those years the XLS keeps
  Cyrillic as the site printed it. Its spelling problem is in its early years, which nothing else
  covers: there, Russian names and titles are mostly in Latin letters, transliterated or translated
  into English (НОМ's «Любовь инженера» is «Love Of An Engineer»). Rows by artists from Russia,
  Ukraine and Belarus in the XLS, by whether they are spelled in Cyrillic:

  | Episodes | Cyrillic | Latin letters only |
  |---|---|---|
${table.replace(/^/gm, '  ')}

  So the XLS-only episodes (#1–#128 and the few after with no other source) can be trusted for
  artists and order, less for Russian titles before about #100, which will need finding by hand.
- **Tilgor Kraut's spreadsheet is the XLS's database again, carried on to the end.** Against the XLS
  (${n(kx)} episodes) it has the same artists in the same order in ${kx.agree}; the rest differ by a name it spells
  another way: it is in lower case throughout, merges labels («warner»), fixes typos («nightmares on
  wax» for «Nightwares On Wax») and makes a few («edwin collins»), and spells some Russian names in
  Cyrillic, mostly as \`titles.json\` restores them (once wrongly: Varnaline's «Bardust», #92, as
  «александр ф. скляр»). Against the program's own lists it agrees in ${ks.agree} of ${n(ks)} episodes with
  fmd.soyuz.ru, ${kf.agree} of ${n(kf)} with Finam's pages, and ${kt.agree} of ${n(kt)} with the mp3 tags; it lacks a song now and then, and
  in #758, #760 and #766 has a 15th song that Finam's page has not. It is the only source of
  ${range(onlyKraut)} (${onlyKraut.length} episodes). Against Finam's own pages its dates are a week early for
  #818–#820 («PLAYLIST #820 … от 27.01.2013»), and for #797–#817 the Sunday after the Friday the pages give.
- **CUE sheets follow the recording, not the plan.** Against fmd.soyuz.ru (${n(sc)} episodes) they agree
  in ${sc.agree} and never reorder; where they differ the sheet lacks songs the playlist has: mostly the
  last one (${lastSongs.lacking} of the ${lastSongs.compared} sheets from #484 on that a playlist covers), sometimes one in the middle, and #607's sheet
  stops after 7 songs. Two radar.lv posts say why: «13 трэк АКТ из программы "выкинул"» (#171) and
  «Вместо заявленного в плейлисте 7 трека звучит на самом деле группа "Дочь Монро и Кеннеди"» (#152),
  both as the CUE sheets have it. So a playlist names what was planned; a song it has and the sheet
  lacks may not have aired. The CUE-only episodes (#620–#701) may in turn lack a last song that was
  planned but not aired, or not recorded.
- **fmd.soyuz.ru's pages are not all cp1251**: those of #289–#419 (page ids up to 157) are DOS
  cp866, the later ones (and id 105, #374) cp1251. The script decodes each page both ways and keeps
  the one that reads as Russian.
- **Numbering**: radar.lv's post and CUE sheet for «#148» (8 Dec 1999) hold the XLS's #147 (same
  date, same list); the XLS's #148 (15 Dec 1999) is another list, found nowhere else, and the weekly
  run (#146 on 1 Dec, #149 on 22 Dec) agrees with the XLS. They are filed as #147. radar.lv's
  second CUE sheet for #675 (\`_0\`) carries #675's timings but #674's songs (plus a 17th): left out.`;
}

function missingReport({ missing, incomplete }) {
  const out = [];
  out.push('# «FM Достоевский»: what is missing');
  out.push('');
  out.push('Written by `node bin/fmd-playlists.js` (do not edit by hand). An episode found later goes in');
  out.push('`programs/fmd/sources/` and this script, or, pasted by hand, as `programs/fmd/playlists/<number>.txt` with a');
  out.push('`note:` saying where it came from (and is then lost on the next rebuild unless the script learns');
  out.push('the source).');
  out.push('');
  out.push(`## No playlist (${missing.length} episodes)`);
  out.push('');
  for (const number of missing) out.push(`- #${number}: ${MISSING_WHY(number)}`);
  out.push('');
  out.push(`## Incomplete (${incomplete.length})`);
  out.push('');
  for (const { number, reason } of incomplete) out.push(`- #${number}: ${reason}`);
  if (!incomplete.length) out.push('None.');
  out.push('');
  return out.join('\n');
}

function MISSING_WHY(number) {
  if (number === 795) return 'Finam №94; its page\'s only capture is broken, no list, and no print version was captured';
  if (number >= 702) {
    const finam = number - FINAM_OFFSET;
    const sidebar = [715, 716, 717, 718, 719, 720, 723].includes(number) ? ' (the program page\'s 2011 sidebar names it)' : '';
    return `Finam №${finam}; its page was never captured by the Wayback Machine${sidebar}`;
  }
  if (number >= 620) return 'Feb 2009 – Sep 2010, where radar.lv\'s CUE sheets are the only source, and there is none for it';
  if (number === 317) return 'fmd.soyuz.ru has no page for it, and the XLS and radar.lv skip it';
  if (number >= 129) return "not in the XLS or Tilgor Kraut's spreadsheet, and radar.lv has no post or CUE sheet for it";
  return "not in the XLS or Tilgor Kraut's spreadsheet, the only sources before #129";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

export { compare, partsOf, readCue, readFinam, readFinamRss, readRadar, readSoyuz, readXls };
