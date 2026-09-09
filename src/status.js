/**
 * The linear status chain. Every per-episode step owns exactly one state and
 * advances the episode to it. There is no `failed` status: a step that throws
 * leaves the status alone and records `error` + `failed_step`.
 *
 * This lives apart from the registry so run-level steps can reason about
 * statuses without importing the registry that imports them.
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
