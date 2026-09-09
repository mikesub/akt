import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import { parseCli, UsageError } from '../src/cli.js';
import { openDb } from '../src/db.js';
import { fakeFfmpeg, fakeLlm, fakeWhisper, fixtureFeed, mediaBytes, tempDir } from './helpers.js';

const BIN = join(import.meta.dirname, '..', 'bin', 'akt.js');

/** Every enclosure in the fixture is rewritten to this many served bytes. */
const MEDIA_BYTES = 2048;

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

/**
 * Serve the fixture and its enclosures: the canonical feed URL and every
 * enclosure point back at this server, `/api/` answering a 302 to `/cdn/` the
 * way api.mave.digital does.
 */
function feedServer(t) {
  const feedHits = [];
  const mediaHits = [];
  const server = createServer((req, res) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const path = req.url.split('?')[0];

    if (path.startsWith('/api/')) {
      mediaHits.push(path);
      res.writeHead(302, { location: `${path.replace('/api/', '/cdn/')}?v=7` });
      res.end();
      return;
    }
    if (path.startsWith('/cdn/')) {
      mediaHits.push(path);
      res.writeHead(200, {
        'content-type': 'audio/mpeg',
        'content-length': String(MEDIA_BYTES),
        'accept-ranges': 'bytes',
      });
      res.end(mediaBytes(MEDIA_BYTES));
      return;
    }

    feedHits.push(req.url);
    const xml = fixtureFeed()
      .replace('https://feeds.example.test/stereoplan', `${origin}/feed.xml`)
      .replaceAll('https://media.example.test/', `${origin}/api/`)
      .replaceAll(/length="\d+"/g, `length="${MEDIA_BYTES}"`);
    res.writeHead(200, { 'content-type': 'application/rss+xml' });
    res.end(xml);
  });
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/feed.xml`,
        hits: feedHits,
        mediaHits,
      });
    });
  });
}

/**
 * The env a full run needs: a local feed, a temp media dir, a fake ffmpeg and
 * a fake whisper-cli with stand-in weights. Both fakes want to be first on
 * PATH, so the two directories are spliced onto it together.
 */
function runEnv(t, url) {
  const mediaDir = join(tempDir(t), 'media');
  const ffmpeg = fakeFfmpeg(tempDir(t));
  const llm = fakeLlm(t, { reply: '{"entries": []}' });
  const whisper = fakeWhisper(t);
  return {
    mediaDir,
    ffmpeg,
    whisper,
    env: {
      AKT_FEED_URL: url,
      AKT_MEDIA_DIR: mediaDir,
      AKT_FFMPEG: ffmpeg.bin,
      ...llm.env,
      ...whisper.env,
      PATH: `${whisper.binDir}:${llm.bin}:${process.env.PATH}`,
    },
  };
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

test('akt run ingests the feed, downloads the audio, and repeats nothing', async (t) => {
  const dir = tempDir(t);
  const dbPath = join(dir, 'akt.db');
  const { url, hits, mediaHits } = await feedServer(t);
  const { mediaDir, ffmpeg, whisper, env } = runEnv(t, url);

  const first = await runCli(['run', '--db', dbPath], { cwd: dir, env });
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stderr, /llm claude: /, 'the run reports how often the fallback fired');

  const db = openDb(dbPath);
  const after1 = db.prepare('SELECT * FROM episode ORDER BY guid').all();
  assert.equal(after1.length, 3);
  assert.deepEqual(
    after1.map((row) => row.status),
    ['transcribed', 'transcribed', 'transcribed'],
    'the chain parses, downloads and transcribes every ingested episode in one run',
  );
  assert.equal(db.prepare('SELECT count(*) AS n FROM transcript').get().n, 3);
  assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'feed_url'").get().value, url);
  db.close();

  for (const row of after1) {
    assert.equal(statSync(join(mediaDir, `${row.guid}.mp3`)).size, MEDIA_BYTES);
    assert.equal(existsSync(join(mediaDir, `${row.guid}.wav`)), true);
    assert.equal(existsSync(join(mediaDir, `${row.guid}.mp3.part`)), false);
  }
  assert.equal(ffmpeg.calls().length, 3, 'one decode per episode');
  assert.equal(whisper.calls().length, 3, 'one transcription per episode');
  const mediaHitsAfterFirst = mediaHits.length;

  const second = await runCli(['run', '--db', dbPath], { cwd: dir, env });
  assert.equal(second.code, 0, second.stderr);

  const db2 = openDb(dbPath);
  assert.deepEqual(db2.prepare('SELECT * FROM episode ORDER BY guid').all(), after1);
  db2.close();

  assert.equal(hits.length, 2, 'one feed request per run');
  assert.equal(mediaHits.length, mediaHitsAfterFirst, 'nothing is transferred twice');
  assert.equal(ffmpeg.calls().length, 3, 'nothing is decoded twice');
  assert.equal(whisper.calls().length, 3, 'an episode at transcribed is never transcribed again');
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

  const { env } = runEnv(t, url);
  const result = await runCli(['run'], { cwd: dir, env: { ...env, AKT_DB: dbPath } });
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

  const { env } = runEnv(t, url);
  const result = await runCli(['run', '--db', dbPath], { cwd: dir, env });
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

test('a bad LLM_CLI exits 2 with the usage text, before anything else runs', async (t) => {
  const dir = tempDir(t);
  const dbPath = join(dir, 'akt.db');

  const result = await runCli(['run', '--db', dbPath], { cwd: dir, env: { LLM_CLI: 'gpt' } });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Usage: akt run/);
  assert.equal(existsSync(`${dbPath}.lock`), false, 'a usage error never takes the lock');
});

test('a missing whisper-cli exits 2 and blames the box, not the episodes', async (t) => {
  const dir = tempDir(t);
  const dbPath = join(dir, 'akt.db');
  const { url } = await feedServer(t);
  const { env } = runEnv(t, url);

  const result = await runCli(['run', '--db', dbPath], {
    cwd: dir,
    env: { ...env, WHISPER_CLI: join(dir, 'no-such-whisper-cli') },
  });

  assert.equal(result.code, 2);
  assert.match(result.stderr, /whisper-cli.*not found|no such/i);
  assert.doesNotMatch(result.stderr, /Usage: akt run/, 'a missing binary is not a bad invocation');

  const db = openDb(dbPath);
  const rows = db.prepare('SELECT * FROM episode').all();
  assert.equal(rows.length, 3, 'the run got as far as ingest');
  assert.deepEqual(
    rows.filter((row) => row.error !== null),
    [],
    'no episode is blamed for a prerequisite the box is missing',
  );
  db.close();
  assert.equal(existsSync(`${dbPath}.lock`), false, 'the lock is released on the way out');
});

test('.env.example documents every key the adapter reads', () => {
  const text = readFileSync(join(import.meta.dirname, '..', '.env.example'), 'utf8');
  assert.match(text, /^LLM_CLI=/m, 'LLM_CLI selects the CLI the adapter spawns');
  assert.match(text, /^LLM_TIMEOUT=/m, 'LLM_TIMEOUT bounds a single call');
  assert.match(text, /ANTHROPIC_API_KEY/, 'the optional API-billing key is listed as optional');
  assert.match(text, /^WHISPER_MODEL=/m, 'WHISPER_MODEL is the one model, chosen once');
  assert.match(text, /^WHISPER_MODEL_DIR=/m, 'WHISPER_MODEL_DIR is where the weights live');
  assert.match(text, /^WHISPER_CLI=/m, 'WHISPER_CLI is the binary the adapter spawns');
  assert.match(text, /^WHISPER_TIMEOUT=/m, 'WHISPER_TIMEOUT bounds one episode');
});
