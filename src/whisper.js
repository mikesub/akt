import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { SetupError, UsageError } from './errors.js';
import { requireVadModel, vadArgs } from './vad.js';

/**
 * The one place in the codebase that spawns whisper.cpp.
 *
 * Whisper over music hallucinates lyrics and costs five times the CPU for
 * nothing downstream uses, so the binary is always driven with its own VAD:
 * `--vad` makes it transcribe speech intervals only and map the timestamps
 * back to episode time itself, which is why the stored seconds are episode
 * seconds and not offsets into a cut. `segment` and `transcribe` receive the
 * same VAD config from `vad.js`, so there is one model path and one spelling
 * of the threshold flags.
 *
 * One configured model, no automatic fallback: a fallback would spend the
 * whole budget before starting over with a smaller model, on every slow
 * episode. The weights are a documented prerequisite of the box — a nightly
 * cron run must never decide to fetch three gigabytes — so a missing file is
 * an error naming the exact download command.
 */

export const DEFAULT_WHISPER_CLI = 'whisper-cli';
export const DEFAULT_WHISPER_MODEL = 'large-v3';
export const DEFAULT_MODEL_DIR = './models';
export const DEFAULT_TIMEOUT_SEC = 3600;

/** A ggml model name, as it appears in `ggml-<name>.bin`. */
const MODEL_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

/** Enough of a failing run's complaint to act on, without the whole log. */
const STDERR_TAIL = 800;

/** Where the transcription weight file lives. The pipeline never downloads it. */
export function modelFiles(whisper) {
  return {
    model: join(whisper.modelDir, `ggml-${whisper.model}.bin`),
  };
}

function requireModelFile(path, command) {
  if (existsSync(path)) return;
  const how = `run \`sh ./models/${command}\` in the whisper.cpp checkout`;
  throw new Error(`no model at ${path}: ${how}`);
}

function requireWhisperCli(whisper) {
  const candidates = whisper.bin.includes('/')
    ? [whisper.bin]
    : String(whisper.env.PATH ?? process.env.PATH ?? '')
        .split(delimiter)
        .filter(Boolean)
        .map((dir) => join(dir, whisper.bin));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return;
    } catch {
      // Keep looking through PATH.
    }
  }
  const where = `WHISPER_CLI=${whisper.bin}`;
  throw new SetupError(`whisper-cli not found (${where}): build whisper.cpp, see README`);
}

/**
 * The segments of a `-oj` document, in emitted order. Whisper writes one
 * entry per utterance with `offsets` in milliseconds; empty entries (a pause
 * the model still emitted a line for) are dropped rather than stored.
 */
export function parseWhisperJson(output) {
  let doc;
  try {
    doc = JSON.parse(output);
  } catch (err) {
    throw new Error(`whisper-cli JSON could not be parsed: ${err.message}`);
  }
  const entries = doc?.transcription;
  if (!Array.isArray(entries)) {
    throw new Error('whisper-cli JSON has no transcription array');
  }

  const segments = [];
  for (const entry of entries) {
    const from = entry?.offsets?.from;
    const to = entry?.offsets?.to;
    const spoken = entry?.text;
    if (!Number.isInteger(from) || !Number.isInteger(to) || typeof spoken !== 'string') {
      throw new Error(`whisper-cli JSON has a malformed segment: ${JSON.stringify(entry)}`);
    }
    const text = spoken.trim();
    if (text === '') continue;
    segments.push({ start: from / 1000, end: to / 1000, text });
  }
  return segments;
}

/**
 * Run the binary once. Resolves for any exit status, rejects if it never ran.
 * How long it took is part of the result: it is the only thing that tells a
 * timeout apart from another signal death.
 */
function runWhisper(whisper, args, cwd) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(whisper.bin, args, {
      cwd,
      env: whisper.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: whisper.timeoutMs,
      killSignal: 'SIGKILL',
    });
    let stdout = '';
    let stderr = '';
    let spawnError = null;
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    // Wait for `close` even after a spawn error: it is emitted only after the
    // synthetic stdio pipes have closed, so the CLI cannot retain them after
    // reporting a missing binary.
    child.on('error', (err) => {
      spawnError = err;
    });
    child.on('close', (code, signal) => {
      if (spawnError) reject(spawnError);
      else resolve({ stdout, stderr, code, signal, elapsedMs: Date.now() - startedAt });
    });
  });
}

/**
 * A child that died on a signal. Node kills it with SIGKILL at the timeout,
 * but so does the kernel's OOM killer — large-v3 wants several GB resident —
 * and a mismatched ggml file or a bad build dies on SIGSEGV. Only the clock
 * separates them, and since this runs from cron the message is the whole
 * diagnosis: calling an OOM kill a timeout sends the user to change
 * WHISPER_MODEL when the box actually ran out of memory.
 */
function signalFailure(whisper, wav, { signal, elapsedMs, stderr }) {
  if (elapsedMs >= whisper.timeoutMs) {
    const seconds = Math.round(whisper.timeoutMs / 1000);
    const remedy = `set WHISPER_MODEL=large-v3-turbo if ${whisper.model} cannot keep up`;
    return new Error(`whisper-cli timed out after ${seconds}s on ${wav}: ${remedy}`);
  }
  const detail = stderr.trim().slice(-STDERR_TAIL) || '(no stderr)';
  const why =
    signal === 'SIGKILL'
      ? `${whisper.model} needs several GB resident, check dmesg for an OOM kill; ${detail}`
      : detail;
  const elapsed = (elapsedMs / 1000).toFixed(1);
  return new Error(`whisper-cli was killed by ${signal} after ${elapsed}s on ${wav}: ${why}`);
}

/**
 * Transcribe the speech in one 16 kHz WAV into `[{start, end, text}]`, in
 * episode seconds. The binary writes its JSON into a directory of its own
 * that goes away with the call: the database is the source of truth, so the
 * raw document is never kept.
 */
export async function transcribeWav(whisper, vad, wav) {
  const files = modelFiles(whisper);
  requireModelFile(files.model, `download-ggml-model.sh ${whisper.model} ${whisper.modelDir}`);
  await requireVadModel(vad);
  requireWhisperCli(whisper);

  const dir = mkdtempSync(join(tmpdir(), 'akt-whisper-'));
  const prefix = join(dir, 'out');
  const args = [
    '-m',
    files.model,
    '-f',
    wav,
    '-l',
    'ru',
    '-oj',
    '-of',
    prefix,
    // No prints and no GPU: unattended from cron, on CPU, by design.
    '-np',
    '-ng',
    ...(whisper.threads === null ? [] : ['-t', String(whisper.threads)]),
    '--vad',
    ...vadArgs(vad),
  ];

  try {
    let finished;
    try {
      finished = await runWhisper(whisper, args, dir);
    } catch (err) {
      if (err?.code === 'ENOENT') {
        const where = `WHISPER_CLI=${whisper.bin}`;
        throw new SetupError(`whisper-cli not found (${where}): build whisper.cpp, see README`);
      }
      throw new Error(`whisper-cli could not be started: ${err?.message ?? err}`);
    }

    const { stderr, code, signal } = finished;
    if (signal !== null) throw signalFailure(whisper, wav, finished);
    if (code !== 0) {
      const detail = stderr.trim().slice(-STDERR_TAIL) || '(no stderr)';
      throw new Error(`whisper-cli exited ${code}: ${detail}`);
    }

    let output;
    try {
      output = readFileSync(`${prefix}.json`, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      throw new Error(`whisper-cli exited 0 but wrote no JSON at ${prefix}.json`);
    }
    return parseWhisperJson(output);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Build the adapter from the environment. A bad value is a usage error, so a
 * typo in `.env` exits 2 with the usage text instead of failing every episode
 * of the run one at a time.
 */
export function whisperFromEnv(env = process.env) {
  const model = env.WHISPER_MODEL ?? DEFAULT_WHISPER_MODEL;
  if (!MODEL_PATTERN.test(model)) {
    throw new UsageError(`WHISPER_MODEL must be a ggml model name, got: ${model}`);
  }

  const timeout = env.WHISPER_TIMEOUT ?? String(DEFAULT_TIMEOUT_SEC);
  const seconds = Number(timeout);
  if (!Number.isInteger(seconds) || seconds < 1) {
    throw new UsageError(`WHISPER_TIMEOUT must be a whole number of seconds, got: ${timeout}`);
  }

  let threads = null;
  if (env.WHISPER_THREADS !== undefined && env.WHISPER_THREADS !== '') {
    threads = Number(env.WHISPER_THREADS);
    if (!Number.isInteger(threads) || threads < 1) {
      const got = env.WHISPER_THREADS;
      throw new UsageError(`WHISPER_THREADS must be a positive integer, got: ${got}`);
    }
  }

  return {
    bin: env.WHISPER_CLI ?? DEFAULT_WHISPER_CLI,
    model,
    modelDir: env.WHISPER_MODEL_DIR ?? DEFAULT_MODEL_DIR,
    timeoutMs: seconds * 1000,
    threads,
    env,
  };
}
