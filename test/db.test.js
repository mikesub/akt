import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { getMeta, openDb, setMeta } from '../src/db.js';
import { tempDir } from './helpers.js';

const EPISODE_COLUMNS = [
  'guid',
  'number',
  'title',
  'published_at',
  'mp3_url',
  'enclosure_length',
  'duration_sec',
  'description_raw',
  'description_changed',
  'status',
  'error',
  'failed_step',
  'notified_error',
  'tags',
  'updated_at',
];

const TRACK_COLUMNS = [
  'id',
  'episode_guid',
  'position',
  'artist',
  'track',
  'album',
  'label',
  'country',
  'format',
  'section',
  'is_cherished',
  'note_desc',
  'parse_warning',
  'note_spoken',
  'genre_raw',
  'tags',
  'intro_segment',
  'genre',
  'start_sec',
  'start_confidence',
  'apple_url',
  'ytmusic_url',
];

function columns(db, table) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => row.name);
}

test('openDb creates every table in the schema', () => {
  const db = openDb(':memory:');
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name);
  for (const table of ['episode', 'track', 'transcript', 'segmentation', 'link_cache', 'meta']) {
    assert.ok(tables.includes(table), `missing table ${table}`);
  }
  db.close();
});

test('episode and track carry every specified column', () => {
  const db = openDb(':memory:');
  assert.deepEqual(columns(db, 'episode').sort(), [...EPISODE_COLUMNS].sort());
  assert.deepEqual(columns(db, 'track').sort(), [...TRACK_COLUMNS].sort());
  assert.deepEqual(columns(db, 'transcript'), ['episode_guid', 'segments', 'model']);
  assert.deepEqual(columns(db, 'segmentation'), ['episode_guid', 'intervals', 'model']);
  assert.deepEqual(columns(db, 'link_cache'), ['key', 'apple_url', 'checked_at']);
  db.close();
});

test('track is unique on (episode_guid, position)', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO episode (guid, status) VALUES ('g', 'new')").run();
  db.prepare('INSERT INTO track (episode_guid, position) VALUES (?, ?)').run('g', 1);
  assert.throws(
    () => db.prepare('INSERT INTO track (episode_guid, position) VALUES (?, ?)').run('g', 1),
    /UNIQUE/,
  );
  db.close();
});

test('migrations run once and reopening the same file is a no-op', (t) => {
  const path = join(tempDir(t), 'akt.db');
  const first = openDb(path);
  assert.equal(first.prepare('PRAGMA user_version').get().user_version, 1);
  setMeta(first, 'feed_url', 'https://example.test/feed');
  first.close();

  const second = openDb(path);
  assert.equal(second.prepare('PRAGMA user_version').get().user_version, 1);
  assert.equal(getMeta(second, 'feed_url'), 'https://example.test/feed');
  second.close();
});

test('setMeta overwrites and getMeta returns null for an unknown key', () => {
  const db = openDb(':memory:');
  assert.equal(getMeta(db, 'feed_url'), null);
  setMeta(db, 'feed_url', 'a');
  setMeta(db, 'feed_url', 'b');
  assert.equal(getMeta(db, 'feed_url'), 'b');
  db.close();
});
