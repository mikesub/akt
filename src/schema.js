/**
 * Database schema, expressed as a list of migrations applied in order.
 *
 * `PRAGMA user_version` records how many entries have been applied. Later
 * slices add a new entry to the end of this array; entries already released
 * are never edited, and no column is ever removed.
 */

const MIGRATION_1 = `
CREATE TABLE episode (
  guid              TEXT PRIMARY KEY,
  number            INTEGER,
  title             TEXT,
  published_at      TEXT,
  mp3_url           TEXT,
  enclosure_length  INTEGER,
  duration_sec      INTEGER,
  description_raw   TEXT,
  description_changed INTEGER,
  status            TEXT NOT NULL,
  error             TEXT,
  failed_step       TEXT,
  notified_error    TEXT,
  tags              TEXT,
  updated_at        TEXT
);

CREATE INDEX episode_status_idx ON episode(status);
CREATE INDEX episode_published_idx ON episode(published_at DESC);

-- Column ownership: every column below is written by exactly one step.
-- A step upserts its own columns on (episode_guid, position) and never
-- touches another step's.
CREATE TABLE track (
  id            INTEGER PRIMARY KEY,
  episode_guid  TEXT NOT NULL REFERENCES episode(guid),
  position      INTEGER NOT NULL,

  -- owner: parse (issues 1 and 2)
  artist        TEXT,
  track         TEXT,
  album         TEXT,
  label         TEXT,
  country       TEXT,
  format        TEXT,
  section       TEXT,
  is_cherished  INTEGER,
  note_desc     TEXT,
  parse_warning TEXT,

  -- owner: extract (issue 6)
  note_spoken   TEXT,
  genre_raw     TEXT,
  tags          TEXT,
  intro_segment INTEGER,

  -- owner: genres (issue 8)
  genre         TEXT,

  -- owner: align (issue 7)
  start_sec     INTEGER,
  start_confidence TEXT,

  -- owner: links (issue 9)
  apple_url     TEXT,
  ytmusic_url   TEXT,

  UNIQUE(episode_guid, position)
);

CREATE TABLE transcript (
  episode_guid TEXT PRIMARY KEY REFERENCES episode(guid),
  segments     TEXT,
  model        TEXT
);

CREATE TABLE segmentation (
  episode_guid TEXT PRIMARY KEY REFERENCES episode(guid),
  intervals    TEXT,
  model        TEXT
);

CREATE TABLE link_cache (
  key        TEXT PRIMARY KEY,
  apple_url  TEXT,
  checked_at TEXT
);

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export const MIGRATIONS = [MIGRATION_1];
