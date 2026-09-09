/** Bad invocation: wrong flag, unknown command, unknown step. Exits 2. */
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}
