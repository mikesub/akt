import assert from 'node:assert/strict';
import test from 'node:test';
import { openDb } from '../src/db.js';
import { UsageError } from '../src/errors.js';
import { runPipeline } from '../src/runner.js';
import { testCtx } from './helpers.js';

/** A step that records the episodes it saw, and optionally throws on some. */
function stubStep(name, target, { throwsOn = [] } = {}) {
  const seen = [];
  return {
    name,
    target,
    seen,
    run(_ctx, episode) {
      const guid = episode?.guid ?? null;
      seen.push(guid);
      if (throwsOn.includes(guid)) throw new Error(`${name} exploded on ${guid}`);
    },
  };
}

function fakeRegistry({ before = [], chain = [], after = [] } = {}) {
  return { before, chain, after };
}

function seed(db, rows) {
  for (const row of rows) {
    db.prepare(
      "INSERT INTO episode (guid, title, published_at, status, updated_at) VALUES (?, ?, ?, ?, '2026-01-01T00:00:00.000Z')",
    ).run(row.guid, row.title ?? row.guid, row.published_at, row.status ?? 'new');
  }
}

function setup(t, rows) {
  const db = openDb(':memory:');
  t.after(() => db.close());
  seed(db, rows);
  return testCtx(db, {});
}

function status(db, guid) {
  return db.prepare('SELECT * FROM episode WHERE guid = ?').get(guid);
}

test('chain steps run in order and are skipped once their status is reached', async (t) => {
  const ctx = setup(t, [
    { guid: 'a', published_at: '2025-09-01T00:00:00.000Z', status: 'downloaded' },
  ]);
  const parse = stubStep('parse', 'parsed');
  const download = stubStep('download', 'downloaded');
  const segment = stubStep('segment', 'segmented');

  const result = await runPipeline(ctx, fakeRegistry({ chain: [parse, download, segment] }));

  assert.deepEqual(result, { selected: 1, failures: 0 });
  assert.deepEqual(parse.seen, []);
  assert.deepEqual(download.seen, []);
  assert.deepEqual(segment.seen, ['a']);
  assert.equal(status(ctx.db, 'a').status, 'segmented');
});

test('a throwing step isolates the failure to its episode', async (t) => {
  const ctx = setup(t, [
    { guid: 'a', published_at: '2025-09-01T00:00:00.000Z' },
    { guid: 'b', published_at: '2025-08-01T00:00:00.000Z' },
  ]);
  const parse = stubStep('parse', 'parsed', { throwsOn: ['a'] });
  const download = stubStep('download', 'downloaded');

  const result = await runPipeline(ctx, fakeRegistry({ chain: [parse, download] }));

  assert.equal(result.failures, 1);
  const a = status(ctx.db, 'a');
  assert.equal(a.status, 'new', 'status stays at the last good state; there is no failed status');
  assert.equal(a.failed_step, 'parse');
  assert.match(a.error, /parse exploded on a/);

  const b = status(ctx.db, 'b');
  assert.equal(b.status, 'downloaded');
  assert.equal(b.error, null);
  assert.equal(b.failed_step, null);
  assert.deepEqual(download.seen, ['b'], 'the rest of a failed episode chain is not run');
});

test('a later success clears error and failed_step', async (t) => {
  const ctx = setup(t, [{ guid: 'a', published_at: '2025-09-01T00:00:00.000Z' }]);
  ctx.db.prepare("UPDATE episode SET error = 'boom', failed_step = 'parse' WHERE guid = 'a'").run();

  await runPipeline(ctx, fakeRegistry({ chain: [stubStep('parse', 'parsed')] }));

  const a = status(ctx.db, 'a');
  assert.equal(a.status, 'parsed');
  assert.equal(a.error, null);
  assert.equal(a.failed_step, null);
});

test('episodes are processed newest-first and --limit caps the invocation', async (t) => {
  const ctx = setup(t, [
    { guid: 'old', published_at: '2025-01-01T00:00:00.000Z' },
    { guid: 'newest', published_at: '2025-09-01T00:00:00.000Z' },
    { guid: 'middle', published_at: '2025-05-01T00:00:00.000Z' },
  ]);
  const parse = stubStep('parse', 'parsed');

  const result = await runPipeline(ctx, fakeRegistry({ chain: [parse] }), { limit: 2 });

  assert.equal(result.selected, 2);
  assert.deepEqual(parse.seen, ['newest', 'middle']);
});

test('notified episodes are not selected', async (t) => {
  const ctx = setup(t, [
    { guid: 'done', published_at: '2025-09-01T00:00:00.000Z', status: 'notified' },
    { guid: 'todo', published_at: '2025-08-01T00:00:00.000Z' },
  ]);
  const parse = stubStep('parse', 'parsed');

  await runPipeline(ctx, fakeRegistry({ chain: [parse] }));

  assert.deepEqual(parse.seen, ['todo']);
});

test('--episode restricts the run to one guid', async (t) => {
  const ctx = setup(t, [
    { guid: 'a', published_at: '2025-09-01T00:00:00.000Z' },
    { guid: 'b', published_at: '2025-08-01T00:00:00.000Z' },
  ]);
  const parse = stubStep('parse', 'parsed');

  await runPipeline(ctx, fakeRegistry({ chain: [parse] }), { episode: 'b' });

  assert.deepEqual(parse.seen, ['b']);
});

test('--episode with an unknown guid throws', async (t) => {
  const ctx = setup(t, []);
  await assert.rejects(
    () =>
      runPipeline(ctx, fakeRegistry({ chain: [stubStep('parse', 'parsed')] }), { episode: 'nope' }),
    /unknown episode: nope/,
  );
});

test('run-level steps run once, before and after the episode loop', async (t) => {
  const ctx = setup(t, [{ guid: 'a', published_at: '2025-09-01T00:00:00.000Z' }]);
  const order = [];
  const ingest = { name: 'ingest', run: () => order.push('ingest') };
  const parse = { name: 'parse', target: 'parsed', run: () => order.push('parse') };
  const exportStep = { name: 'export', run: () => order.push('export') };

  await runPipeline(ctx, fakeRegistry({ before: [ingest], chain: [parse], after: [exportStep] }));

  assert.deepEqual(order, ['ingest', 'parse', 'export']);
});

test('a failing before step is counted but does not abort the run', async (t) => {
  const ctx = setup(t, [{ guid: 'a', published_at: '2025-09-01T00:00:00.000Z' }]);
  const ingest = {
    name: 'ingest',
    run: () => {
      throw new Error('feed unreachable');
    },
  };
  const parse = stubStep('parse', 'parsed');

  const result = await runPipeline(ctx, fakeRegistry({ before: [ingest], chain: [parse] }));

  assert.equal(result.failures, 1);
  assert.deepEqual(parse.seen, ['a']);
  assert.match(ctx.lines.join('\n'), /ingest failed: feed unreachable/);
});

test('--step runs regardless of status and raises status to the target', async (t) => {
  const ctx = setup(t, [{ guid: 'a', published_at: '2025-09-01T00:00:00.000Z', status: 'new' }]);
  const segment = stubStep('segment', 'segmented');

  await runPipeline(ctx, fakeRegistry({ chain: [segment] }), { step: 'segment' });

  assert.deepEqual(segment.seen, ['a']);
  assert.equal(status(ctx.db, 'a').status, 'segmented');
});

test('--step never regresses an episode that is further along', async (t) => {
  const ctx = setup(t, [{ guid: 'a', published_at: '2025-09-01T00:00:00.000Z', status: 'linked' }]);
  const parse = stubStep('parse', 'parsed');

  await runPipeline(ctx, fakeRegistry({ chain: [parse] }), { step: 'parse' });

  assert.deepEqual(parse.seen, ['a'], 'the step still runs');
  assert.equal(status(ctx.db, 'a').status, 'linked');
});

test('--step selects notified episodes too', async (t) => {
  const ctx = setup(t, [
    { guid: 'a', published_at: '2025-09-01T00:00:00.000Z', status: 'notified' },
  ]);
  const parse = stubStep('parse', 'parsed');

  await runPipeline(ctx, fakeRegistry({ chain: [parse] }), { step: 'parse' });

  assert.deepEqual(parse.seen, ['a']);
  assert.equal(status(ctx.db, 'a').status, 'notified');
});

test('--step on a run-level step runs it once and rejects --episode', async (t) => {
  const ctx = setup(t, [{ guid: 'a', published_at: '2025-09-01T00:00:00.000Z' }]);
  const ingest = stubStep('ingest', undefined);
  const registry = fakeRegistry({ before: [ingest], chain: [stubStep('parse', 'parsed')] });

  const result = await runPipeline(ctx, registry, { step: 'ingest' });
  assert.deepEqual(result, { selected: 0, failures: 0 });
  assert.deepEqual(ingest.seen, [null]);

  await assert.rejects(
    () => runPipeline(ctx, registry, { step: 'ingest', episode: 'a' }),
    (err) => err instanceof UsageError,
  );
});

test('an unknown --step is a usage error', async (t) => {
  const ctx = setup(t, []);
  await assert.rejects(
    () => runPipeline(ctx, fakeRegistry({}), { step: 'nope' }),
    (err) => err instanceof UsageError && /unknown step: nope/.test(err.message),
  );
});

test('a failure under --step is recorded without changing status', async (t) => {
  const ctx = setup(t, [{ guid: 'a', published_at: '2025-09-01T00:00:00.000Z', status: 'parsed' }]);
  const segment = stubStep('segment', 'segmented', { throwsOn: ['a'] });

  const result = await runPipeline(ctx, fakeRegistry({ chain: [segment] }), { step: 'segment' });

  assert.equal(result.failures, 1);
  const a = status(ctx.db, 'a');
  assert.equal(a.status, 'parsed');
  assert.equal(a.failed_step, 'segment');
});
