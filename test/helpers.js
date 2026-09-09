import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const FIXTURE_PATH = join(import.meta.dirname, 'fixtures', 'feed.xml');

export function fixtureFeed() {
  return readFileSync(FIXTURE_PATH, 'utf8');
}

/** A temp directory that removes itself when the test ends. */
export function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'akt-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A fetch stub over a { url: xml } map that records every requested URL. */
export function stubFetch(responses) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(String(url));
    const body = responses[String(url)];
    if (body === undefined) {
      return { ok: false, status: 404, statusText: 'Not Found', text: async () => '' };
    }
    return { ok: true, status: 200, statusText: 'OK', text: async () => body };
  };
  fetch.calls = calls;
  return fetch;
}

export function testCtx(
  db,
  {
    feedUrl,
    fetch,
    now = '2026-09-09T00:00:00.000Z',
    mediaDir,
    keepMedia = false,
    ffmpeg = 'ffmpeg',
  } = {},
) {
  const lines = [];
  return {
    db,
    fetch,
    feedUrl,
    mediaDir,
    keepMedia,
    ffmpeg,
    log: (line) => lines.push(line),
    now: () => (typeof now === 'function' ? now() : now),
    lines,
  };
}

/** The bytes the media server serves: deterministic, so sizes are assertable. */
export function mediaBytes(size) {
  return Buffer.alloc(size, 'AKT!');
}

/**
 * Stand-in for api.mave.digital + cdn.mave.digital: `/api/<name>.mp3` answers
 * a 302 to `/cdn/<name>.mp3?v=<n>`, which serves `opts.size` deterministic
 * bytes with a Content-Length and `Accept-Ranges: bytes`. `opts` is mutable so
 * a test can make the next transfer misbehave.
 */
export function mediaServer(t, options = {}) {
  const opts = { size: 4096, interruptAfter: null, chunked: false, ...options };
  const hits = [];

  const server = createServer((req, res) => {
    hits.push(req.url);
    const path = req.url.split('?')[0];
    if (path.startsWith('/api/')) {
      res.writeHead(302, { location: `${path.replace('/api/', '/cdn/')}?v=7` });
      res.end();
      return;
    }
    if (!path.startsWith('/cdn/')) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('no such enclosure');
      return;
    }
    const headers = { 'content-type': 'audio/mpeg', 'accept-ranges': 'bytes' };
    if (!opts.chunked) headers['content-length'] = String(opts.size);
    res.writeHead(200, headers);
    const body = mediaBytes(opts.size);
    if (opts.interruptAfter !== null) {
      res.write(body.subarray(0, opts.interruptAfter), () => res.socket.destroy());
      return;
    }
    res.end(body);
  });

  t.after(() => {
    server.closeAllConnections();
    server.close();
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const origin = `http://127.0.0.1:${server.address().port}`;
      resolve({ origin, hits, opts, url: (name) => `${origin}/api/${name}.mp3` });
    });
  });
}

/**
 * An ffmpeg that records its argv and writes a fixed payload to its last
 * argument. ffmpeg is a prerequisite of the box, not an npm dependency, so
 * tests substitute it through AKT_FFMPEG / ctx.ffmpeg.
 */
export function fakeFfmpeg(dir, { exitCode = 0, stderr = '' } = {}) {
  const bin = join(dir, 'ffmpeg');
  const argsLog = join(dir, 'ffmpeg.args');
  writeFileSync(
    bin,
    [
      '#!/bin/sh',
      `echo "$@" >> ${JSON.stringify(argsLog)}`,
      stderr ? `printf '%s' ${JSON.stringify(stderr)} >&2` : ':',
      'for out; do :; done',
      `if [ ${exitCode} -eq 0 ]; then printf 'FAKEWAVDATA' > "$out"; fi`,
      `exit ${exitCode}`,
      '',
    ].join('\n'),
  );
  chmodSync(bin, 0o755);
  return {
    bin,
    calls() {
      try {
        return readFileSync(argsLog, 'utf8').trim().split('\n').filter(Boolean);
      } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
      }
    },
  };
}
