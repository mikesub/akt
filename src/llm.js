import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageError } from './errors.js';
import { validate } from './jsonschema.js';

/**
 * The one place in the codebase that spawns an LLM process.
 *
 * Both supported CLIs are the same shape — one prompt in, one message out —
 * so a single adapter drives either: the caller hands over a prompt and a
 * JSON Schema and gets back a parsed, schema-valid value or a typed error.
 *
 * The child runs in a fresh empty temp directory with its tools switched
 * off, so it cannot pick up this repo's AGENTS.md or read any file the
 * prompt mentions. Driving a CLI means no server-side schema enforcement,
 * which is why validate-and-retry lives here rather than in every caller.
 * An auth failure is a type of its own because an expired login would
 * otherwise fail every episode of a nightly run separately, with the same
 * opaque message: the first one latches the adapter for the rest of the run.
 */

const DEFAULT_TIMEOUT_SEC = 120;
const MAX_ATTEMPTS = 3;

/** The sandbox each CLI spells its own way. The prompt is always last. */
const ARGV = {
  claude: [
    '-p',
    '--output-format',
    'json',
    '--tools',
    '',
    '--strict-mcp-config',
    '--no-session-persistence',
  ],
  codex: [
    'exec',
    '--sandbox',
    'read-only',
    '--ask-for-approval',
    'never',
    '--skip-git-repo-check',
    '--ephemeral',
    '--color',
    'never',
    '-c',
    'features.shell_tool=false',
  ],
};

export const LLM_CLIS = Object.keys(ARGV);

/**
 * What the CLIs say when the login is the problem, rather than the model, the
 * prompt or the network. Matched against stdout and stderr together.
 */
const AUTH_SIGNS = [
  'not logged in',
  'please run /login',
  'invalid api key',
  'authentication',
  'unauthorized',
  '\\b401\\b',
  'token.*expired',
  'expired.*token',
  'login required',
  'codex login',
];

const AUTH_FAILURE = new RegExp(AUTH_SIGNS.join('|'), 'i');

const SCHEMA_INSTRUCTION =
  'Reply with a single JSON document and nothing else: no prose, no code fences. ' +
  'It must validate against this JSON Schema:';

/** One surrounding fence, which the CLIs add even when told not to. */
const FENCE = /^```[a-z]*\n([\s\S]*?)\n?```$/i;

/** Base for every adapter failure: which CLI, and what it printed. */
export class LlmError extends Error {
  constructor(message, { cli = null, stdout = '', stderr = '', exitCode = null } = {}) {
    super(message);
    this.name = 'LlmError';
    this.cli = cli;
    this.stdout = stdout;
    this.stderr = stderr;
    this.exitCode = exitCode;
  }
}

/** No CLI on PATH, no session, or an expired token. Aborts the run's LLM steps. */
export class LlmAuthError extends LlmError {
  constructor(message, details) {
    super(message, details);
    this.name = 'LlmAuthError';
  }
}

/** Three replies that would not validate. `raw` is the last one, verbatim. */
export class LlmValidationError extends LlmError {
  constructor(message, details) {
    super(message, details);
    this.name = 'LlmValidationError';
    this.attempts = details.attempts;
    this.errors = details.errors;
    this.raw = details.raw;
  }
}

/**
 * The final message. `claude --output-format json` wraps it in an envelope;
 * `codex exec` prints it bare. A reply that is itself a JSON document is left
 * alone, because only an envelope has `type: "result"`.
 */
function unwrap(stdout) {
  const text = stdout.trim();
  if (!text.startsWith('{')) return { text, isError: false };
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    return { text, isError: false };
  }
  if (envelope === null || typeof envelope !== 'object' || envelope.type !== 'result') {
    return { text, isError: false };
  }
  return { text: String(envelope.result ?? ''), isError: envelope.is_error === true };
}

/** The JSON document inside a reply, fence and chatter stripped. */
function extract(text) {
  const fenced = text.trim().match(FENCE);
  const body = fenced === null ? text.trim() : fenced[1].trim();
  const start = body.search(/[{[]/);
  const end = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'));
  if (start === -1 || end < start) {
    return { ok: false, error: 'the reply contained no JSON document' };
  }
  try {
    return { ok: true, value: JSON.parse(body.slice(start, end + 1)) };
  } catch (err) {
    return { ok: false, error: `the reply was not valid JSON: ${err.message}` };
  }
}

/** The same prompt again, with what was wrong with the last reply. */
function retryPrompt(base, complaints) {
  const listed = complaints.map((complaint) => `- ${complaint}`).join('\n');
  const rejection = `Your previous reply was rejected:\n${listed}`;
  return `${base}\n\n${rejection}\nReply again with a JSON document that satisfies the schema.`;
}

/** The CLI never started: a missing binary is an auth problem, not a model one. */
function startupFailure(cli, err) {
  if (err?.code === 'ENOENT') {
    return new LlmAuthError(`${cli} is not on PATH: install it and log in`, { cli });
  }
  return new LlmError(`${cli} could not be started: ${err?.message ?? err}`, { cli });
}

/** A non-zero exit or an is_error envelope: the login, or the model? */
function replyFailure(cli, stdout, stderr, exitCode, detail) {
  const details = { cli, stdout, stderr, exitCode };
  if (AUTH_FAILURE.test(`${stdout}\n${stderr}`)) {
    return new LlmAuthError(`${cli} could not authenticate: ${detail}`, details);
  }
  return new LlmError(`${cli} failed with exit code ${exitCode}: ${detail}`, details);
}

/** Run the CLI once. Resolves for any exit status, rejects only if it never ran. */
function runCli(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ stdout, stderr, code, signal }));
  });
}

export function createLlm({
  cli = 'claude',
  timeoutMs = DEFAULT_TIMEOUT_SEC * 1000,
  env = process.env,
  log = () => {},
} = {}) {
  const tallies = new Map();
  let latched = null;

  function tally(step, outcome) {
    const counts = tallies.get(step) ?? { calls: 0, ok: 0, failed: 0, skipped: 0 };
    counts.calls++;
    if (outcome === 'ok') counts.ok++;
    else if (outcome === 'skipped') counts.skipped++;
    else counts.failed++;
    tallies.set(step, counts);
  }

  /** One line per call, never one per attempt. */
  function record(step, guid, outcome, attempts, startedAt) {
    tally(step, outcome);
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    const plural = attempts === 1 ? 'attempt' : 'attempts';
    log(`${guid}: llm ${step} ${cli} ${outcome} (${attempts} ${plural}, ${seconds}s)`);
  }

  function recordFailure(step, guid, attempt, startedAt, failure) {
    const outcome = failure instanceof LlmAuthError ? 'auth' : 'error';
    if (failure instanceof LlmAuthError) latched = failure;
    record(step, guid, outcome, attempt, startedAt);
    return failure;
  }

  async function call({ step, guid, prompt, schema }) {
    const startedAt = Date.now();
    if (latched !== null) {
      record(step, guid, 'skipped', 0, startedAt);
      const why = `${cli} is disabled for the rest of this run: ${latched.message}`;
      throw new LlmAuthError(why, { cli });
    }

    const base = `${prompt}\n\n${SCHEMA_INSTRUCTION}\n${JSON.stringify(schema, null, 2)}`;
    let complaints = [];
    let raw = '';

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const text = attempt === 1 ? base : retryPrompt(base, complaints);
      // A directory of its own per attempt, so the child can only ever see
      // an empty one and nothing survives the call.
      const dir = mkdtempSync(join(tmpdir(), 'akt-llm-'));
      let finished;
      try {
        finished = await runCli(cli, [...ARGV[cli], text], {
          cwd: dir,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: timeoutMs,
          killSignal: 'SIGKILL',
        });
      } catch (err) {
        throw recordFailure(step, guid, attempt, startedAt, startupFailure(cli, err));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }

      const { stdout, stderr, code, signal } = finished;
      raw = stdout;

      if (signal !== null) {
        record(step, guid, 'timeout', attempt, startedAt);
        const seconds = Math.round(timeoutMs / 1000);
        throw new LlmError(`${cli} timed out after ${seconds}s`, {
          cli,
          stdout,
          stderr,
          exitCode: null,
        });
      }

      const reply = unwrap(stdout);
      if (code !== 0 || reply.isError) {
        const detail = `${reply.text}\n${stderr}`.trim();
        const failure = replyFailure(cli, stdout, stderr, code, detail);
        throw recordFailure(step, guid, attempt, startedAt, failure);
      }

      const payload = extract(reply.text);
      if (!payload.ok) {
        complaints = [payload.error];
        continue;
      }
      complaints = validate(schema, payload.value);
      if (complaints.length === 0) {
        record(step, guid, 'ok', attempt, startedAt);
        return payload.value;
      }
    }

    record(step, guid, 'invalid', MAX_ATTEMPTS, startedAt);
    const gave = `${cli} gave no schema-valid reply in ${MAX_ATTEMPTS} attempts`;
    const why = `${gave}: ${complaints.join('; ')}\n${raw}`;
    throw new LlmValidationError(why, {
      cli,
      stdout: raw,
      attempts: MAX_ATTEMPTS,
      errors: complaints,
      raw,
    });
  }

  function stats() {
    const steps = {};
    for (const [step, counts] of tallies) steps[step] = { ...counts };
    return { cli, steps };
  }

  /** The per-run signal for whether the deterministic parser is drifting. */
  function summary() {
    if (tallies.size === 0) return `llm ${cli}: no calls`;
    const parts = [];
    for (const [step, counts] of tallies) {
      const outcomes = `ok ${counts.ok}, failed ${counts.failed}, skipped ${counts.skipped}`;
      parts.push(`${step} fired ${counts.calls} times (${outcomes})`);
    }
    return `llm ${cli}: ${parts.join('; ')}`;
  }

  return { cli, call, stats, summary };
}

/**
 * Build the adapter from the environment. A bad value is a usage error, so a
 * typo in `.env` exits 2 with the usage text instead of failing every episode
 * of the run one at a time.
 */
export function llmFromEnv(env = process.env, log) {
  const cli = env.LLM_CLI ?? 'claude';
  if (!LLM_CLIS.includes(cli)) {
    throw new UsageError(`LLM_CLI must be one of ${LLM_CLIS.join(', ')}, got: ${cli}`);
  }

  const timeout = env.LLM_TIMEOUT ?? String(DEFAULT_TIMEOUT_SEC);
  const seconds = Number(timeout);
  if (!Number.isInteger(seconds) || seconds < 1) {
    throw new UsageError(`LLM_TIMEOUT must be a whole number of seconds, got: ${timeout}`);
  }

  return createLlm({ cli, timeoutMs: seconds * 1000, env, log });
}
