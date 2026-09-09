import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { SetupError, UsageError } from './errors.js';

/**
 * whisper.cpp's Silero VAD, and the labelling that turns its speech intervals
 * into the speech/music partition of an episode.
 *
 * The values live here rather than in the step because `transcribe` has to
 * pass whisper-cli exactly the same ones: `vadArgs` is the single spelling of
 * those flags, so a transcript and this partition can never disagree about
 * where speech is. Music is the complement of speech — these episodes
 * alternate host commentary with whole songs — smoothed so that a breath
 * between two sentences is not mistaken for a song.
 *
 * Nothing here downloads anything: the model is fetched once, by hand, with
 * whisper.cpp's `models/download-vad-model.sh silero-v6.2.0`.
 */

/** A 90-minute episode over speech intervals only still has to finish. */
const DEFAULT_TIMEOUT_SEC = 15 * 60;

/** whisper.cpp prints far less than 16 MiB of segments for one episode. */
const MAX_BUFFER = 16 * 1024 * 1024;

const HOW_TO_GET_THE_MODEL =
  "fetch it with whisper.cpp's models/download-vad-model.sh silero-v6.2.0 and point AKT_VAD_MODEL at the file";

const HEADER = /^Detected\s+(\d+)\s+speech segments?:/m;

const SEGMENT = /^Speech segment\s+\d+:\s*start\s*=\s*(-?[\d.]+),\s*end\s*=\s*(-?[\d.]+)/;

/** whisper.cpp's standalone VAD example prints timestamps in centiseconds. */
const CENTISECONDS_PER_SECOND = 100;

function round2(seconds) {
  return Math.round(seconds * 100) / 100;
}

/** Seconds as `h:mm:ss`, the shape the log lists music ranges in. */
function clock(seconds) {
  const whole = Math.max(0, Math.floor(seconds));
  const minutes = String(Math.floor((whole % 3600) / 60)).padStart(2, '0');
  const secs = String(whole % 60).padStart(2, '0');
  return `${Math.floor(whole / 3600)}:${minutes}:${secs}`;
}

export function formatRange(start, end) {
  return `${clock(start)}-${clock(end)}`;
}

/** The flags `segment` and `transcribe` both hand the Silero model. */
export function vadArgs(vad) {
  return [
    '--vad-model',
    vad.model,
    '--vad-threshold',
    String(vad.threshold),
    '--vad-min-speech-duration-ms',
    String(vad.minSpeechMs),
    '--vad-min-silence-duration-ms',
    String(vad.minSilenceMs),
    '--vad-speech-pad-ms',
    String(vad.speechPadMs),
  ];
}

/**
 * What produced a stored interval list. Every knob is in it, so a re-tuned
 * threshold is visible in the row rather than only in the environment.
 */
export function vadModelTag(vad) {
  const thresholds = `threshold=${vad.threshold} min_speech_ms=${vad.minSpeechMs}`;
  const durations = `min_silence_ms=${vad.minSilenceMs} pad_ms=${vad.speechPadMs}`;
  return `${basename(vad.model)} ${thresholds} ${durations} min_music_s=${vad.minMusicSec}`;
}

/**
 * Read `Speech segment <i>: start = <f>, end = <f>` lines and convert the
 * binary's centiseconds to the seconds used everywhere in the database. The
 * `Detected <n>` header has to agree with them: a truncated or reformatted
 * reply is an error, never a silently empty episode.
 */
export function parseSpeechSegments(stdout) {
  const text = String(stdout ?? '');
  const segments = [];
  for (const line of text.split('\n')) {
    const match = SEGMENT.exec(line.trim());
    if (match) {
      segments.push({
        start: Number(match[1]) / CENTISECONDS_PER_SECOND,
        end: Number(match[2]) / CENTISECONDS_PER_SECOND,
      });
    }
  }
  const header = HEADER.exec(text);
  if (!header || Number(header[1]) !== segments.length) {
    const detail = header ? `${header[1]} announced, ${segments.length} parsed` : 'no header';
    throw new Error(`unrecognised vad-speech-segments output (${detail}):\n${text.trim()}`);
  }
  return segments;
}

/**
 * Turn detected speech into a contiguous partition of `[0, durationSec]`.
 *
 * Speech is clamped to the audio, sorted and merged; every remaining gap of at
 * least `minMusicSec` is music and every shorter one is absorbed into the
 * speech beside it, which is what keeps a breath between sentences from
 * becoming a one-second song.
 */
export function labelIntervals(speech, durationSec, minMusicSec) {
  if (!(durationSec > 0)) throw new Error(`bad audio duration: ${durationSec}`);

  const clamped = [];
  for (const segment of speech) {
    const start = Math.min(Math.max(segment.start, 0), durationSec);
    const end = Math.min(Math.max(segment.end, 0), durationSec);
    if (end > start) clamped.push({ start, end });
  }
  clamped.sort((a, b) => a.start - b.start || a.end - b.end);

  // One run per stretch of speech: overlapping, touching and breath-separated
  // segments all collapse into the same run.
  const runs = [];
  for (const segment of clamped) {
    const last = runs.at(-1);
    if (last && segment.start - last.end < minMusicSec) {
      last.end = Math.max(last.end, segment.end);
    } else {
      runs.push({ ...segment });
    }
  }

  const intervals = [];
  const add = (start, end, label) => {
    const from = round2(start);
    const to = round2(end);
    if (to <= from) return;
    const last = intervals.at(-1);
    if (last?.label === label) last.end = to;
    else intervals.push({ start: from, end: to, label });
  };

  let cursor = 0;
  for (const run of runs) {
    // A short head or gap belongs to the speech that follows it.
    const start = run.start - cursor < minMusicSec ? cursor : run.start;
    add(cursor, start, 'music');
    add(start, run.end, 'speech');
    cursor = run.end;
  }
  // No speech at all, or none of it long enough to survive rounding.
  if (intervals.length === 0) return [{ start: 0, end: round2(durationSec), label: 'music' }];
  if (cursor < durationSec) {
    if (durationSec - cursor >= minMusicSec) add(cursor, durationSec, 'music');
    else intervals.at(-1).end = round2(durationSec);
  }
  return intervals;
}

/** The CLI never started, or never finished: a setup problem, not an episode's. */
function spawnFailure(vad, err) {
  if (err?.code === 'ENOENT') {
    const how = "build whisper.cpp's vad-speech-segments target, or set AKT_VAD_BIN";
    return new SetupError(`${vad.bin} is not on PATH: ${how}`);
  }
  if (err?.killed || err?.signal) {
    return new Error(`${vad.bin} timed out after ${Math.round(vad.timeoutMs / 1000)}s`);
  }
  const detail = String(err?.stderr ?? '').trim() || err?.message || 'no output';
  return new Error(`${vad.bin} exited ${err?.code ?? 'unknown'}: ${detail}`);
}

function runVad(vad, args) {
  return new Promise((resolve, reject) => {
    const options = { timeout: vad.timeoutMs, killSignal: 'SIGKILL', maxBuffer: MAX_BUFFER };
    execFile(vad.bin, args, options, (err, stdout, stderr) => {
      if (err) reject(spawnFailure(vad, Object.assign(err, { stderr })));
      else resolve(stdout);
    });
  });
}

/** Verify the one Silero model shared by `segment` and `transcribe`. */
export async function requireVadModel(vad) {
  if (!vad?.model) {
    throw new SetupError(`AKT_VAD_MODEL is not set: ${HOW_TO_GET_THE_MODEL}`);
  }
  try {
    await stat(vad.model);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    throw new SetupError(`no vad model at ${vad.model}: ${HOW_TO_GET_THE_MODEL}`);
  }
  return vad.model;
}

/** Run the binary over one WAV and return the speech it found, in order. */
export async function detectSpeech(vad, wav) {
  await requireVadModel(vad);
  const stdout = await runVad(vad, ['--no-prints', ...vadArgs(vad), '--file', wav]);
  return parseSpeechSegments(stdout);
}

function number(env, key, fallback, check, expected) {
  const raw = env[key] || String(fallback);
  const value = Number(raw);
  if (!Number.isFinite(value) || !check(value)) {
    throw new UsageError(`${key} must be ${expected}, got: ${raw}`);
  }
  return value;
}

/**
 * Build the VAD config from the environment. A bad value is a usage error, so
 * a typo in `.env` exits 2 with the usage text instead of failing every
 * episode of a nightly run one at a time. The model path is not checked here:
 * it is only needed by the runs that actually reach `segment`.
 */
export function vadFromEnv(env = process.env) {
  const whole = (value) => Number.isInteger(value) && value >= 0;
  return {
    bin: env.AKT_VAD_BIN || 'vad-speech-segments',
    model: env.AKT_VAD_MODEL || null,
    threshold: number(env, 'AKT_VAD_THRESHOLD', 0.5, (v) => v >= 0 && v <= 1, 'a number in [0, 1]'),
    minSpeechMs: number(env, 'AKT_VAD_MIN_SPEECH_MS', 250, whole, 'a whole number of ms'),
    minSilenceMs: number(env, 'AKT_VAD_MIN_SILENCE_MS', 100, whole, 'a whole number of ms'),
    speechPadMs: number(env, 'AKT_VAD_SPEECH_PAD_MS', 30, whole, 'a whole number of ms'),
    minMusicSec: number(env, 'AKT_MIN_MUSIC_SEC', 20, (v) => v > 0, 'a positive number of seconds'),
    timeoutMs: DEFAULT_TIMEOUT_SEC * 1000,
  };
}
