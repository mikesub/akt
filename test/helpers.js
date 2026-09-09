import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

export function testCtx(db, { feedUrl, fetch, now = '2026-09-09T00:00:00.000Z' } = {}) {
  const lines = [];
  return {
    db,
    fetch,
    feedUrl,
    log: (line) => lines.push(line),
    now: () => (typeof now === 'function' ? now() : now),
    lines,
  };
}
