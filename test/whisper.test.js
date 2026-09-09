import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { SetupError, UsageError } from '../src/errors.js';
import { vadFromEnv } from '../src/vad.js';
import {
  DEFAULT_TIMEOUT_SEC,
  modelFiles,
  parseWhisperJson,
  transcribeWav,
  whisperFromEnv,
} from '../src/whisper.js';
import { fakeWhisper, tempDir, whisperOutput } from './helpers.js';

/** The value that followed `flag` in a recorded argv, or null. */
function flagValue(argv, flag) {
  const at = argv.indexOf(flag);
  if (at === -1) return null;
  return argv[at + 1] ?? null;
}

/** A whisper adapter driving the fake binary, plus a WAV for it to read. */
function setup(t, options = {}, overrides = {}) {
  const fake = fakeWhisper(t, options);
  const env = { ...process.env, ...fake.env, ...overrides };
  const whisper = whisperFromEnv(env);
  const vad = vadFromEnv(env);
  const wav = join(tempDir(t), 'episode.wav');
  writeFileSync(wav, 'FAKEWAVDATA');
  return { fake, whisper, vad, wav };
}

test('whisperFromEnv defaults to one large-v3 on CPU with an hour to finish', () => {
  assert.deepEqual(whisperFromEnv({}), {
    bin: 'whisper-cli',
    model: 'large-v3',
    modelDir: './models',
    timeoutMs: DEFAULT_TIMEOUT_SEC * 1000,
    threads: null,
    env: {},
  });

  const configured = whisperFromEnv({
    WHISPER_CLI: '/opt/whisper.cpp/build/bin/whisper-cli',
    WHISPER_MODEL: 'large-v3-turbo',
    WHISPER_MODEL_DIR: '/opt/models',
    WHISPER_TIMEOUT: '900',
    WHISPER_THREADS: '4',
  });
  assert.equal(configured.bin, '/opt/whisper.cpp/build/bin/whisper-cli');
  assert.equal(configured.model, 'large-v3-turbo');
  assert.equal(configured.timeoutMs, 900_000);
  assert.equal(configured.threads, 4);
});

test('a typo in the whisper config is a usage error, not 80 failed episodes', () => {
  for (const env of [
    { WHISPER_MODEL: '../../etc/passwd' },
    { WHISPER_MODEL: '' },
    { WHISPER_TIMEOUT: 'soon' },
    { WHISPER_TIMEOUT: '0' },
    { WHISPER_TIMEOUT: '1.5' },
    { WHISPER_THREADS: 'many' },
    { WHISPER_THREADS: '0' },
  ]) {
    assert.throws(
      () => whisperFromEnv(env),
      UsageError,
      `expected UsageError for ${JSON.stringify(env)}`,
    );
  }
});

test('modelFiles names the transcription weight in the configured directory', () => {
  const whisper = whisperFromEnv({ WHISPER_MODEL_DIR: '/opt/models', WHISPER_MODEL: 'large-v3' });
  assert.deepEqual(modelFiles(whisper), { model: '/opt/models/ggml-large-v3.bin' });
});

test('parseWhisperJson turns millisecond offsets into episode seconds', () => {
  const segments = parseWhisperJson(JSON.stringify(whisperOutput()));
  assert.deepEqual(segments, [
    {
      start: 62,
      end: 68.48,
      text: 'Здравствуйте, в эфире «Стереоплан», у микрофона Артемий Троицкий.',
    },
    { start: 68.48, end: 75.24, text: 'Начнём мы сегодня с новой пластинки норвежского трио.' },
    {
      start: 604.3,
      end: 611.9,
      text: 'Это была «Осень», лейбл выпустил её на виниле в прошлом месяце.',
    },
  ]);
});

test('a document whisper did not write is rejected rather than half-read', () => {
  for (const output of [
    'not json at all',
    '{"result": {"language": "ru"}}',
    '{"transcription": {}}',
    '{"transcription": [{"offsets": {"from": "0", "to": 1000}, "text": "а"}]}',
    '{"transcription": [{"offsets": {"from": 0}, "text": "а"}]}',
    '{"transcription": [{"offsets": {"from": 0, "to": 1000}}]}',
  ]) {
    assert.throws(() => parseWhisperJson(output), /whisper-cli JSON/, `accepted: ${output}`);
  }
});

test('transcribeWav asks for Russian, JSON and shared VAD, then cleans up', async (t) => {
  const { fake, whisper, vad, wav } = setup(t);

  const segments = await transcribeWav(whisper, vad, wav);
  assert.equal(segments.length, 3);

  const calls = fake.calls();
  assert.equal(calls.length, 1, 'one episode, one invocation');
  const { argv, cwd } = calls[0];
  assert.equal(flagValue(argv, '-m'), join(fake.modelDir, 'ggml-large-v3.bin'));
  assert.equal(flagValue(argv, '-f'), wav);
  assert.equal(flagValue(argv, '-l'), 'ru', 'the language is pinned, never auto-detected');
  assert.ok(argv.includes('-oj'), 'timestamps come from the JSON, not the human-readable log');
  assert.ok(argv.includes('-np'), 'no progress prints: this runs from cron');
  assert.ok(argv.includes('-ng'), 'CPU only');
  assert.ok(!argv.includes('-t'), 'no thread override unless WHISPER_THREADS asks for one');

  assert.ok(argv.includes('--vad'), 'music is never transcribed');
  assert.equal(flagValue(argv, '--vad-model'), vad.model);
  assert.equal(flagValue(argv, '--vad-threshold'), '0.5');
  assert.equal(flagValue(argv, '--vad-min-speech-duration-ms'), '250');
  assert.equal(flagValue(argv, '--vad-min-silence-duration-ms'), '100');
  assert.equal(flagValue(argv, '--vad-speech-pad-ms'), '30');
  assert.equal(flagValue(argv, '--vad-samples-overlap'), null);

  const dir = dirname(flagValue(argv, '-of'));
  assert.ok(basename(dir).startsWith('akt-whisper-'), `-of wrote into ${dir}`);
  assert.equal(basename(cwd), basename(dir), 'the child runs in that directory');
  assert.equal(existsSync(dir), false, 'the raw JSON does not outlive the call');
});

test('WHISPER_THREADS is passed through when it is set', async (t) => {
  const { fake, whisper, vad, wav } = setup(t, {}, { WHISPER_THREADS: '3' });

  await transcribeWav(whisper, vad, wav);

  assert.equal(flagValue(fake.calls()[0].argv, '-t'), '3');
});

test('a missing model file names the download command and spawns nothing', async (t) => {
  const { fake, vad, wav } = setup(t);
  const empty = tempDir(t);
  const whisper = whisperFromEnv({ ...process.env, ...fake.env, WHISPER_MODEL_DIR: empty });

  await assert.rejects(
    () => transcribeWav(whisper, vad, wav),
    new RegExp(`no model at ${empty}/ggml-large-v3.bin: .*download-ggml-model.sh large-v3`),
  );
  assert.equal(fake.calls().length, 0, 'nothing is spawned without weights');
});

test('a missing VAD model is reported on its own, with its own command', async (t) => {
  const { fake, whisper, wav } = setup(t);
  const missing = join(tempDir(t), 'ggml-silero-v6.2.0.bin');
  const vad = vadFromEnv({ ...process.env, ...fake.env, AKT_VAD_MODEL: missing });

  await assert.rejects(
    () => transcribeWav(whisper, vad, wav),
    /no vad model at .*ggml-silero-v6\.2\.0\.bin: .*download-vad-model\.sh silero-v6\.2\.0/,
  );
  assert.equal(fake.calls().length, 0);
});

test('a whisper-cli that is not installed is a setup error, not an episode failure', async (t) => {
  const { fake, vad, wav } = setup(t);
  const missing = join(fake.binDir, 'no-such-whisper-cli');
  const whisper = whisperFromEnv({ ...process.env, ...fake.env, WHISPER_CLI: missing });

  await assert.rejects(() => transcribeWav(whisper, vad, wav), SetupError);
  await assert.rejects(
    () => transcribeWav(whisper, vad, wav),
    new RegExp(`whisper-cli not found \\(WHISPER_CLI=${missing}`),
  );
});

test('a non-zero exit surfaces what the binary complained about', async (t) => {
  const { whisper, vad, wav } = setup(t, { exit: 3, stderr: 'error: failed to load the model' });

  await assert.rejects(
    () => transcribeWav(whisper, vad, wav),
    /whisper-cli exited 3: error: failed to load the model/,
  );
});

test('an exit 0 that wrote no JSON is a failure, not an empty transcript', async (t) => {
  const { whisper, vad, wav } = setup(t, { noJson: true });

  await assert.rejects(() => transcribeWav(whisper, vad, wav), /wrote no JSON/);
});

test('unparsable JSON is a failure of this episode', async (t) => {
  const { whisper, vad, wav } = setup(t, { json: 'Segmentation fault' });

  await assert.rejects(
    () => transcribeWav(whisper, vad, wav),
    /whisper-cli JSON could not be parsed/,
  );
});

test('a whisper-cli killed by a signal well inside the budget is not a timeout', async (t) => {
  const { whisper, vad, wav } = setup(t, { signal: 'KILL' });

  const err = await transcribeWav(whisper, vad, wav).then(null, (failure) => failure);

  assert.ok(err instanceof Error, 'a child that died on a signal is a failure');
  assert.match(err.message, /killed by SIGKILL after \d+\.\ds/);
  assert.match(err.message, /OOM/, 'the user is sent to memory, not to the model budget');
  assert.doesNotMatch(err.message, /timed out/, 'nothing like WHISPER_TIMEOUT elapsed');
});

test('a hung whisper-cli is killed at WHISPER_TIMEOUT and names the smaller model', async (t) => {
  const { whisper, vad, wav } = setup(t, { sleep: 30 }, { WHISPER_TIMEOUT: '1' });

  const startedAt = Date.now();
  await assert.rejects(
    () => transcribeWav(whisper, vad, wav),
    /whisper-cli timed out after 1s .*WHISPER_MODEL=large-v3-turbo/,
  );
  assert.ok(Date.now() - startedAt < 4000, 'the child is killed, not waited out');
});
