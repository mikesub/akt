import { rank } from '../status.js';
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
 */
export const registry = {
  before: [ingest],
  chain: [parse, download, segment, transcribe],
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
