import { rank } from '../status.js';
import { align } from './align.js';
import { download } from './download.js';
import { ingest } from './ingest.js';
import { parse } from './parse.js';
import { prune } from './prune.js';
import { segment } from './segment.js';
import { transcribe } from './transcribe.js';

export { maxStatus, rank, STATUSES } from '../status.js';

/**
 * Steps come in three kinds:
 *   before — run-level, once, ahead of the episode loop (ingest)
 *   chain  — per-episode, in order, each owning one status
 *   after  — run-level, once, over the whole database (prune, export, publish)
 *
 * The chain has a hole where `extracted` belongs: the step that owns that
 * status is not written yet, so `align` follows `transcribe` directly. A step
 * is skipped once an episode has passed its status, so every episode aligned
 * before that step lands will skip it for good unless the archive is walked
 * once with `--step extract`. The README says so where it can be acted on;
 * `validateRegistry` deliberately checks only that targets increase, because
 * the alternative — a placeholder step that advances episodes to `extracted`
 * without extracting anything — would make them skip the real step just the
 * same, while hiding the fact that it is owed.
 */
export const registry = {
  before: [ingest],
  chain: [parse, download, segment, transcribe, align],
  after: [prune],
};

export function findStep(name) {
  for (const kind of ['before', 'chain', 'after']) {
    const step = registry[kind].find((s) => s.name === name);
    if (step) return step;
  }
  return null;
}

/** Guard the registry's invariants at load time so a bad step fails loudly. */
export function validateRegistry(reg = registry) {
  let previous = -1;
  for (const step of reg.chain) {
    if (!step.target) throw new Error(`chain step ${step.name} has no target status`);
    const target = rank(step.target);
    if (target <= previous) {
      throw new Error(`chain step ${step.name} targets ${step.target} out of order`);
    }
    previous = target;
  }
  for (const kind of ['before', 'after']) {
    for (const step of reg[kind]) {
      if (step.target) throw new Error(`run-level step ${step.name} must not declare a target`);
    }
  }
  return reg;
}

validateRegistry();
