import { parseArgs } from 'node:util';
import { DEFAULT_DB_PATH, openDb } from './db.js';
import { SetupError, UsageError } from './errors.js';
import { FEED_START_URL } from './feed.js';
import { llmFromEnv } from './llm.js';
import { acquireLock, LockHeldError } from './lock.js';
import { DEFAULT_MEDIA_DIR } from './media.js';
import { runPipeline } from './runner.js';
import { registry } from './steps/registry.js';
import { DEFAULT_SYNONYMS_PATH, loadSynonyms } from './synonyms.js';
import { vadFromEnv } from './vad.js';
import { whisperFromEnv } from './whisper.js';

export { UsageError };

const COMMANDS = ['run'];

export function usage() {
  return `Usage: akt run [options]

Options:
  --db <path>        SQLite database (default: $AKT_DB or ${DEFAULT_DB_PATH})
  --limit <n>        Process at most n episodes in this invocation
  --episode <guid>   Process only this episode
  --step <name>      Run this step regardless of status
  -h, --help         Show this help
`;
}

export function parseCli(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        db: { type: 'string' },
        limit: { type: 'string' },
        episode: { type: 'string' },
        step: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    throw new UsageError(err.message);
  }

  const { values, positionals } = parsed;
  if (values.help)
    return { command: null, help: true, db: null, limit: null, episode: null, step: null };

  if (positionals.length !== 1) throw new UsageError('expected exactly one command: run');
  const command = positionals[0];
  if (!COMMANDS.includes(command)) throw new UsageError(`unknown command: ${command}`);

  let limit = null;
  if (values.limit !== undefined) {
    limit = Number.parseInt(values.limit, 10);
    if (!Number.isInteger(limit) || limit < 1) {
      throw new UsageError(`--limit must be a positive integer, got: ${values.limit}`);
    }
  }

  return {
    command,
    help: false,
    db: values.db ?? null,
    limit,
    episode: values.episode ?? null,
    step: values.step ?? null,
  };
}

let activeLock = null;

/** Release the run lock from a signal handler. */
export function releaseActiveLock() {
  activeLock?.release();
  activeLock = null;
}

function log(line) {
  process.stderr.write(`${new Date().toISOString()} ${line}\n`);
}

function reportUsage(message) {
  process.stderr.write(`${message}\n\n${usage()}`);
  return 2;
}

/** Returns the process exit code; never calls process.exit itself. */
export async function main(argv, env = process.env) {
  let options;
  let llm;
  let whisper;
  let vad;
  let synonyms;
  try {
    options = parseCli(argv);
    // A bad LLM_CLI or LLM_TIMEOUT is as much a usage error as a bad flag,
    // and worth learning about before the run takes the lock. Whisper, VAD
    // config and the alias file are validated here for the same reason.
    llm = llmFromEnv(env, log);
    whisper = whisperFromEnv(env);
    vad = vadFromEnv(env);
    synonyms = loadSynonyms(env.AKT_SYNONYMS ?? DEFAULT_SYNONYMS_PATH);
  } catch (err) {
    if (err instanceof UsageError) return reportUsage(err.message);
    throw err;
  }
  if (options.help) {
    process.stdout.write(usage());
    return 0;
  }

  const dbPath = options.db ?? env.AKT_DB ?? DEFAULT_DB_PATH;
  try {
    activeLock = acquireLock(`${dbPath}.lock`);
  } catch (err) {
    if (err instanceof LockHeldError) {
      process.stderr.write(`${err.message}\n`);
      return 1;
    }
    throw err;
  }

  let db;
  try {
    db = openDb(dbPath);
  } catch (err) {
    releaseActiveLock();
    throw err;
  }

  const ctx = {
    db,
    log,
    llm,
    whisper,
    vad,
    synonyms,
    now: () => new Date().toISOString(),
    fetch: globalThis.fetch,
    feedUrl: env.AKT_FEED_URL ?? FEED_START_URL,
    mediaDir: env.AKT_MEDIA_DIR ?? DEFAULT_MEDIA_DIR,
    keepMedia: /^(1|true|yes)$/i.test(env.KEEP_MEDIA ?? ''),
    ffmpeg: env.AKT_FFMPEG ?? 'ffmpeg',
  };

  try {
    const { failures } = await runPipeline(ctx, registry, options);
    log(llm.summary());
    return failures > 0 ? 1 : 0;
  } catch (err) {
    if (err instanceof UsageError) return reportUsage(err.message);
    // A missing prerequisite is not a bug to read a stack trace for: say what
    // is missing and stop, with nothing recorded against any episode.
    if (err instanceof SetupError) {
      process.stderr.write(`${err.message}\n`);
      return 2;
    }
    process.stderr.write(`${err?.stack ?? err}\n`);
    return 1;
  } finally {
    db.close();
    releaseActiveLock();
  }
}
