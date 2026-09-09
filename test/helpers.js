import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const FIXTURE_PATH = join(import.meta.dirname, 'fixtures', 'feed.xml');

export const DESCRIPTIONS_PATH = join(import.meta.dirname, 'fixtures', 'descriptions');

export function fixtureFeed() {
  return readFileSync(FIXTURE_PATH, 'utf8');
}

/**
 * Every checked-in description fixture, oldest first. The episodes span the
 * feed and both entry layouts: #4 and #20 predate the numbered one-line shape,
 * #40 and #42 use the two-line `LP Album (Label)` shape, #75-#84 the current
 * one. Listed explicitly so a fixture cannot go missing unnoticed.
 */
export const DESCRIPTION_FIXTURES = [
  '004',
  '020',
  '040',
  '042',
  '075',
  '077',
  '078',
  '079',
  '080',
  '081',
  '083',
  '084',
];

/**
 * One description fixture: `html` is verbatim `description_raw` as ingest
 * stored it, `expected` the hand-verified parse. Nothing here touches the
 * network.
 */
export function descriptionFixture(name) {
  if (!DESCRIPTION_FIXTURES.includes(name)) {
    throw new Error(`unknown description fixture: ${name}`);
  }
  return {
    name,
    html: readFileSync(join(DESCRIPTIONS_PATH, `${name}.html`), 'utf8'),
    expected: JSON.parse(readFileSync(join(DESCRIPTIONS_PATH, `${name}.json`), 'utf8')),
  };
}

/** Every description fixture, oldest episode first. */
export function descriptionFixtures() {
  return DESCRIPTION_FIXTURES.map((name) => descriptionFixture(name));
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
