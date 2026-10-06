/**
 * Every outgoing request goes through here, as ../radio's radio-facts does it:
 * paced per host from each service's published limits, holding back where a
 * response says to, and retrying what is worth retrying.
 */

/** Generic on purpose: no contact details, no URL (AGENTS.md, Privacy). */
const USER_AGENT = 'akt/0.1';

/**
 * Milliseconds between two requests to a host, from the published limits
 * (checked 2026-10-05): the iTunes Search API "approximately 20 calls per
 * minute", MusicBrainz 1 a second. Any other host: 1 s.
 */
const GAPS = { 'itunes.apple.com': 3_000, 'musicbrainz.org': 1_100 };
const DEFAULT_GAP = 1_000;
const TRIES = 5;
const RETRY_MAX = 300_000; // the longest Retry-After waited for; longer ones wait this long

const last = new Map();
const until = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function gapFor(host) {
  const entry = Object.entries(GAPS).find(([name]) => host === name || host.endsWith(`.${name}`));
  return entry ? entry[1] : DEFAULT_GAP;
}

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

/** MusicBrainz: at X-RateLimit-Remaining 0, hold the host until X-RateLimit-Reset (epoch seconds). */
function noteLimits(host, headers) {
  if (headers.get('x-ratelimit-remaining') !== '0') return;
  const reset = Number(headers.get('x-ratelimit-reset')) * 1000;
  const hold = reset > 0 ? Math.min(reset, Date.now() + RETRY_MAX) : Date.now() + 1000;
  until.set(host, Math.max(until.get(host) ?? 0, hold));
}

/**
 * The body of `url` as JSON (or text, with `as: 'text'`), or null on 404.
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
      res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(30_000) });
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
    return as === 'text' ? res.text() : res.json();
  }
}
