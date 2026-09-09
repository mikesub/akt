import assert from 'node:assert/strict';
import test from 'node:test';
import { getMeta, openDb } from '../src/db.js';
import { ingest } from '../src/steps/ingest.js';
import { fixtureFeed, stubFetch, testCtx } from './helpers.js';

const CANONICAL = 'https://feeds.example.test/stereoplan';

function setup({ feedXml = fixtureFeed(), feedUrl = CANONICAL, now } = {}) {
  const db = openDb(':memory:');
  const fetch = stubFetch({ [feedUrl]: feedXml, [CANONICAL]: feedXml });
  return testCtx(db, { feedUrl, fetch, now });
}

function episodes(db) {
  return db.prepare('SELECT * FROM episode ORDER BY guid').all();
}

test('a fresh run inserts one row per feed item at status new', async (t) => {
  const ctx = setup();
  t.after(() => ctx.db.close());

  const counts = await ingest.run(ctx);
  assert.deepEqual(counts, { inserted: 3, updated: 0, unchanged: 0 });

  const rows = episodes(ctx.db);
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((row) => row.status),
    ['new', 'new', 'new'],
  );
  assert.deepEqual(
    rows.map((row) => row.number),
    [84, 75, null],
  );
  assert.deepEqual(
    rows.map((row) => row.duration_sec),
    [3600, 3312, 3723],
  );
  assert.equal(rows[0].published_at, '2025-09-01T03:00:00.000Z');
  assert.equal(rows[0].mp3_url, 'https://media.example.test/84.mp3');
  assert.equal(rows[0].enclosure_length, 57600000);
  assert.equal(rows[0].description_raw, '<p>1. Artist One — Track One (Label, UK, LP)</p>');
  assert.equal(rows[0].description_changed, 0);
  assert.equal(rows[0].error, null);
  assert.equal(rows[0].failed_step, null);
  assert.equal(rows[0].updated_at, '2026-09-09T00:00:00.000Z');
});

test('a second run inserts nothing and modifies nothing', async (t) => {
  const ctx = setup();
  t.after(() => ctx.db.close());

  await ingest.run(ctx);
  const before = episodes(ctx.db);

  ctx.now = () => '2026-09-10T00:00:00.000Z';
  const counts = await ingest.run(ctx);

  assert.deepEqual(counts, { inserted: 0, updated: 0, unchanged: 3 });
  assert.deepEqual(episodes(ctx.db), before);
  assert.equal(getMeta(ctx.db, 'feed_url'), CANONICAL);
});

test('a row still at status new has its feed fields refreshed', async (t) => {
  const ctx = setup();
  t.after(() => ctx.db.close());
  await ingest.run(ctx);

  const changed = fixtureFeed().replace('Осенние пластинки', 'Осенние пластинки (обновлено)');
  ctx.fetch = stubFetch({ [CANONICAL]: changed });
  ctx.now = () => '2026-09-10T00:00:00.000Z';
  const counts = await ingest.run(ctx);

  assert.deepEqual(counts, { inserted: 0, updated: 1, unchanged: 2 });
  const row = episodes(ctx.db)[0];
  assert.ok(row.title.endsWith('(обновлено)'));
  assert.equal(row.description_changed, 0);
  assert.equal(row.updated_at, '2026-09-10T00:00:00.000Z');
});

test('a row past new keeps its title and only refreshes a changed description', async (t) => {
  const ctx = setup();
  t.after(() => ctx.db.close());
  await ingest.run(ctx);
  ctx.db
    .prepare("UPDATE episode SET status = 'parsed' WHERE guid = ?")
    .run('11111111-1111-4111-8111-111111111111');

  const changed = fixtureFeed()
    .replace('Осенние пластинки', 'Осенние пластинки (обновлено)')
    .replace('Artist One — Track One', 'Artist One — Track One (исправлено)');
  ctx.fetch = stubFetch({ [CANONICAL]: changed });
  ctx.now = () => '2026-09-10T00:00:00.000Z';
  const counts = await ingest.run(ctx);

  assert.deepEqual(counts, { inserted: 0, updated: 1, unchanged: 2 });
  const row = episodes(ctx.db)[0];
  assert.equal(row.status, 'parsed');
  assert.ok(
    !row.title.includes('(обновлено)'),
    'title of a parsed episode must not be overwritten',
  );
  assert.ok(row.description_raw.includes('(исправлено)'));
  assert.equal(row.description_changed, 1);
});

test('a row past new with an unchanged description is left alone', async (t) => {
  const ctx = setup();
  t.after(() => ctx.db.close());
  await ingest.run(ctx);
  ctx.db.prepare("UPDATE episode SET status = 'aligned'").run();
  const before = episodes(ctx.db);

  ctx.now = () => '2026-09-11T00:00:00.000Z';
  const counts = await ingest.run(ctx);

  assert.deepEqual(counts, { inserted: 0, updated: 0, unchanged: 3 });
  assert.deepEqual(episodes(ctx.db), before);
});

test('a new episode appearing in the feed is inserted alongside the existing ones', async (t) => {
  const ctx = setup();
  t.after(() => ctx.db.close());
  await ingest.run(ctx);

  const extended = fixtureFeed().replace(
    '    <item>',
    `    <item>
      <title>«Стереоплан Троицкого» #85. Новый выпуск</title>
      <guid isPermaLink="false">44444444-4444-4444-8444-444444444444</guid>
      <pubDate>Mon, 08 Sep 2025 06:00:00 +0300</pubDate>
      <itunes:duration>3500</itunes:duration>
      <enclosure url="https://media.example.test/85.mp3" length="56000000" type="audio/mpeg"/>
      <description><![CDATA[<p>1. Artist Three — Track Three</p>]]></description>
    </item>
    <item>`,
  );
  ctx.fetch = stubFetch({ [CANONICAL]: extended });
  const counts = await ingest.run(ctx);

  assert.deepEqual(counts, { inserted: 1, updated: 0, unchanged: 3 });
  assert.equal(episodes(ctx.db).length, 4);
});

test('an episode that disappears from the feed is kept', async (t) => {
  const ctx = setup();
  t.after(() => ctx.db.close());
  await ingest.run(ctx);

  const full = fixtureFeed();
  const firstItemEnd = full.indexOf('</item>') + '</item>'.length;
  const trimmed = `${full.slice(0, firstItemEnd)}\n  </channel>\n</rss>\n`;
  ctx.fetch = stubFetch({ [CANONICAL]: trimmed });
  await ingest.run(ctx);

  assert.equal(episodes(ctx.db).length, 3);
});

test('feed_url is resolved from itunes:new-feed-url and stable across runs', async (t) => {
  const start = 'https://cloud.mave.digital/61003';
  const db = openDb(':memory:');
  t.after(() => db.close());
  const fetch = stubFetch({ [start]: fixtureFeed(), [CANONICAL]: fixtureFeed() });
  const ctx = testCtx(db, { feedUrl: start, fetch });

  await ingest.run(ctx);
  assert.equal(getMeta(db, 'feed_url'), CANONICAL);
  assert.deepEqual(fetch.calls, [start, CANONICAL]);

  await ingest.run(ctx);
  assert.equal(getMeta(db, 'feed_url'), CANONICAL);
});

test('feed_url falls back to the start URL when the element is absent', async (t) => {
  const start = 'https://cloud.mave.digital/61003';
  const xml = fixtureFeed().replace(
    '<itunes:new-feed-url>https://feeds.example.test/stereoplan</itunes:new-feed-url>',
    '',
  );
  const db = openDb(':memory:');
  t.after(() => db.close());
  const fetch = stubFetch({ [start]: xml });
  await ingest.run(testCtx(db, { feedUrl: start, fetch }));

  assert.equal(getMeta(db, 'feed_url'), start);
  assert.deepEqual(fetch.calls, [start]);
});

test('a failed fetch leaves the database untouched', async (t) => {
  const ctx = setup();
  t.after(() => ctx.db.close());
  await ingest.run(ctx);
  const before = episodes(ctx.db);

  ctx.fetch = stubFetch({});
  await assert.rejects(() => ingest.run(ctx), /404/);
  assert.deepEqual(episodes(ctx.db), before);
});

test('ingest logs one summary line', async (t) => {
  const ctx = setup();
  t.after(() => ctx.db.close());
  await ingest.run(ctx);

  assert.equal(ctx.lines.length, 1);
  assert.match(ctx.lines[0], /3 items, 3 inserted, 0 updated, 0 unchanged, 0 skipped/);
});
