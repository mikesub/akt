import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { acquireLock, LockHeldError } from '../src/lock.js';
import { tempDir } from './helpers.js';

function lockPath(t) {
  return join(tempDir(t), 'akt.db.lock');
}

test('acquiring a free lock writes the pid', (t) => {
  const path = lockPath(t);
  const lock = acquireLock(path);
  assert.equal(readFileSync(path, 'utf8').trim(), String(process.pid));
  lock.release();
  assert.equal(existsSync(path), false);
});

test('a lock held by a live process is refused', (t) => {
  const path = lockPath(t);
  acquireLock(path, { pid: 4242, isAlive: () => true });
  assert.throws(
    () => acquireLock(path, { isAlive: () => true }),
    (err) => err instanceof LockHeldError && err.pid === 4242,
  );
});

test('a lock left by a dead process is broken, never one judged by age', (t) => {
  const path = lockPath(t);
  acquireLock(path, { pid: 4242, isAlive: () => true });
  const lock = acquireLock(path, { pid: 7, isAlive: (pid) => pid !== 4242 });
  assert.equal(readFileSync(path, 'utf8').trim(), '7');
  lock.release();
});

test('an unparseable lock file is broken', (t) => {
  const path = lockPath(t);
  writeFileSync(path, 'not a pid\n');
  const lock = acquireLock(path, { pid: 9, isAlive: () => true });
  assert.equal(readFileSync(path, 'utf8').trim(), '9');
  lock.release();
});

test('release is idempotent and tolerates a missing file', (t) => {
  const path = lockPath(t);
  const lock = acquireLock(path);
  lock.release();
  lock.release();
  assert.equal(existsSync(path), false);
});

test('the default liveness check sees this very process', (t) => {
  const path = lockPath(t);
  acquireLock(path, { pid: process.pid });
  assert.throws(() => acquireLock(path), LockHeldError);
});
