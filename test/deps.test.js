import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const ROOT = join(import.meta.dirname, '..');

function readJson(name) {
  return JSON.parse(readFileSync(join(ROOT, name), 'utf8'));
}

/**
 * The runtime dependency list is a decision, not an accident: AGENTS.md asks
 * for it to stay minimal and for every addition to be justified.
 * `fast-xml-parser` is not zero-dependency — it requires `strnum` at module
 * load — so both packages are listed here on purpose.
 */
const ALLOWED_RUNTIME_PACKAGES = ['fast-xml-parser', 'strnum'];

test('the only declared runtime dependency is fast-xml-parser', () => {
  assert.deepEqual(Object.keys(readJson('package.json').dependencies), ['fast-xml-parser']);
});

test('the installed runtime tree is exactly the allowlist, transitives included', () => {
  const lock = readJson('package-lock.json');
  const runtime = Object.entries(lock.packages)
    .filter(([name, entry]) => name.startsWith('node_modules/') && entry.dev !== true)
    .map(([name]) => name.slice('node_modules/'.length))
    .sort();

  assert.deepEqual(
    runtime,
    [...ALLOWED_RUNTIME_PACKAGES].sort(),
    'a runtime package appeared or disappeared: justify it and update the allowlist',
  );
});
