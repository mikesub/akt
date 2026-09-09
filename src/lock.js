import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';

export class LockHeldError extends Error {
  constructor(pid, path) {
    super(`another akt run is active (pid ${pid}, lock ${path})`);
    this.name = 'LockHeldError';
    this.pid = pid;
  }
}

/**
 * Staleness is decided by whether the recorded PID is alive, never by age:
 * a legitimate run transcribes audio for hours.
 */
function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else.
    return err.code === 'EPERM';
  }
}

function readPid(path) {
  try {
    const pid = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function write(path, pid) {
  const fd = openSync(path, 'wx');
  try {
    writeSync(fd, `${pid}\n`);
  } finally {
    closeSync(fd);
  }
}

function remove(path) {
  try {
    unlinkSync(path);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

/**
 * Take the run lock, breaking one left behind by a dead process.
 * Throws LockHeldError when a live process holds it.
 */
export function acquireLock(path, { pid = process.pid, isAlive = defaultIsAlive } = {}) {
  try {
    write(path, pid);
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    const holder = readPid(path);
    if (holder !== null && isAlive(holder)) throw new LockHeldError(holder, path);
    remove(path);
    write(path, pid);
  }
  let released = false;
  return {
    path,
    release() {
      if (released) return;
      released = true;
      remove(path);
    },
  };
}
