import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const FIXTURE_PATH = join(import.meta.dirname, 'fixtures', 'feed.xml');

export const DESCRIPTIONS_PATH = join(import.meta.dirname, 'fixtures', 'descriptions');

/** The fake `claude`/`codex` the suite puts on PATH instead of the real CLI. */
export const FAKE_LLM_PATH = join(import.meta.dirname, 'fixtures', 'fake-llm.sh');

/** The fake `whisper-cli` the suite puts on PATH instead of whisper.cpp. */
export const FAKE_WHISPER_PATH = join(import.meta.dirname, 'fixtures', 'fake-whisper-cli.sh');

/** A realistic `whisper-cli -oj` document, as the fake prints it. */
export const WHISPER_OUTPUT_PATH = join(import.meta.dirname, 'fixtures', 'whisper-output.json');

export function whisperOutput() {
  return JSON.parse(readFileSync(WHISPER_OUTPUT_PATH, 'utf8'));
}

export function fixtureFeed() {
  return readFileSync(FIXTURE_PATH, 'utf8');
}

/**
 * Every checked-in description fixture, oldest first. The episodes span the
 * feed and both entry layouts: #4 and #20 predate the numbered one-line shape,
 * #40 and #42 use the two-line `LP Album (Label)` shape, #75-#84 the current
 * one. Listed explicitly so a fixture cannot go missing unnoticed.
 */
export const DESCRIPTION_FIXTURES = [
  '004',
  '020',
  '040',
  '042',
  '075',
  '077',
  '078',
  '079',
  '080',
  '081',
  '083',
  '084',
];

/**
 * One description fixture: `html` is verbatim `description_raw` as ingest
 * stored it, `expected` the hand-verified parse. Nothing here touches the
 * network.
 */
export function descriptionFixture(name) {
  if (!DESCRIPTION_FIXTURES.includes(name)) {
    throw new Error(`unknown description fixture: ${name}`);
  }
  return {
    name,
    html: readFileSync(join(DESCRIPTIONS_PATH, `${name}.html`), 'utf8'),
    expected: JSON.parse(readFileSync(join(DESCRIPTIONS_PATH, `${name}.json`), 'utf8')),
  };
}

/** Every description fixture, oldest episode first. */
export function descriptionFixtures() {
  return DESCRIPTION_FIXTURES.map((name) => descriptionFixture(name));
}

/** A temp directory that removes itself when the test ends. */
export function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'akt-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A fetch stub over a { url: xml } map that records every requested URL. */
export function stubFetch(responses) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(String(url));
    const body = responses[String(url)];
    if (body === undefined) {
      return { ok: false, status: 404, statusText: 'Not Found', text: async () => '' };
    }
    return { ok: true, status: 200, statusText: 'OK', text: async () => body };
  };
  fetch.calls = calls;
  return fetch;
}

/** The envelope `claude -p --output-format json` prints around its reply. */
export function claudeEnvelope(result, { isError = false } = {}) {
  return `${JSON.stringify({ type: 'result', subtype: 'success', is_error: isError, result })}\n`;
}

/** The `call.N` files the fake wrote, oldest first. */
function readFakeCalls(store) {
  const calls = [];
  while (existsSync(join(store, `call.${calls.length + 1}`))) {
    const text = readFileSync(join(store, `call.${calls.length + 1}`), 'utf8');
    const [cwd, entries, apiKey, ...rest] = text.split('\n');
    const argv = rest.join('\n').split('\0');
    // Every recorded argument is NUL-terminated, so the tail is always empty.
    argv.pop();
    calls.push({ cwd, entries: Number(entries), apiKey, argv, prompt: argv.at(-1) ?? null });
  }
  return calls;
}

/**
 * A fake `claude` and `codex` on PATH, so the suite never spawns the real CLI
 * and never needs a login. `replies[i]` answers the i-th call and `reply`
 * answers every call without one of its own; for `cli: 'claude'` a reply is
 * wrapped in the CLI's JSON envelope unless `wrap` is false. `exit`, `stderr`
 * and `sleep` make the fake fail, complain or hang.
 */
export function fakeLlm(t, options = {}) {
  const {
    cli = 'claude',
    replies = [],
    reply = null,
    exit = null,
    stderr = null,
    sleep = null,
  } = options;
  const wrap = options.wrap ?? cli === 'claude';

  const dir = tempDir(t);
  const bin = join(dir, 'bin');
  const store = join(dir, 'calls');
  mkdirSync(bin);
  mkdirSync(store);
  for (const name of ['claude', 'codex']) {
    const target = join(bin, name);
    copyFileSync(FAKE_LLM_PATH, target);
    chmodSync(target, 0o755);
  }

  const wrapped = (text) => (wrap ? claudeEnvelope(text) : text);
  for (const [index, text] of replies.entries()) {
    writeFileSync(join(store, `stdout.${index + 1}`), wrapped(text));
  }
  if (reply !== null) writeFileSync(join(store, 'stdout'), wrapped(reply));

  const env = { PATH: `${bin}:${process.env.PATH}`, FAKE_LLM_DIR: store, LLM_CLI: cli };
  if (exit !== null) env.FAKE_LLM_EXIT = String(exit);
  if (stderr !== null) env.FAKE_LLM_STDERR = stderr;
  if (sleep !== null) env.FAKE_LLM_SLEEP = String(sleep);

  return { bin, store, env, calls: () => readFakeCalls(store) };
}

/** The `call.N` files the fake whisper wrote, oldest first. */
function readWhisperCalls(store) {
  const calls = [];
  while (existsSync(join(store, `call.${calls.length + 1}`))) {
    const text = readFileSync(join(store, `call.${calls.length + 1}`), 'utf8');
    const cut = text.indexOf('\n');
    const argv = text.slice(cut + 1).split('\0');
    // Every recorded argument is NUL-terminated, so the tail is always empty.
    argv.pop();
    calls.push({ cwd: text.slice(0, cut), argv });
  }
  return calls;
}

/**
 * A fake `whisper-cli` on PATH plus zero-byte stand-ins for its weight and the
 * shared Silero weight, so the suite runs offline with no real model on disk.
 * The adapters only check that they exist and the fakes never open them. `json` replaces the
 * canned document, and `exit`, `stderr`, `sleep`, `signal` and `noJson` make
 * the fake fail, complain, hang, die on a signal or write nothing.
 */
export function fakeWhisper(t, options = {}) {
  const {
    json = null,
    exit = null,
    stderr = null,
    sleep = null,
    signal = null,
    noJson = false,
    model = 'large-v3',
  } = options;

  const dir = tempDir(t);
  const binDir = join(dir, 'bin');
  const store = join(dir, 'calls');
  const modelDir = join(dir, 'models');
  for (const made of [binDir, store, modelDir]) mkdirSync(made);

  const bin = join(binDir, 'whisper-cli');
  copyFileSync(FAKE_WHISPER_PATH, bin);
  chmodSync(bin, 0o755);

  const document = json ?? readFileSync(WHISPER_OUTPUT_PATH, 'utf8');
  writeFileSync(
    join(store, 'output.json'),
    typeof document === 'string' ? document : JSON.stringify(document),
  );
  for (const name of [`ggml-${model}.bin`, 'ggml-silero-v6.2.0.bin']) {
    writeFileSync(join(modelDir, name), '');
  }

  const env = {
    PATH: `${binDir}:${process.env.PATH}`,
    FAKE_WHISPER_DIR: store,
    WHISPER_MODEL_DIR: modelDir,
    AKT_VAD_MODEL: join(modelDir, 'ggml-silero-v6.2.0.bin'),
  };
  if (exit !== null) env.FAKE_WHISPER_EXIT = String(exit);
  if (stderr !== null) env.FAKE_WHISPER_STDERR = stderr;
  if (sleep !== null) env.FAKE_WHISPER_SLEEP = String(sleep);
  if (signal !== null) env.FAKE_WHISPER_SIGNAL = String(signal);
  if (noJson) env.FAKE_WHISPER_NO_JSON = '1';

  return { bin, binDir, store, modelDir, env, calls: () => readWhisperCalls(store) };
}

export function testCtx(
  db,
  {
    feedUrl,
    fetch,
    llm = null,
    whisper = null,
    vad = null,
    now = '2026-09-09T00:00:00.000Z',
    mediaDir,
    keepMedia = false,
    ffmpeg = 'ffmpeg',
  } = {},
) {
  const lines = [];
  return {
    db,
    fetch,
    feedUrl,
    llm,
    whisper,
    vad,
    mediaDir,
    keepMedia,
    ffmpeg,
    log: (line) => lines.push(line),
    now: () => (typeof now === 'function' ? now() : now),
    lines,
  };
}

/** The bytes the media server serves: deterministic, so sizes are assertable. */
export function mediaBytes(size) {
  return Buffer.alloc(size, 'AKT!');
}

/**
 * Stand-in for api.mave.digital + cdn.mave.digital: `/api/<name>.mp3` answers
 * a 302 to `/cdn/<name>.mp3?v=<n>`, which serves `opts.size` deterministic
 * bytes with a Content-Length and `Accept-Ranges: bytes`. `opts` is mutable so
 * a test can make the next transfer misbehave.
 */
export function mediaServer(t, options = {}) {
  const opts = { size: 4096, interruptAfter: null, chunked: false, ...options };
  const hits = [];

  const server = createServer((req, res) => {
    hits.push(req.url);
    const path = req.url.split('?')[0];
    if (path.startsWith('/api/')) {
      res.writeHead(302, { location: `${path.replace('/api/', '/cdn/')}?v=7` });
      res.end();
      return;
    }
    if (!path.startsWith('/cdn/')) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('no such enclosure');
      return;
    }
    const headers = { 'content-type': 'audio/mpeg', 'accept-ranges': 'bytes' };
    if (!opts.chunked) headers['content-length'] = String(opts.size);
    res.writeHead(200, headers);
    const body = mediaBytes(opts.size);
    if (opts.interruptAfter !== null) {
      res.write(body.subarray(0, opts.interruptAfter), () => res.socket.destroy());
      return;
    }
    res.end(body);
  });

  t.after(() => {
    server.closeAllConnections();
    server.close();
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const origin = `http://127.0.0.1:${server.address().port}`;
      resolve({ origin, hits, opts, url: (name) => `${origin}/api/${name}.mp3` });
    });
  });
}

/**
 * A 16 kHz mono PCM WAV holding `seconds` of silence — the shape `download`
 * leaves behind. `list` inserts the LIST/INFO chunk ffmpeg writes between
 * `fmt ` and `data`, so a reader that assumes a 44-byte header is caught.
 */
export function wavBytes(seconds, { list = false } = {}) {
  const sampleRate = 16000;
  const byteRate = sampleRate * 2;

  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0, 'latin1');
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);
  fmt.writeUInt16LE(1, 10);
  fmt.writeUInt32LE(sampleRate, 12);
  fmt.writeUInt32LE(byteRate, 16);
  fmt.writeUInt16LE(2, 20);
  fmt.writeUInt16LE(16, 22);
  const chunks = [fmt];

  if (list) {
    const value = Buffer.alloc(14);
    value.write('Lavf60.16.100', 0, 'latin1');
    const info = Buffer.alloc(8 + value.length);
    info.write('ISFT', 0, 'latin1');
    info.writeUInt32LE(value.length, 4);
    value.copy(info, 8);
    const head = Buffer.alloc(8);
    head.write('LIST', 0, 'latin1');
    head.writeUInt32LE(4 + info.length, 4);
    chunks.push(head, Buffer.from('INFO', 'latin1'), info);
  }

  const samples = Buffer.alloc(Math.round(seconds * byteRate));
  const dataHead = Buffer.alloc(8);
  dataHead.write('data', 0, 'latin1');
  dataHead.writeUInt32LE(samples.length, 4);
  chunks.push(dataHead, samples);

  const body = Buffer.concat(chunks);
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'latin1');
  riff.writeUInt32LE(4 + body.length, 4);
  riff.write('WAVE', 8, 'latin1');
  return Buffer.concat([riff, body]);
}

/** One second of that WAV: what the fake ffmpeg writes for every episode. */
export const FAKE_WAV = wavBytes(1);

/** What `vad-speech-segments` prints for a list of speech intervals. */
export function vadOutput(segments) {
  const lines = [`Detected ${segments.length} speech segments:`];
  for (const [index, seg] of segments.entries()) {
    const start = seg.start.toFixed(2);
    lines.push(`Speech segment ${index}: start = ${start}, end = ${seg.end.toFixed(2)}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * A fake `vad-speech-segments`, so the suite never needs whisper.cpp's binary
 * or the Silero model. It appends its argv to a log and prints `segments` in
 * the binary's format, unless `stdout` replaces the whole reply. `exit`,
 * `stderr` and `sleep` make it fail, complain or hang; `failFor` limits the
 * failure to the calls whose argv contains that string, so one fake can fail
 * for a single episode of a run.
 */
export function fakeVad(t, options = {}) {
  const { segments = [], exit = 0, stderr = '', sleep = null, failFor = null } = options;
  const dir = tempDir(t);
  const bin = join(dir, 'vad-speech-segments');
  const argsLog = join(dir, 'vad.args');
  const reply = join(dir, 'vad.stdout');
  writeFileSync(reply, options.stdout ?? vadOutput(segments));

  const complain = stderr ? `printf '%s\\n' ${JSON.stringify(stderr)} >&2` : ':';
  const script = [
    '#!/bin/sh',
    `for arg in "$@"; do printf '%s\\0' "$arg"; done >> ${JSON.stringify(argsLog)}`,
    `printf '\\n' >> ${JSON.stringify(argsLog)}`,
  ];
  if (failFor !== null) {
    script.push(
      'for arg in "$@"; do',
      `  case "$arg" in *${failFor}*) ${complain}; exit ${exit || 1} ;; esac`,
      'done',
    );
  }
  if (sleep !== null) {
    // Redirected so an orphaned sleep cannot hold stdout open past the kill.
    script.push(`sleep ${sleep} </dev/null >/dev/null 2>&1`);
  }
  script.push(`cat ${JSON.stringify(reply)}`);
  script.push(failFor === null ? complain : ':', `exit ${failFor === null ? exit : 0}`, '');
  writeFileSync(bin, script.join('\n'));
  chmodSync(bin, 0o755);

  return {
    bin,
    dir,
    env: { PATH: `${dir}:${process.env.PATH}` },
    /** One entry per call, each the argv the fake was given. */
    calls() {
      try {
        return readFileSync(argsLog, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => line.split('\0').filter((arg) => arg !== ''));
      } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
      }
    },
  };
}

/**
 * The VAD config a step gets: the fake binary, a touched model file beside it
 * and a music floor short enough for test-length audio.
 */
export function vadConfig(fake, overrides = {}) {
  const model = join(fake.dir, 'silero-v6.2.0.bin');
  writeFileSync(model, 'GGML');
  return {
    bin: fake.bin,
    model,
    threshold: 0.5,
    minSpeechMs: 250,
    minSilenceMs: 100,
    speechPadMs: 30,
    minMusicSec: 5,
    timeoutMs: 15 * 60 * 1000,
    ...overrides,
  };
}

/**
 * An ffmpeg that records its argv and writes a fixed payload to its last
 * argument. ffmpeg is a prerequisite of the box, not an npm dependency, so
 * tests substitute it through AKT_FFMPEG / ctx.ffmpeg.
 */
export function fakeFfmpeg(dir, { exitCode = 0, stderr = '' } = {}) {
  const bin = join(dir, 'ffmpeg');
  const argsLog = join(dir, 'ffmpeg.args');
  // A real WAV, not a marker string: `segment` reads the duration out of the
  // RIFF header, so every fake decode has to produce a readable one.
  const payload = join(dir, 'decoded.wav');
  writeFileSync(payload, FAKE_WAV);
  writeFileSync(
    bin,
    [
      '#!/bin/sh',
      `echo "$@" >> ${JSON.stringify(argsLog)}`,
      stderr ? `printf '%s' ${JSON.stringify(stderr)} >&2` : ':',
      'for out; do :; done',
      `if [ ${exitCode} -eq 0 ]; then cat ${JSON.stringify(payload)} > "$out"; fi`,
      `exit ${exitCode}`,
      '',
    ].join('\n'),
  );
  chmodSync(bin, 0o755);
  return {
    bin,
    calls() {
      try {
        return readFileSync(argsLog, 'utf8').trim().split('\n').filter(Boolean);
      } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
      }
    },
  };
}
