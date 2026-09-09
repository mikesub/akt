import assert from 'node:assert/strict';
import test from 'node:test';
import {
  durationSeconds,
  episodeNumber,
  FEED_START_URL,
  isoDate,
  parseFeed,
  resolveFeed,
} from '../src/feed.js';
import { fixtureFeed, stubFetch } from './helpers.js';

test('episodeNumber reads the title, tolerating a space after the hash', () => {
  assert.equal(episodeNumber('«Стереоплан Троицкого» #84. Осенние пластинки'), 84);
  assert.equal(episodeNumber('Выпуск # 7'), 7);
  assert.equal(episodeNumber('Спецвыпуск без номера'), null);
  assert.equal(episodeNumber(null), null);
});

test('durationSeconds accepts SS, MM:SS and HH:MM:SS', () => {
  assert.equal(durationSeconds('3600'), 3600);
  assert.equal(durationSeconds('55:12'), 3312);
  assert.equal(durationSeconds('01:02:03'), 3723);
  assert.equal(durationSeconds('1:2:3:4'), null);
  assert.equal(durationSeconds('about an hour'), null);
  assert.equal(durationSeconds(undefined), null);
});

test('isoDate converts RFC 822 pubDate to ISO-8601 UTC', () => {
  assert.equal(isoDate('Mon, 01 Sep 2025 06:00:00 +0300'), '2025-09-01T03:00:00.000Z');
  assert.equal(isoDate('not a date'), null);
  assert.equal(isoDate(undefined), null);
});

test('parseFeed maps every item and prefers the title over itunes:episode', () => {
  const { newFeedUrl, items, skipped } = parseFeed(fixtureFeed());
  assert.equal(newFeedUrl, 'https://feeds.example.test/stereoplan');
  assert.equal(skipped, 0);
  assert.equal(items.length, 3);

  assert.deepEqual(items[0], {
    guid: '11111111-1111-4111-8111-111111111111',
    number: 84,
    title: '«Стереоплан Троицкого» #84. Осенние пластинки',
    published_at: '2025-09-01T03:00:00.000Z',
    mp3_url: 'https://media.example.test/84.mp3',
    enclosure_length: 57600000,
    duration_sec: 3600,
    description_raw: '<p>1. Artist One — Track One (Label, UK, LP)</p>',
  });

  // The feed says <itunes:episode>85</itunes:episode> and links to /ep-85.
  assert.equal(items[1].number, 75);
  assert.equal(items[2].number, null);
  assert.equal(items[2].duration_sec, 3723);
});

test('a single-item feed still yields an array', () => {
  const full = fixtureFeed();
  const firstItemEnd = full.indexOf('</item>') + '</item>'.length;
  const xml = `${full.slice(0, firstItemEnd)}\n  </channel>\n</rss>\n`;
  const { items } = parseFeed(xml);
  assert.equal(items.length, 1);
  assert.equal(items[0].number, 84);
});

test('an item without a guid is skipped and counted', () => {
  const xml = fixtureFeed().replace(
    '<guid isPermaLink="false">11111111-1111-4111-8111-111111111111</guid>',
    '',
  );
  const { items, skipped } = parseFeed(xml);
  assert.equal(items.length, 2);
  assert.equal(skipped, 1);
});

test('resolveFeed fetches once when the canonical URL equals the start URL', async () => {
  const url = 'https://feeds.example.test/stereoplan';
  const fetch = stubFetch({ [url]: fixtureFeed() });
  const result = await resolveFeed(fetch, url);
  assert.equal(result.url, url);
  assert.deepEqual(fetch.calls, [url]);
});

test('resolveFeed follows itunes:new-feed-url with exactly one extra fetch', async () => {
  const start = 'https://cloud.mave.digital/61003';
  const canonical = 'https://feeds.example.test/stereoplan';
  const canonicalXml = fixtureFeed().replace('#84', '#84 (canonical)');
  const fetch = stubFetch({ [start]: fixtureFeed(), [canonical]: canonicalXml });
  const result = await resolveFeed(fetch, start);
  assert.equal(result.url, canonical);
  assert.deepEqual(fetch.calls, [start, canonical]);
  assert.equal(parseFeed(result.xml).items[0].title.includes('(canonical)'), true);
});

test('resolveFeed falls back to the start URL when the element is absent', async () => {
  const start = FEED_START_URL;
  const xml = fixtureFeed().replace(
    '<itunes:new-feed-url>https://feeds.example.test/stereoplan</itunes:new-feed-url>',
    '',
  );
  const fetch = stubFetch({ [start]: xml });
  const result = await resolveFeed(fetch, start);
  assert.equal(result.url, start);
  assert.deepEqual(fetch.calls, [start]);
});

test('resolveFeed throws on a non-ok response', async () => {
  const fetch = stubFetch({});
  await assert.rejects(() => resolveFeed(fetch, 'https://missing.example.test/feed'), /404/);
});
