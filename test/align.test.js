import assert from 'node:assert/strict';
import test from 'node:test';
import { fold } from '../docs/lib/translit.js';
import { alignTracks, matchScore, nameForms, STRONG, WEAK } from '../src/align.js';
import { openDb } from '../src/db.js';
import { runPipeline } from '../src/runner.js';
import { align } from '../src/steps/align.js';
import { registry } from '../src/steps/registry.js';
import { parseSynonyms } from '../src/synonyms.js';
import { testCtx } from './helpers.js';

const GUID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

/** Three songs, each with a minute of host commentary in front of it. */
const THREE_SONGS = [
  { start: 0, end: 60, label: 'speech' },
  { start: 60, end: 240, label: 'music' },
  { start: 240, end: 300, label: 'speech' },
  { start: 300, end: 480, label: 'music' },
  { start: 480, end: 540, label: 'speech' },
  { start: 540, end: 720, label: 'music' },
  { start: 720, end: 780, label: 'speech' },
];

/** Two songs, starting on a fraction of a second as the VAD reports them. */
const TWO_SONGS = [
  { start: 0, end: 60.4, label: 'speech' },
  { start: 60.4, end: 240, label: 'music' },
  { start: 240, end: 300.75, label: 'speech' },
  { start: 300.75, end: 480, label: 'music' },
];

/** Five songs: room for two anchors with a gap of two songs between them. */
const FIVE_SONGS = [
  { start: 0, end: 60, label: 'speech' },
  { start: 60, end: 120, label: 'music' },
  { start: 120, end: 180, label: 'speech' },
  { start: 180, end: 240, label: 'music' },
  { start: 240, end: 300, label: 'speech' },
  { start: 300, end: 360, label: 'music' },
  { start: 360, end: 420, label: 'speech' },
  { start: 420, end: 480, label: 'music' },
  { start: 480, end: 540, label: 'speech' },
  { start: 540, end: 600, label: 'music' },
  { start: 600, end: 620, label: 'speech' },
];

function trackOf(position, artist, name, intro = null) {
  return { position, artist, track: name, intro_segment: intro };
}

const THREE_TRACKS = [
  trackOf(1, 'Portishead', 'Roads'),
  trackOf(2, 'Аквариум', 'Стаканы'),
  trackOf(3, 'Наутилус', 'Скованные'),
];

/**
 * The shape the host actually speaks in: the first song is announced, the
 * second is only named once it is over — «Это был Аквариум» — and the third is
 * announced in that same breath. A greedy reading hands the second track the
 * interval after its mention and pushes every later track along with it.
 */
const CASCADE = [
  { start: 10, end: 20, text: 'Здравствуйте, в эфире «Стереоплан», у микрофона Артемий Троицкий.' },
  { start: 50, end: 58, text: 'Начнём мы сегодня с новой пластинки Портисхед.' },
  { start: 245, end: 255, text: 'Прекрасная вещь, ничего не скажешь.' },
  { start: 482, end: 492, text: 'Это был Аквариум, запись прошлого года.' },
  { start: 530, end: 538, text: 'А сейчас — Наутилус.' },
];

/** Commentary that names nobody: order is the only evidence there is. */
const NO_NAMES = [
  { start: 10, end: 50, text: 'Здравствуйте, в эфире «Стереоплан».' },
  { start: 250, end: 280, text: 'Идём дальше.' },
  { start: 490, end: 530, text: 'И ещё кое-что напоследок.' },
];

/**
 * Every constraint the spec states as an invariant rather than as an outcome,
 * checked on every fixture: an index into the music intervals or nothing at
 * all, never a start before an earlier track's, never a confidence without a
 * start.
 */
function assertShape(result, tracks, intervals) {
  const music = intervals.filter((interval) => interval.label === 'music');
  assert.deepEqual(
    result.map((entry) => entry.position),
    tracks.map((track) => track.position),
    'one entry per track, in position order',
  );

  let previous = -1;
  for (const entry of result) {
    if (entry.interval === null) {
      assert.equal(entry.confidence, null, `position ${entry.position}: no start, no confidence`);
      assert.equal(entry.evidence, null);
      continue;
    }
    assert.ok(Number.isInteger(entry.interval), `position ${entry.position}: an interval index`);
    assert.ok(music[entry.interval], `position ${entry.position}: index into the music intervals`);
    assert.ok(entry.interval > previous, `position ${entry.position} starts after the one before`);
    previous = entry.interval;
    assert.ok(['high', 'medium', 'low'].includes(entry.confidence), entry.confidence);
    assert.ok(['name', 'intro', 'order'].includes(entry.evidence), String(entry.evidence));
  }
}

function run(tracks, segments, intervals, synonyms = null) {
  const result = alignTracks({ tracks, segments, intervals, synonyms });
  assertShape(result, tracks, intervals);
  return result;
}

test('a name whisper spelled in cyrillic scores as a match', () => {
  const text = fold('Начнём мы сегодня с новой пластинки Портисхед.');
  assert.ok(matchScore(fold('Portishead'), text) >= STRONG, 'the transliterated artist is there');
  assert.equal(matchScore(fold('Аквариум'), fold('Аквариум')), 1, 'an exact form scores 1');
});

test('a transliteration one letter off the transcript still matches', () => {
  const score = matchScore(fold('Brücken'), fold('Пластинка «Брюкен» вышла в марте'));
  assert.ok(score >= STRONG, `rule-based translit is approximate on purpose, got ${score}`);
});

test('a name the host never said scores below the weak threshold', () => {
  const text = fold('Поговорим сначала о погоде и о новостях недели');
  assert.ok(matchScore(fold('Portishead'), text) < WEAK);
});

test('a short name has to be a whole word, never a syllable inside one', () => {
  assert.ok(matchScore(fold('Оса'), fold('На столе лежала колбаса')) < WEAK);
  assert.ok(matchScore(fold('Оса'), fold('Летит оса')) >= STRONG);
});

test('nameForms covers the artist, the track and the aliases of the artist', () => {
  const track = trackOf(1, 'Depeche Mode', 'Enjoy the Silence');
  const plain = nameForms(track, null).map(fold);
  assert.ok(plain.includes(fold('Depeche Mode')), 'the artist');
  assert.ok(plain.includes(fold('Enjoy the Silence')), 'the track');

  const aliased = nameForms(track, parseSynonyms('Depeche Mode: [Депеш Мод]')).map(fold);
  assert.ok(aliased.includes(fold('Депеш Мод')), 'an alias is a form of its own');
});

test('a track named only after it played keeps its own interval', () => {
  const result = run(THREE_TRACKS, CASCADE, THREE_SONGS);

  assert.deepEqual(result, [
    { position: 1, interval: 0, confidence: 'high', evidence: 'name' },
    { position: 2, interval: 1, confidence: 'low', evidence: 'order' },
    { position: 3, interval: 2, confidence: 'high', evidence: 'name' },
  ]);
});

test('equal counts and no mentions give the diagonal, at low confidence', () => {
  const result = run(THREE_TRACKS, NO_NAMES, THREE_SONGS);

  assert.deepEqual(
    result.map((entry) => [entry.interval, entry.confidence, entry.evidence]),
    [
      [0, 'low', 'order'],
      [1, 'low', 'order'],
      [2, 'low', 'order'],
    ],
  );
});

test('a name spoken far from the boundary places the track at medium', () => {
  const tracks = [trackOf(1, 'Аквариум', 'Стаканы')];
  const segments = [
    { start: 5, end: 12, text: 'Сегодня у нас Аквариум и много чего ещё.' },
    { start: 40, end: 55, text: 'Но сначала несколько слов о концерте на прошлой неделе.' },
  ];
  // The mention ends 48 s before the song: right, but not near.
  const intervals = [
    { start: 0, end: 60, label: 'speech' },
    { start: 60, end: 240, label: 'music' },
  ];

  const result = run(tracks, segments, intervals);
  assert.deepEqual(result, [{ position: 1, interval: 0, confidence: 'medium', evidence: 'name' }]);
});

test('a name too short to be matched fuzzily never claims high on its own', () => {
  const tracks = [trackOf(1, 'Кино', 'Восьмиклассница')];
  const intervals = TWO_SONGS.slice(0, 2);

  // «Кино» is a band and the ordinary word for films. The host is talking
  // about films: the track is still placed, but nothing here knows that.
  const ordinary = [{ start: 50, end: 58, text: 'Мы говорили про кино и про театр.' }];
  assert.deepEqual(run(tracks, ordinary, intervals), [
    { position: 1, interval: 0, confidence: 'medium', evidence: 'name' },
  ]);

  // The title is long enough to be a name on its own, so it still reaches high.
  const named = [{ start: 50, end: 58, text: 'Дальше — Кино с песней «Восьмиклассница».' }];
  assert.deepEqual(run(tracks, named, intervals), [
    { position: 1, interval: 0, confidence: 'high', evidence: 'name' },
  ]);
});

test('a short name never outbids the evidence of the track before it', () => {
  const tracks = [trackOf(1, 'Аквариум', 'Стаканы', 0), trackOf(2, 'Кино', 'Восьмиклассница')];
  const segments = [
    { start: 50, end: 58, text: 'Мы говорили про кино и про театр.' },
    { start: 285, end: 295, text: 'А это — совсем другая история.' },
  ];

  const result = run(tracks, segments, TWO_SONGS);

  // Read as a mention of the band, that «кино» outweighs the first track's
  // own intro_segment and, because starts only increase, takes the first
  // song away from it entirely.
  assert.deepEqual(result, [
    { position: 1, interval: 0, confidence: 'medium', evidence: 'intro' },
    { position: 2, interval: 1, confidence: 'low', evidence: 'order' },
  ]);
});

test('evidence in the wrong order never puts a later track before an earlier one', () => {
  const tracks = [trackOf(1, 'Аквариум', 'Стаканы'), trackOf(2, 'Наутилус', 'Скованные')];
  const segments = [
    { start: 50, end: 58, text: 'Сейчас — Наутилус.' },
    { start: 290, end: 298, text: 'А теперь Аквариум.' },
  ];

  const result = run(tracks, segments, TWO_SONGS);

  const placed = result.filter((entry) => entry.interval !== null);
  assert.equal(placed.length, 1, 'both mentions cannot be honoured without going backwards');
  assert.equal(placed[0].confidence, 'high', 'the mention that survived was near its boundary');
  assert.equal(placed[0].evidence, 'name');
});

test('unequal counts with no evidence at all leave every track unplaced', () => {
  const result = run(THREE_TRACKS, NO_NAMES, TWO_SONGS);

  for (const entry of result) {
    assert.deepEqual(entry, {
      position: entry.position,
      interval: null,
      confidence: null,
      evidence: null,
    });
  }
});

test('two anchors fill the songs between them in order, at low confidence', () => {
  const tracks = [
    trackOf(1, 'Portishead', 'Roads'),
    trackOf(2, 'Аквариум', 'Стаканы'),
    trackOf(3, 'Наутилус', 'Скованные'),
    trackOf(4, 'Пикник', 'Иероглиф'),
  ];
  const segments = [
    { start: 130, end: 175, text: 'Начнём с Портисхед.' },
    { start: 490, end: 535, text: 'И напоследок — Пикник.' },
  ];

  const result = run(tracks, segments, FIVE_SONGS);

  assert.deepEqual(
    result.map((entry) => [entry.interval, entry.confidence, entry.evidence]),
    [
      [1, 'high', 'name'],
      [2, 'low', 'order'],
      [3, 'low', 'order'],
      [4, 'high', 'name'],
    ],
  );
});

test('an intro_segment in the lead-in places the track at medium', () => {
  const tracks = [trackOf(1, 'Аквариум', 'Стаканы'), trackOf(2, 'Пикник', 'Иероглиф', 1)];
  const segments = [
    { start: 50, end: 58, text: 'Сейчас — Аквариум.' },
    { start: 285, end: 295, text: 'А это — совсем другая история.' },
  ];

  const result = run(tracks, segments, TWO_SONGS);

  assert.deepEqual(result, [
    { position: 1, interval: 0, confidence: 'high', evidence: 'name' },
    { position: 2, interval: 1, confidence: 'medium', evidence: 'intro' },
  ]);
});

test('an intro_segment pointing nowhere is ignored rather than thrown over', () => {
  const tracks = [trackOf(1, 'Аквариум', 'Стаканы'), trackOf(2, 'Пикник', 'Иероглиф', 9)];
  const segments = [
    { start: 50, end: 58, text: 'Сейчас — Аквариум.' },
    { start: 285, end: 295, text: 'А это — совсем другая история.' },
  ];

  const result = run(tracks, segments, TWO_SONGS);
  assert.deepEqual(result[1], { position: 2, interval: 1, confidence: 'low', evidence: 'order' });
});

test('audio with no music at all places nothing', () => {
  const intervals = [{ start: 0, end: 780, label: 'speech' }];
  const result = run(THREE_TRACKS, CASCADE, intervals);

  assert.deepEqual(
    result.map((entry) => entry.interval),
    [null, null, null],
  );
});

test('an episode with no tracks aligns to an empty list', () => {
  assert.deepEqual(alignTracks({ tracks: [], segments: CASCADE, intervals: THREE_SONGS }), []);
});

test('the same input always gives the same answer', () => {
  const first = alignTracks({ tracks: THREE_TRACKS, segments: CASCADE, intervals: THREE_SONGS });
  const second = alignTracks({ tracks: THREE_TRACKS, segments: CASCADE, intervals: THREE_SONGS });
  assert.deepEqual(second, first, 'no LLM, no clock, no randomness');
});

/** An adapter that fails the test if the step ever reaches for the LLM. */
function watchedLlm() {
  const calls = [];
  return {
    cli: 'claude',
    calls,
    async call(request) {
      calls.push(request);
      throw new Error('align must never call the llm');
    },
    stats: () => ({ cli: 'claude', steps: {} }),
    summary: () => 'llm claude: no calls',
  };
}

const PARSED_COLUMNS = {
  album: 'Dummy',
  label: 'Go! Beat',
  country: 'UK',
  format: 'LP',
  section: 'Новые пластинки',
  is_cherished: 1,
  note_desc: 'из личной коллекции',
  parse_warning: null,
};

const INSERT_TRACK = `
INSERT INTO track (
  episode_guid, position, artist, track, album, label, country, format, section,
  is_cherished, note_desc, parse_warning, intro_segment
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function seed(db, options = {}) {
  const {
    guid = GUID,
    status = 'transcribed',
    tracks = THREE_TRACKS,
    segments = CASCADE,
    intervals = THREE_SONGS,
    published = '2025-09-01T00:00:00.000Z',
  } = options;

  db.prepare(
    `INSERT INTO episode (guid, title, published_at, status, updated_at)
     VALUES (?, ?, ?, ?, '2026-01-01T00:00:00.000Z')`,
  ).run(guid, guid, published, status);

  for (const track of tracks) {
    db.prepare(INSERT_TRACK).run(
      guid,
      track.position,
      track.artist,
      track.track,
      PARSED_COLUMNS.album,
      PARSED_COLUMNS.label,
      PARSED_COLUMNS.country,
      PARSED_COLUMNS.format,
      PARSED_COLUMNS.section,
      PARSED_COLUMNS.is_cherished,
      PARSED_COLUMNS.note_desc,
      PARSED_COLUMNS.parse_warning,
      track.intro_segment,
    );
  }
  if (segments !== null) {
    db.prepare('INSERT INTO transcript (episode_guid, segments, model) VALUES (?, ?, ?)').run(
      guid,
      JSON.stringify(segments),
      'large-v3',
    );
  }
  if (intervals !== null) {
    db.prepare('INSERT INTO segmentation (episode_guid, intervals, model) VALUES (?, ?, ?)').run(
      guid,
      JSON.stringify(intervals),
      'silero-v6.2.0.bin',
    );
  }
}

function setup(t, options = {}) {
  const db = openDb(':memory:');
  t.after(() => db.close());
  const llm = watchedLlm();
  const ctx = testCtx(db, { llm, synonyms: options.synonyms ?? null });
  return { ctx, db, llm };
}

function episode(db, guid) {
  return db.prepare('SELECT * FROM episode WHERE guid = ?').get(guid);
}

function trackRows(db, guid = GUID) {
  return db.prepare('SELECT * FROM track WHERE episode_guid = ? ORDER BY position').all(guid);
}

function starts(db, guid = GUID) {
  return trackRows(db, guid).map((row) => [row.position, row.start_sec, row.start_confidence]);
}

/** The constraint the whole issue turns on, checked against what was stored. */
function assertSecondsComeFromTheAudio(db, intervals, guid = GUID) {
  const musicStarts = new Set(
    intervals.filter((interval) => interval.label === 'music').map((interval) => interval.start),
  );
  let previous = -1;
  for (const row of trackRows(db, guid)) {
    if (row.start_sec === null) {
      assert.equal(row.start_confidence, null, `position ${row.position}`);
      continue;
    }
    assert.equal(typeof row.start_sec, 'number', `position ${row.position}: numeric seconds`);
    assert.ok(musicStarts.has(row.start_sec), `${row.start_sec} is no music interval start`);
    assert.ok(row.start_sec > previous, `position ${row.position} starts after the one before`);
    previous = row.start_sec;
  }
}

test('align owns the aligned status and runs last in the chain', () => {
  assert.equal(align.name, 'align');
  assert.equal(align.target, 'aligned');
  assert.equal(registry.chain.at(-1).name, 'align');
});

test('a mention near a music boundary sets the second the song starts', async (t) => {
  const { ctx, db, llm } = setup(t);
  seed(db);

  const result = await align.run(ctx, episode(db, GUID));

  assert.deepEqual(result, { tracks: 3, high: 2, medium: 0, low: 1, unplaced: 0, intro: 0 });
  assert.deepEqual(starts(db), [
    [1, 60, 'high'],
    [2, 300, 'low'],
    [3, 540, 'high'],
  ]);
  assertSecondsComeFromTheAudio(db, THREE_SONGS);
  assert.deepEqual(llm.calls, [], 'this step is deterministic: no model is asked anything');
});

test('the log lists every track at the second it was placed', async (t) => {
  const { ctx, db } = setup(t);
  seed(db);

  await align.run(ctx, episode(db, GUID));

  const line = ctx.lines.at(-1);
  assert.ok(line.startsWith(`${GUID}: align 3 tracks`), line);
  assert.match(line, /intro fallback 0/, 'how often the fallback fires is logged');
  assert.match(line, /1@0:01:00 high/);
  assert.match(line, /2@0:05:00 low/);
  assert.match(line, /3@0:09:00 high/);
});

test('a start preserves the exact music interval boundary', async (t) => {
  const { ctx, db } = setup(t);
  const tracks = [trackOf(1, 'Аквариум', 'Стаканы'), trackOf(2, 'Пикник', 'Иероглиф', 1)];
  const segments = [
    { start: 50, end: 58, text: 'Сейчас — Аквариум.' },
    { start: 285, end: 295, text: 'А это — совсем другая история.' },
  ];
  seed(db, { tracks, segments, intervals: TWO_SONGS });

  const result = await align.run(ctx, episode(db, GUID));

  assert.deepEqual(starts(db), [
    [1, 60.4, 'high'],
    [2, 300.75, 'medium'],
  ]);
  assert.equal(result.intro, 1, 'the intro_segment fallback is counted');
  assert.match(ctx.lines.at(-1), /intro fallback 1/);
  assertSecondsComeFromTheAudio(db, TWO_SONGS);
});

test('an alias from synonyms.yaml turns a cyrillic mention into a high-confidence start', async (t) => {
  const tracks = [trackOf(1, 'The Beatles', 'Help!')];
  const segments = [{ start: 50, end: 58, text: 'А сейчас — «Битлз».' }];
  const intervals = TWO_SONGS.slice(0, 2);

  const plain = setup(t);
  seed(plain.db, { tracks, segments, intervals });
  await align.run(plain.ctx, episode(plain.db, GUID));
  const before = trackRows(plain.db)[0];
  assert.notEqual(before.start_confidence, 'high', 'nothing transliterates Beatles into Битлз');

  const aliased = setup(t, { synonyms: parseSynonyms('The Beatles: [Битлз]') });
  seed(aliased.db, { tracks, segments, intervals });
  await align.run(aliased.ctx, episode(aliased.db, GUID));

  assert.deepEqual(starts(aliased.db), [[1, 60.4, 'high']]);
});

test('a missing segmentation names the step that produces it and writes nothing', async (t) => {
  const { ctx, db } = setup(t);
  seed(db, { intervals: null });

  await assert.rejects(
    () => align.run(ctx, episode(db, GUID)),
    (err) => {
      assert.match(err.message, new RegExp(`no segmentation for ${GUID}`));
      assert.match(err.message, /--step segment/);
      return true;
    },
  );
  assert.deepEqual(starts(db), [
    [1, null, null],
    [2, null, null],
    [3, null, null],
  ]);
});

test('a missing transcript names the step that produces it and writes nothing', async (t) => {
  const { ctx, db } = setup(t);
  seed(db, { segments: null });

  await assert.rejects(
    () => align.run(ctx, episode(db, GUID)),
    (err) => {
      assert.match(err.message, new RegExp(`no transcript for ${GUID}`));
      assert.match(err.message, /--step transcribe/);
      return true;
    },
  );
  assert.deepEqual(starts(db), [
    [1, null, null],
    [2, null, null],
    [3, null, null],
  ]);
});

test('an episode with no tracks is not an error', async (t) => {
  const { ctx, db } = setup(t);
  seed(db, { tracks: [] });

  const result = await align.run(ctx, episode(db, GUID));

  assert.equal(result.tracks, 0);
  assert.deepEqual(trackRows(db), []);
});

test('a second run changes nothing, a third one after new audio rewrites everything', async (t) => {
  const { ctx, db } = setup(t);
  seed(db);

  await align.run(ctx, episode(db, GUID));
  const first = trackRows(db);
  await align.run(ctx, episode(db, GUID));
  assert.deepEqual(trackRows(db), first, 're-running on the same episode is a no-op');

  // The transcript loses every mention and the audio loses a song: two tracks
  // too many for the songs that are left, and nothing to place them by.
  db.prepare('UPDATE transcript SET segments = ? WHERE episode_guid = ?').run(
    JSON.stringify(NO_NAMES),
    GUID,
  );
  db.prepare('UPDATE segmentation SET intervals = ? WHERE episode_guid = ?').run(
    JSON.stringify(TWO_SONGS),
    GUID,
  );

  const result = await align.run(ctx, episode(db, GUID));

  assert.equal(result.unplaced, 3);
  assert.deepEqual(
    starts(db),
    [
      [1, null, null],
      [2, null, null],
      [3, null, null],
    ],
    'a track that lost its evidence goes back to null instead of keeping a stale second',
  );
  assert.equal(trackRows(db).length, 3, 'rows are rewritten, never accumulated');
});

test('the step writes its own two columns and no others', async (t) => {
  const { ctx, db } = setup(t);
  seed(db);

  const strip = (rows) =>
    rows.map((row) => {
      const copy = { ...row };
      delete copy.start_sec;
      delete copy.start_confidence;
      return copy;
    });
  const before = strip(trackRows(db));

  await align.run(ctx, episode(db, GUID));

  assert.deepEqual(strip(trackRows(db)), before, 'align owns start_sec and start_confidence only');
});

test('the pipeline advances the episode to aligned and isolates a failing one', async (t) => {
  const { ctx, db } = setup(t);
  seed(db);
  seed(db, { guid: OTHER, intervals: null, published: '2025-08-01T00:00:00.000Z' });

  const result = await runPipeline(ctx, { before: [], chain: [align], after: [] });

  assert.equal(result.failures, 1);
  assert.equal(episode(db, GUID).status, 'aligned');
  assert.equal(episode(db, GUID).failed_step, null);

  const failed = episode(db, OTHER);
  assert.equal(failed.status, 'transcribed', 'the status stays at the last good state');
  assert.equal(failed.failed_step, 'align');
  assert.match(failed.error, /no segmentation/);
  assert.deepEqual(starts(db, OTHER), [
    [1, null, null],
    [2, null, null],
    [3, null, null],
  ]);
});
