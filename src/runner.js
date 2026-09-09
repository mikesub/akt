import { SetupError, UsageError } from './errors.js';
import { maxStatus, rank } from './steps/registry.js';

const SELECT_PENDING = `
SELECT * FROM episode WHERE status != 'notified'
ORDER BY published_at DESC, guid ASC LIMIT ?`;

const SELECT_ALL = 'SELECT * FROM episode ORDER BY published_at DESC, guid ASC LIMIT ?';

const SELECT_ONE = 'SELECT * FROM episode WHERE guid = ?';

const ADVANCE = `
UPDATE episode SET status = ?, error = NULL, failed_step = NULL, updated_at = ?
WHERE guid = ?`;

const RECORD_FAILURE =
  'UPDATE episode SET error = ?, failed_step = ?, updated_at = ? WHERE guid = ?';

/** Find a step by name in the registry actually being run. */
function lookup(reg, name) {
  for (const kind of ['before', 'chain', 'after']) {
    const step = reg[kind].find((candidate) => candidate.name === name);
    if (step) return step;
  }
  return null;
}

function selectEpisodes(ctx, { episode, limit, all }) {
  if (episode) {
    const row = ctx.db.prepare(SELECT_ONE).get(episode);
    if (!row) throw new Error(`unknown episode: ${episode}`);
    return [row];
  }
  return ctx.db.prepare(all ? SELECT_ALL : SELECT_PENDING).all(limit ?? -1);
}

function recordFailure(ctx, row, stepName, err) {
  ctx.db.prepare(RECORD_FAILURE).run(String(err?.stack ?? err), stepName, ctx.now(), row.guid);
  ctx.log(`${row.guid}: ${stepName} failed: ${err?.message ?? err}`);
}

async function runLevelStep(ctx, step) {
  try {
    await step.run(ctx);
    return 0;
  } catch (err) {
    if (err instanceof SetupError) throw err;
    ctx.log(`${step.name} failed: ${err?.message ?? err}`);
    return 1;
  }
}

/**
 * Walk the chain for one episode, as far as it can go. A step is a no-op when
 * the episode is already at or past its target status. A throwing step leaves
 * `status` where it was, records `error` + `failed_step`, and ends this
 * episode — never the run. The one exception is a `SetupError`: a missing
 * prerequisite of the box is nobody's episode, and every remaining one would
 * fail the same way, so it propagates out of the run unrecorded.
 */
async function runChain(ctx, chain, row) {
  for (const step of chain) {
    if (rank(row.status) >= rank(step.target)) continue;
    try {
      await step.run(ctx, row);
    } catch (err) {
      if (err instanceof SetupError) throw err;
      recordFailure(ctx, row, step.name, err);
      return 1;
    }
    ctx.db.prepare(ADVANCE).run(step.target, ctx.now(), row.guid);
    row.status = step.target;
  }
  return 0;
}

/** Force one step to run regardless of status; never regress the episode. */
async function runForcedStep(ctx, step, row) {
  try {
    await step.run(ctx, row);
  } catch (err) {
    if (err instanceof SetupError) throw err;
    recordFailure(ctx, row, step.name, err);
    return 1;
  }
  ctx.db.prepare(ADVANCE).run(maxStatus(row.status, step.target), ctx.now(), row.guid);
  return 0;
}

/**
 * One pipeline invocation: run-level `before` steps, then episodes
 * newest-first, then run-level `after` steps.
 */
export async function runPipeline(ctx, reg, options = {}) {
  const { episode = null, step = null, limit = null } = options;
  let failures = 0;

  if (step) {
    const found = lookup(reg, step);
    if (!found) throw new UsageError(`unknown step: ${step}`);
    if (!found.target) {
      if (episode)
        throw new UsageError(`--step ${step} is a run-level step and takes no --episode`);
      failures += await runLevelStep(ctx, found);
      return { selected: 0, failures };
    }
    const rows = selectEpisodes(ctx, { episode, limit, all: true });
    for (const row of rows) failures += await runForcedStep(ctx, found, row);
    return { selected: rows.length, failures };
  }

  for (const before of reg.before) failures += await runLevelStep(ctx, before);

  const rows = selectEpisodes(ctx, { episode, limit, all: false });
  for (const row of rows) failures += await runChain(ctx, reg.chain, row);

  for (const after of reg.after) failures += await runLevelStep(ctx, after);

  return { selected: rows.length, failures };
}
