import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import { parseCli, UsageError } from '../src/cli.js';
import { openDb } from '../src/db.js';
import { fixtureFeed, tempDir } from './helpers.js';

const BIN = join(import.meta.dirname, '..', 'bin', 'akt.js');

test('parseCli maps the documented flags', () => {
  assert.deepEqual(parseCli(['run']), {
    command: 'run',
    help: false,
    db: null,
    limit: null,
    episode: null,
    step: null,
  });
  assert.deepEqual(
    parseCli(['run', '--db', '/tmp/x.db', '--limit', '5', '--episode', 'g', '--step', 'ingest']),
    { command: 'run', help: false, db: '/tmp/x.db', limit: 5, episode: 'g', step: 'ingest' },
  );
  assert.equal(parseCli(['--help']).help, true);
  assert.equal(parseCli(['-h']).help, true);
});

test('parseCli rejects bad invocations', () => {
  for (const argv of [
    ['--bogus'],
    ['sing'],
    [],
    ['run', 'extra'],
    ['run', '--limit', '0'],
    ['run', '--limit', 'many'],
  ]) {
    assert.throws(
      () => parseCli(argv),
      UsageError,
      `expected UsageError for ${JSON.stringify(argv)}`,
    );
  }
});

/** Serve the fixture, with its canonical URL pointing back at this server. */
function feedServer(t) {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(req.url);
    const url = `http://127.0.0.1:${server.address().port}/feed.xml`;
    const xml = fixtureFeed().replace('https://feeds.example.test/stereoplan', url);
    res.writeHead(200, { 'content-type': 'application/rss+xml' });
    res.end(xml);
  });
  t.after(() => server.close());
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}/feed.xml`, hits });
    });
  });
}

function runCli(args, { cwd, env = {} }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd,
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('akt run ingests the feed and a second run changes nothing', async (t) => {
  const dir = tempDir(t);
  const dbPath = join(dir, 'akt.db');
  const { url, hits } = await feedServer(t);
  const env = { AKT_FEED_URL: url };

  const first = await runCli(['run', '--db', dbPath], { cwd: dir, env });
  assert.equal(first.code, 0, first.stderr);

  const db = openDb(dbPath);
  const after1 = db.prepare('SELECT * FROM episode ORDER BY guid').all();
  assert.equal(after1.length, 3);
  assert.deepEqual(
    after1.map((row) => row.status),
    ['parsed', 'parsed', 'parsed'],
    'the chain parses every ingested episode in the same run',
  );
  assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'feed_url'").get().value, url);
  db.close();

  const second = await runCli(['run', '--db', dbPath], { cwd: dir, env });
  assert.equal(second.code, 0, second.stderr);

  const db2 = openDb(dbPath);
  assert.deepEqual(db2.prepare('SELECT * FROM episode ORDER BY guid').all(), after1);
  db2.close();

  assert.equal(hits.length, 2, 'one request per run');
  assert.equal(existsSync(`${dbPath}.lock`), false, 'the lock is released on exit');
});

test('akt run --step ingest runs that step alone', async (t) => {
  const dir = tempDir(t);
  const dbPath = join(dir, 'akt.db');
  const { url } = await feedServer(t);

  const result = await runCli(['run', '--db', dbPath, '--step', 'ingest'], {
    cwd: dir,
    env: { AKT_FEED_URL: url },
  });
  assert.equal(result.code, 0, result.stderr);

  const db = openDb(dbPath);
  assert.equal(db.prepare('SELECT count(*) AS n FROM episode').get().n, 3);
  db.close();
});

test('AKT_DB is used when --db is absent', async (t) => {
  const dir = tempDir(t);
  const dbPath = join(dir, 'from-env.db');
  const { url } = await feedServer(t);

  const result = await runCli(['run'], { cwd: dir, env: { AKT_FEED_URL: url, AKT_DB: dbPath } });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(existsSync(dbPath), true);
});

test('a held lock exits 1 and names the pid', async (t) => {
  const dir = tempDir(t);
  const dbPath = join(dir, 'akt.db');
  const { url } = await feedServer(t);
  writeFileSync(`${dbPath}.lock`, `${process.pid}\n`);

  const result = await runCli(['run', '--db', dbPath], { cwd: dir, env: { AKT_FEED_URL: url } });
  assert.equal(result.code, 1);
  assert.match(result.stderr, new RegExp(`pid ${process.pid}`));
});

test('a lock left by a dead process is broken', async (t) => {
  const dir = tempDir(t);
  const dbPath = join(dir, 'akt.db');
  const { url } = await feedServer(t);
  // A pid that cannot be running: process.kill rejects 2147483647 as unknown.
  writeFileSync(`${dbPath}.lock`, '2147483647\n');

  const result = await runCli(['run', '--db', dbPath], { cwd: dir, env: { AKT_FEED_URL: url } });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(existsSync(`${dbPath}.lock`), false);
});

test('an unreachable feed exits 1 without leaving a lock behind', async (t) => {
  const dir = tempDir(t);
  const dbPath = join(dir, 'akt.db');

  const result = await runCli(['run', '--db', dbPath], {
    cwd: dir,
    env: { AKT_FEED_URL: 'http://127.0.0.1:1/feed.xml' },
  });
  assert.equal(result.code, 1);
  assert.equal(existsSync(`${dbPath}.lock`), false);
});

test('--help exits 0 and an unknown flag exits 2', async (t) => {
  const dir = tempDir(t);
  const help = await runCli(['--help'], { cwd: dir });
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage: akt run/);

  const bogus = await runCli(['run', '--bogus'], { cwd: dir });
  assert.equal(bogus.code, 2);
  assert.match(bogus.stderr, /Usage: akt run/);
});
