import { createReadStream, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createGunzip } from 'node:zlib';

/**
 * Discogs' monthly CC0 data dumps (data.discogs.com), `discogs_<date>_<kind>.xml.gz`, kept beside the
 * repo, never in it: read streamed from the .gz, never unpacked (10 GB and more once unpacked).
 */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** An XML text with its entities decoded. */
export const decode = (s) =>
  s.replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+));/gi, (all, hex, dec, name) =>
    hex ? String.fromCodePoint(parseInt(hex, 16)) : dec ? String.fromCodePoint(Number(dec)) : (ENTITIES[name] ?? all),
  );

/** A Discogs artist name without its " (2)" disambiguation and its trailing "*" (an ANV mark). */
export const discogsName = (name) => name.replace(/\s\(\d+\)$/, '').replace(/\*$/, '').trim();

/** The newest dump of a kind ("masters", "artists") in `dir`, or null. */
export function newestDump(dir, kind) {
  const files = readdirSync(dir).filter((f) => new RegExp(`^discogs_\\d{8}_${kind}\\.xml\\.gz$`).test(f)).sort();
  return files.length ? join(dir, files.at(-1)) : null;
}

/** A dump's date, "2026-10-01", from its file name. */
export const dumpDate = (file) => file.match(/discogs_(\d{4})(\d{2})(\d{2})_/)?.slice(1).join('-') ?? null;

/** Each `<tag …>…</tag>` record of a gzipped dump, as a string, to `each`. */
export async function records(file, tag, each) {
  const end = `</${tag}>`;
  let buffer = '';
  const stream = createReadStream(file).pipe(createGunzip());
  stream.setEncoding('utf8');
  for await (const chunk of stream) {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf(end)) >= 0) {
      each(buffer.slice(0, at + end.length));
      buffer = buffer.slice(at + end.length);
    }
  }
}

/**
 * A record's genres and styles, as Discogs names them, in its order: two independent lists (Discogs links
 * no style to a genre). A genre that is only digits («1», on a dozen masters) is noise, left out.
 */
export function genresOf(rec) {
  const head = rec.replace(/<videos>[\s\S]*<\/videos>/, '');
  const list = (tag) => [...(head.match(new RegExp(`<${tag}s>([\\s\\S]*?)</${tag}s>`))?.[1] ?? '').matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map(([, v]) => decode(v).trim()).filter((v) => v && !/^\d+$/.test(v));
  return { genres: list('genre'), styles: list('style') };
}

/** A master record's fields: id, main release, year, title, artists ({ id, name, anv }), genres, styles, video titles. */
export function parseMaster(rec) {
  const head = rec.replace(/<videos>[\s\S]*<\/videos>/, '');
  return {
    id: Number(rec.match(/<master id="(\d+)"/)[1]),
    main: Number(head.match(/<main_release>(\d+)<\/main_release>/)?.[1]) || null,
    year: Number(head.match(/<year>(\d+)<\/year>/)?.[1]) || null,
    title: decode(head.match(/<\/artists>[\s\S]*?<title>([\s\S]*?)<\/title>/)?.[1] ?? head.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? ''),
    quality: head.match(/<data_quality>([\s\S]*?)<\/data_quality>/)?.[1] ?? null,
    artists: [...(head.match(/<artists>([\s\S]*?)<\/artists>/)?.[1] ?? '').matchAll(/<artist>([\s\S]*?)<\/artist>/g)].map(([, a]) => ({
      id: Number(a.match(/<id>(\d+)<\/id>/)?.[1]),
      name: decode(a.match(/<name>([\s\S]*?)<\/name>/)?.[1] ?? ''),
      anv: decode(a.match(/<anv>([\s\S]*?)<\/anv>/)?.[1] ?? ''),
    })),
    ...genresOf(rec),
    videos: [...(rec.match(/<videos>([\s\S]*)<\/videos>/)?.[1] ?? '').matchAll(/<video [^>]*>\s*<title>([\s\S]*?)<\/title>/g)].map(([, v]) => decode(v)),
  };
}
