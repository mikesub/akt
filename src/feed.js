import { get } from './http.js';

const FEED_URL = 'https://cloud.mave.digital/61003';

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/**
 * One element's text. This is one known feed, not XML in general: every item
 * holds the same flat elements, and the free-text ones (title, description)
 * are CDATA, passed through as is. Anything else has its entities decoded.
 */
function element(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`));
  if (!match) return null;
  const cdata = match[1].match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  const text = cdata
    ? cdata[1]
    : match[1].replace(/&(?:(amp|lt|gt|quot|apos)|#(\d+));/g, (_, name, code) =>
        name ? XML_ENTITIES[name] : String.fromCodePoint(Number(code)),
      );
  return text.trim() || null;
}

/**
 * Episode number comes from the title, never from <itunes:episode>: the feed
 * disagrees with itself on real episodes (a title of "#75" carries
 * <itunes:episode>85</itunes:episode>). A null number beats a wrong one.
 */
function episodeNumber(title) {
  const match = title?.match(/#\s?(\d+)/);
  return match ? Number(match[1]) : null;
}

/** <itunes:duration> is SS, MM:SS or HH:MM:SS. */
function durationSeconds(value) {
  if (!value || !/^\d+(?::\d+){0,2}$/.test(value)) return null;
  return value.split(':').reduce((seconds, part) => seconds * 60 + Number(part), 0);
}

function isoDate(value) {
  const date = new Date(value ?? '');
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Every episode in the feed, newest first. */
export async function fetchFeed() {
  const xml = await get(FEED_URL, { as: 'text' });
  if (xml === null) throw new Error(`feed not found: ${FEED_URL}`);

  const items = [];
  for (const [, item] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const guid = element(item, 'guid');
    if (!guid) continue;
    const title = element(item, 'title');
    items.push({
      guid,
      number: episodeNumber(title),
      title,
      published_at: isoDate(element(item, 'pubDate')),
      mp3_url: item.match(/<enclosure\s[^>]*\burl="([^"]+)"/)?.[1] ?? null,
      duration_sec: durationSeconds(element(item, 'itunes:duration')),
      description: element(item, 'description'),
    });
  }
  return items.sort(
    (a, b) => (b.published_at ?? '').localeCompare(a.published_at ?? '') || a.guid.localeCompare(b.guid),
  );
}
