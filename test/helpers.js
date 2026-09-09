import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const FIXTURE_PATH = join(import.meta.dirname, 'fixtures', 'feed.xml');

export const DESCRIPTIONS_PATH = join(import.meta.dirname, 'fixtures', 'descriptions');

/** The fake `claude`/`codex` the suite puts on PATH instead of the real CLI. */
export const FAKE_LLM_PATH = join(import.meta.dirname, 'fixtures', 'fake-llm.sh');

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

/** The envelope `claude -p --output-format json` prints around its reply. */
export function claudeEnvelope(result, { isError = false } = {}) {
  return `${JSON.stringify({ type: 'result', subtype: 'success', is_error: isError, result })}\n`;
}

/** The `call.N` files the fake wrote, oldest first. */
function readFakeCalls(store) {
  const calls = [];
  while (existsSync(join(store, `call.${calls.length + 1}`))) {
    const text = readFileSync(join(store, `call.${calls.length + 1}`), 'utf8');
    const [cwd, entries, apiKey, ...rest] = text.split('\n');
    const argv = rest.join('\n').split('\0');
    // Every recorded argument is NUL-terminated, so the tail is always empty.
    argv.pop();
    calls.push({ cwd, entries: Number(entries), apiKey, argv, prompt: argv.at(-1) ?? null });
  }
  return calls;
}

/**
 * A fake `claude` and `codex` on PATH, so the suite never spawns the real CLI
 * and never needs a login. `replies[i]` answers the i-th call and `reply`
 * answers every call without one of its own; for `cli: 'claude'` a reply is
 * wrapped in the CLI's JSON envelope unless `wrap` is false. `exit`, `stderr`
 * and `sleep` make the fake fail, complain or hang.
 */
export function fakeLlm(t, options = {}) {
  const {
    cli = 'claude',
    replies = [],
    reply = null,
    exit = null,
    stderr = null,
    sleep = null,
  } = options;
  const wrap = options.wrap ?? cli === 'claude';

  const dir = tempDir(t);
  const bin = join(dir, 'bin');
  const store = join(dir, 'calls');
  mkdirSync(bin);
  mkdirSync(store);
  for (const name of ['claude', 'codex']) {
    const target = join(bin, name);
    copyFileSync(FAKE_LLM_PATH, target);
    chmodSync(target, 0o755);
  }

  const wrapped = (text) => (wrap ? claudeEnvelope(text) : text);
  for (const [index, text] of replies.entries()) {
    writeFileSync(join(store, `stdout.${index + 1}`), wrapped(text));
  }
  if (reply !== null) writeFileSync(join(store, 'stdout'), wrapped(reply));

  const env = { PATH: `${bin}:${process.env.PATH}`, FAKE_LLM_DIR: store, LLM_CLI: cli };
  if (exit !== null) env.FAKE_LLM_EXIT = String(exit);
  if (stderr !== null) env.FAKE_LLM_STDERR = stderr;
  if (sleep !== null) env.FAKE_LLM_SLEEP = String(sleep);

  return { bin, store, env, calls: () => readFakeCalls(store) };
}

export function testCtx(db, { feedUrl, fetch, llm = null, now = '2026-09-09T00:00:00.000Z' } = {}) {
  const lines = [];
  return {
    db,
    fetch,
    feedUrl,
    llm,
    log: (line) => lines.push(line),
    now: () => (typeof now === 'function' ? now() : now),
    lines,
  };
}
