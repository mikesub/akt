import fxp from 'fast-xml-parser';

export const FEED_START_URL = 'https://cloud.mave.digital/61003';

const FETCH_TIMEOUT_MS = 30_000;

const parser = new fxp.XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (_name, jpath) => jpath === 'rss.channel.item',
});

/** Read an element that may be a bare string or an object carrying attributes. */
function text(node) {
  if (node === undefined || node === null) return null;
  if (typeof node === 'string') return node;
  if (typeof node === 'object' && typeof node['#text'] === 'string') return node['#text'];
  if (typeof node === 'number' || typeof node === 'boolean') return String(node);
  return null;
}

/**
 * Episode number comes from the title, never from <itunes:episode>: the feed
 * disagrees with itself on real episodes (a title of "#75" carries
 * <itunes:episode>85</itunes:episode>). A null number beats a wrong one.
 */
export function episodeNumber(title) {
  if (typeof title !== 'string') return null;
  const match = title.match(/#\s?(\d+)/);
  return match ? Number.parseInt(match[1], 10) : null;
}

/** <itunes:duration> is SS, MM:SS or HH:MM:SS depending on the episode. */
export function durationSeconds(value) {
  const raw = text(value);
  if (raw === null) return null;
  const parts = raw.trim().split(':');
  if (parts.length > 3) return null;
  let seconds = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    seconds = seconds * 60 + Number.parseInt(part, 10);
  }
  return seconds;
}

export function isoDate(value) {
  const raw = text(value);
  if (raw === null) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function integer(value) {
  const raw = text(value);
  if (raw === null || !/^\d+$/.test(raw.trim())) return null;
  return Number.parseInt(raw.trim(), 10);
}

/**
 * Parse an RSS 2.0 document into the episode fields this slice owns.
 * Items without a <guid> cannot be keyed, so they are skipped and counted.
 */
export function parseFeed(xml) {
  const doc = parser.parse(xml);
  const channel = doc?.rss?.channel ?? {};
  const newFeedUrl = text(channel['itunes:new-feed-url']);
  const rawItems = Array.isArray(channel.item) ? channel.item : [];

  const items = [];
  let skipped = 0;
  for (const item of rawItems) {
    const guid = text(item.guid);
    if (!guid) {
      skipped++;
      continue;
    }
    const title = text(item.title);
    const description = text(item.description);
    items.push({
      guid: guid.trim(),
      number: episodeNumber(title),
      title,
      published_at: isoDate(item.pubDate),
      mp3_url: item.enclosure?.['@_url'] ?? null,
      enclosure_length: integer(item.enclosure?.['@_length']),
      duration_sec: durationSeconds(item['itunes:duration']),
      description_raw: description === null ? null : description.trim(),
    });
  }

  return { newFeedUrl: newFeedUrl ? newFeedUrl.trim() : null, items, skipped };
}

async function get(fetchImpl, url) {
  const res = await fetchImpl(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`feed request failed: ${res.status} ${res.statusText} (${url})`);
  return await res.text();
}

/**
 * Fetch the feed, honouring <itunes:new-feed-url>. The canonical URL is
 * fetched again only when it differs from the start URL, so the usual run
 * costs exactly one request.
 */
export async function resolveFeed(fetchImpl, startUrl = FEED_START_URL) {
  const xml = await get(fetchImpl, startUrl);
  const { newFeedUrl } = parseFeed(xml);
  if (!newFeedUrl || newFeedUrl === startUrl) return { url: startUrl, xml };
  return { url: newFeedUrl, xml: await get(fetchImpl, newFeedUrl) };
}
