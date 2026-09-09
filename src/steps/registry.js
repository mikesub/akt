import { ingest } from './ingest.js';
import { parse } from './parse.js';

/**
 * The linear status chain. Every per-episode step owns exactly one state and
 * advances the episode to it. There is no `failed` status: a step that throws
 * leaves the status alone and records `error` + `failed_step`.
 */
export const STATUSES = [
  'new',
  'parsed',
  'downloaded',
  'segmented',
  'transcribed',
  'extracted',
  'aligned',
  'genred',
  'linked',
  'published',
  'notified',
];

export function rank(status) {
  const index = STATUSES.indexOf(status);
  if (index === -1) throw new Error(`unknown status: ${status}`);
  return index;
}

/** The later of two statuses. Used so `--step` never regresses an episode. */
export function maxStatus(a, b) {
  return rank(a) >= rank(b) ? a : b;
}

/**
 * Steps come in three kinds:
 *   before — run-level, once, ahead of the episode loop (ingest)
 *   chain  — per-episode, in order, each owning one status
 *   after  — run-level, once, over the whole database (export, publish)
 */
export const registry = {
  before: [ingest],
  chain: [parse],
  after: [],
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
