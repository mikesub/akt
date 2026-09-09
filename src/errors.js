/** Bad invocation: wrong flag, unknown command, unknown step. Exits 2. */
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

/**
 * A prerequisite of the box is missing — no ffmpeg, no whisper-cli. Never the
 * fault of one episode, so it is never recorded on one: it aborts the run and
 * exits 2 with the message alone, because every remaining episode would fail
 * the same way for the same reason.
 */
export class SetupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SetupError';
  }
}
