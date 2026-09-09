import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from './schema.js';

export const DEFAULT_DB_PATH = './akt.db';

/**
 * Open (creating if needed) the database and bring it up to the current
 * schema version. Safe to call repeatedly on the same file.
 */
export function openDb(path = DEFAULT_DB_PATH) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db) {
  const applied = db.prepare('PRAGMA user_version').get().user_version;
  for (let version = applied; version < MIGRATIONS.length; version++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version]);
      // user_version takes no bound parameter, and the value is an integer we
      // produced ourselves.
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

export function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setMeta(db, key, value) {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}
