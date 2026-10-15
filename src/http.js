/**
 * Every outgoing request goes through here: paced per host from each
 * service's published limits, holding back where a response says to, and
 * retrying what is worth retrying.
 */

/** Generic on purpose: no contact details, no URL (AGENTS.md, Privacy). */
const USER_AGENT = 'akt/0.1';

/**
 * MusicBrainz alone gets the project's contact address (CLAUDE.md): without
 * one it throttles a User-Agent as anonymous, in a bucket shared with every
 * other such client, and answers 503 whenever that bucket runs dry.
 */
const USER_AGENTS = { 'musicbrainz.org': 'akt/0.1 ( akt@mksb.me )' };

/**
 * Milliseconds between two requests to a host, from the published limits
 * (checked 2026-10-05): the iTunes Search API "approximately 20 calls per
 * minute", MusicBrainz 1 a second, Discogs 25 a minute without a token
 * (its X-Discogs-Ratelimit header, checked 2026-10-13). svoboda.org publishes
 * no limit and its robots.txt no Crawl-delay: 2 s, as a courtesy to a news
 * site. radar.lv, a fan site's FM Достоевский archive: 10 s, its robots.txt
 * Crawl-delay (checked 2026-10-14). web.archive.org publishes no limit and
 * answers 429 when pushed: 4 s, as a courtesy. Any other host: 1 s.
 */
const GAPS = {
  'itunes.apple.com': 3_000,
  'musicbrainz.org': 1_100,
  'api.discogs.com': 2_500,
  'svoboda.org': 2_000,
  'radar.lv': 10_000,
  'web.archive.org': 4_000,
};
const DISCOGS_WINDOW = 60_000; // Discogs counts requests over a moving minute
const DEFAULT_GAP = 1_000;
const TRIES = 5;
const RETRY_MAX = 300_000; // the longest Retry-After waited for; longer ones wait this long

const last = new Map();
const until = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A host's value in a per-host table: its own or its parent domain's, else undefined. */
const forHost = (table, host) => Object.entries(table).find(([name]) => host === name || host.endsWith(`.${name}`))?.[1];

const gapFor = (host) => forHost(GAPS, host) ?? DEFAULT_GAP;

/** Milliseconds a Retry-After header asks for (seconds or an HTTP date), else `fallback`. */
function retryAfter(headers, fallback) {
  const value = headers.get('retry-after');
  if (value) {
    if (/^\d+(\.\d+)?$/.test(value)) return Number(value) * 1000;
    const date = Date.parse(value);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  }
  return fallback;
}

/**
 * MusicBrainz: at X-RateLimit-Remaining 0, hold the host until X-RateLimit-Reset (epoch seconds).
 * Discogs: at X-Discogs-Ratelimit-Remaining 0, hold it for its minute.
 */
function noteLimits(host, headers) {
  let hold = 0;
  if (headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(headers.get('x-ratelimit-reset')) * 1000;
    hold = reset > 0 ? Math.min(reset, Date.now() + RETRY_MAX) : Date.now() + 1000;
  } else if (headers.get('x-discogs-ratelimit-remaining') === '0') {
    hold = Date.now() + DISCOGS_WINDOW;
  }
  if (hold > 0) until.set(host, Math.max(until.get(host) ?? 0, hold));
}

/**
 * The body of `url` as JSON (or text, with `as: 'text'`; raw bytes, a Buffer, with
 * `as: 'bytes'`, for a page in an encoding to be decided later), or null on 404.
 * A 429 or 503 waits as its Retry-After says, but never less than 2, 4, 6… s
 * (MusicBrainz answers a busy 503 with "Retry-After: 0"), and tries again; a
 * network error waits 5 s; up to five requests in all.
 */
export async function get(url, { as = 'json' } = {}) {
  const host = new URL(url).hostname;
  for (let attempt = 1; ; attempt++) {
    const wait = Math.max((last.get(host) ?? 0) + gapFor(host), until.get(host) ?? 0) - Date.now();
    if (wait > 0) await sleep(wait);
    last.set(host, Date.now());

    let res;
    try {
      res = await fetch(url, { headers: { 'User-Agent': forHost(USER_AGENTS, host) ?? USER_AGENT }, signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      if (attempt < TRIES) {
        console.error(`${host}: ${err.message}, retrying in 5 s`);
        await sleep(5_000);
        continue;
      }
      throw new Error(`${err.message} (${host})`);
    }

    noteLimits(host, res.headers);
    if (res.status === 404) return null;
    if ((res.status === 429 || res.status === 503) && attempt < TRIES) {
      const pause = Math.min(RETRY_MAX, Math.max(retryAfter(res.headers, 0), 2_000 * attempt));
      console.error(`${host}: HTTP ${res.status}, retrying in ${Math.round(pause / 1000)} s`);
      until.set(host, Date.now() + pause);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} (${host})`);
    if (as === 'bytes') return Buffer.from(await res.arrayBuffer());
    return as === 'text' ? res.text() : res.json();
  }
}
