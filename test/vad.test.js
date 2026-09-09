import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { UsageError } from '../src/errors.js';
import {
  detectSpeech,
  formatRange,
  labelIntervals,
  parseSpeechSegments,
  vadArgs,
  vadFromEnv,
  vadModelTag,
} from '../src/vad.js';
import { fakeVad, tempDir, vadConfig, vadOutput } from './helpers.js';

/** The interval list is the input to every later timestamp: check its shape. */
function assertPartition(intervals, durationSec) {
  assert.ok(intervals.length > 0, 'a partition is never empty');
  assert.equal(intervals[0].start, 0, 'the first interval starts at zero');
  assert.equal(intervals.at(-1).end, durationSec, 'the last interval ends at the duration');
  for (const [index, interval] of intervals.entries()) {
    assert.ok(['speech', 'music'].includes(interval.label), `bad label: ${interval.label}`);
    assert.ok(interval.end > interval.start, 'no zero-length interval');
    for (const value of [interval.start, interval.end]) {
      assert.equal(value, Math.round(value * 100) / 100, `${value} is not two decimals`);
    }
    if (index === 0) continue;
    const previous = intervals[index - 1];
    assert.equal(interval.start, previous.end, 'intervals are contiguous');
    assert.notEqual(interval.label, previous.label, 'adjacent labels always differ');
  }
}

test('a breath between sentences is absorbed instead of becoming music', () => {
  const intervals = labelIntervals(
    [
      { start: 0, end: 10 },
      { start: 10.4, end: 20 },
    ],
    20,
    5,
  );

  assert.deepEqual(intervals, [{ start: 0, end: 20, label: 'speech' }]);
  assertPartition(intervals, 20);
});

test('a gap of at least the music floor becomes a music interval', () => {
  const intervals = labelIntervals(
    [
      { start: 0, end: 10 },
      { start: 40, end: 60 },
    ],
    60,
    20,
  );

  assert.deepEqual(intervals, [
    { start: 0, end: 10, label: 'speech' },
    { start: 10, end: 40, label: 'music' },
    { start: 40, end: 60, label: 'speech' },
  ]);
  assertPartition(intervals, 60);
});

test('a gap exactly as long as the floor still counts as music', () => {
  assert.deepEqual(
    labelIntervals(
      [
        { start: 0, end: 10 },
        { start: 15, end: 20 },
      ],
      20,
      5,
    ),
    [
      { start: 0, end: 10, label: 'speech' },
      { start: 10, end: 15, label: 'music' },
      { start: 15, end: 20, label: 'speech' },
    ],
  );
});

test('short leading and trailing gaps are absorbed into the speech beside them', () => {
  const intervals = labelIntervals([{ start: 2, end: 10 }], 12, 5);

  assert.deepEqual(intervals, [{ start: 0, end: 12, label: 'speech' }]);
  assertPartition(intervals, 12);
});

test('long leading and trailing gaps are music of their own', () => {
  const intervals = labelIntervals([{ start: 30, end: 60 }], 100, 20);

  assert.deepEqual(intervals, [
    { start: 0, end: 30, label: 'music' },
    { start: 30, end: 60, label: 'speech' },
    { start: 60, end: 100, label: 'music' },
  ]);
  assertPartition(intervals, 100);
});

test('overlapping and touching speech segments are merged', () => {
  const intervals = labelIntervals(
    [
      { start: 0, end: 10 },
      { start: 5, end: 12 },
      { start: 12, end: 15 },
    ],
    15,
    5,
  );

  assert.deepEqual(intervals, [{ start: 0, end: 15, label: 'speech' }]);
});

test('speech segments are sorted and clamped to the audio', () => {
  const intervals = labelIntervals(
    [
      { start: 50, end: 80 },
      { start: -3, end: 5 },
    ],
    60,
    20,
  );

  assert.deepEqual(intervals, [
    { start: 0, end: 5, label: 'speech' },
    { start: 5, end: 50, label: 'music' },
    { start: 50, end: 60, label: 'speech' },
  ]);
  assertPartition(intervals, 60);
});

test('a segment entirely past the end of the audio is dropped', () => {
  assert.deepEqual(
    labelIntervals(
      [
        { start: 0, end: 5 },
        { start: 70, end: 80 },
      ],
      60,
      20,
    ),
    [
      { start: 0, end: 5, label: 'speech' },
      { start: 5, end: 60, label: 'music' },
    ],
  );
});

test('an episode with no detected speech is one music interval', () => {
  const intervals = labelIntervals([], 42, 20);

  assert.deepEqual(intervals, [{ start: 0, end: 42, label: 'music' }]);
  assertPartition(intervals, 42);
});

test('a duration of zero or less is a bug, not an empty list', () => {
  assert.throws(() => labelIntervals([{ start: 0, end: 1 }], 0, 5), /duration/);
  assert.throws(() => labelIntervals([], -1, 5), /duration/);
});

test('interval boundaries are rounded to two decimals and stay contiguous', () => {
  const intervals = labelIntervals(
    [
      { start: 0.005, end: 10.567 },
      { start: 12.3456, end: 20 },
    ],
    25.4321,
    1,
  );

  assert.deepEqual(intervals, [
    { start: 0, end: 10.57, label: 'speech' },
    { start: 10.57, end: 12.35, label: 'music' },
    { start: 12.35, end: 20, label: 'speech' },
    { start: 20, end: 25.43, label: 'music' },
  ]);
  assertPartition(intervals, 25.43);
});

test('parseSpeechSegments reads what the binary prints', () => {
  const stdout = [
    '',
    'Detected 2 speech segments:',
    'Speech segment 0: start = 0.32, end = 4.16',
    '',
    'Speech segment 1: start = 12.00, end = 130.48',
    '',
  ].join('\n');

  assert.deepEqual(parseSpeechSegments(stdout), [
    { start: 0.32, end: 4.16 },
    { start: 12, end: 130.48 },
  ]);
  assert.deepEqual(parseSpeechSegments(vadOutput([])), []);
});

test('a header that disagrees with the segments printed is not trusted', () => {
  const short = 'Detected 3 speech segments:\nSpeech segment 0: start = 0.00, end = 1.00\n';

  assert.throws(() => parseSpeechSegments(short), /unrecognised vad-speech-segments output/);
  assert.throws(
    () => parseSpeechSegments('Speech segment 0: start = 0.00, end = 1.00\n'),
    /unrecognised vad-speech-segments output/,
  );
  assert.throws(() => parseSpeechSegments(''), /unrecognised vad-speech-segments output/);
});

test('vadArgs is the flag list transcribe will pass after --vad', () => {
  const vad = {
    bin: 'vad-speech-segments',
    model: '/models/silero.bin',
    threshold: 0.7,
    minSpeechMs: 300,
    minSilenceMs: 150,
    speechPadMs: 0,
    minMusicSec: 45,
    timeoutMs: 1000,
  };

  assert.deepEqual(vadArgs(vad), [
    '--vad-model',
    '/models/silero.bin',
    '--vad-threshold',
    '0.7',
    '--vad-min-speech-duration-ms',
    '300',
    '--vad-min-silence-duration-ms',
    '150',
    '--vad-speech-pad-ms',
    '0',
  ]);
});

test('vadModelTag records every value that shaped the intervals', (t) => {
  const fake = fakeVad(t, { segments: [] });

  assert.equal(
    vadModelTag(vadConfig(fake)),
    'silero-v6.2.0.bin threshold=0.5 min_speech_ms=250 min_silence_ms=100 pad_ms=30 min_music_s=5',
  );
});

test('formatRange prints a music range as h:mm:ss', () => {
  assert.equal(formatRange(0, 65), '0:00:00-0:01:05');
  assert.equal(formatRange(3661, 7322), '1:01:01-2:02:02');
  assert.equal(formatRange(9.4, 60.4), '0:00:09-0:01:00');
});

test('vadFromEnv defaults to the values the box is set up with', () => {
  assert.deepEqual(vadFromEnv({}), {
    bin: 'vad-speech-segments',
    // No default: the model path is only needed when `segment` actually runs.
    model: null,
    threshold: 0.5,
    minSpeechMs: 250,
    minSilenceMs: 100,
    speechPadMs: 30,
    minMusicSec: 20,
    timeoutMs: 15 * 60 * 1000,
  });
});

test('vadFromEnv reads every documented key', () => {
  assert.deepEqual(
    vadFromEnv({
      AKT_VAD_BIN: '/opt/whisper/vad-speech-segments',
      AKT_VAD_MODEL: '/models/silero.bin',
      AKT_VAD_THRESHOLD: '0.7',
      AKT_VAD_MIN_SPEECH_MS: '300',
      AKT_VAD_MIN_SILENCE_MS: '150',
      AKT_VAD_SPEECH_PAD_MS: '0',
      AKT_MIN_MUSIC_SEC: '45',
    }),
    {
      bin: '/opt/whisper/vad-speech-segments',
      model: '/models/silero.bin',
      threshold: 0.7,
      minSpeechMs: 300,
      minSilenceMs: 150,
      speechPadMs: 0,
      minMusicSec: 45,
      timeoutMs: 15 * 60 * 1000,
    },
  );
});

test('a bad value in the environment is a usage error, not a failed episode', () => {
  const bad = [
    { AKT_VAD_THRESHOLD: 'loud' },
    { AKT_VAD_THRESHOLD: '-0.1' },
    { AKT_VAD_THRESHOLD: '1.5' },
    { AKT_VAD_MIN_SPEECH_MS: '-1' },
    { AKT_VAD_MIN_SPEECH_MS: '2.5' },
    { AKT_VAD_MIN_SILENCE_MS: 'soon' },
    { AKT_VAD_SPEECH_PAD_MS: '-5' },
    { AKT_MIN_MUSIC_SEC: '0' },
    { AKT_MIN_MUSIC_SEC: '-3' },
    { AKT_MIN_MUSIC_SEC: 'long' },
  ];

  for (const env of bad) {
    const why = `expected UsageError for ${JSON.stringify(env)}`;
    assert.throws(() => vadFromEnv(env), UsageError, why);
  }
});

test('detectSpeech spawns the binary with the contract argv and parses its reply', async (t) => {
  const fake = fakeVad(t, {
    segments: [
      { start: 0.32, end: 4.16 },
      { start: 12, end: 130.48 },
    ],
  });
  const vad = vadConfig(fake);
  const wav = join(tempDir(t), 'episode.wav');

  const segments = await detectSpeech(vad, wav);

  assert.deepEqual(segments, [
    { start: 0.32, end: 4.16 },
    { start: 12, end: 130.48 },
  ]);
  assert.deepEqual(fake.calls(), [
    [
      '--no-prints',
      '--vad-model',
      vad.model,
      '--vad-threshold',
      '0.5',
      '--vad-min-speech-duration-ms',
      '250',
      '--vad-min-silence-duration-ms',
      '100',
      '--vad-speech-pad-ms',
      '30',
      '--file',
      wav,
    ],
  ]);
});

test('the binary is looked up on the inherited PATH', async (t) => {
  const fake = fakeVad(t, { segments: [{ start: 0, end: 1 }] });
  const previous = process.env.PATH;
  process.env.PATH = `${fake.dir}:${previous}`;
  t.after(() => {
    process.env.PATH = previous;
  });

  const segments = await detectSpeech(vadConfig(fake, { bin: 'vad-speech-segments' }), 'x.wav');

  assert.deepEqual(segments, [{ start: 0, end: 1 }]);
});

test('an unset model path is a setup error and spawns nothing', async (t) => {
  const fake = fakeVad(t, { segments: [] });
  const vad = vadConfig(fake, { model: null });

  await assert.rejects(
    () => detectSpeech(vad, 'x.wav'),
    (err) => {
      assert.match(err.message, /AKT_VAD_MODEL/);
      assert.match(err.message, /download-vad-model\.sh silero-v6\.2\.0/);
      return true;
    },
  );
  assert.deepEqual(fake.calls(), [], 'the binary is never spawned without a model');
});

test('a model path that is not there names the file and how to fetch it', async (t) => {
  const fake = fakeVad(t, { segments: [] });
  const model = join(tempDir(t), 'silero-v6.2.0.bin');
  const vad = vadConfig(fake, { model });

  await assert.rejects(
    () => detectSpeech(vad, 'x.wav'),
    (err) => {
      assert.match(err.message, new RegExp(model.replaceAll('.', '\\.')));
      assert.match(err.message, /download-vad-model\.sh silero-v6\.2\.0/);
      assert.match(err.message, /AKT_VAD_MODEL/);
      return true;
    },
  );
  assert.deepEqual(fake.calls(), []);
});

test('a binary that is not installed names the variable that points at it', async (t) => {
  const fake = fakeVad(t, { segments: [] });
  const vad = vadConfig(fake, { bin: 'akt-no-such-vad-binary' });

  await assert.rejects(
    () => detectSpeech(vad, 'x.wav'),
    (err) => {
      assert.match(err.message, /akt-no-such-vad-binary is not on PATH/);
      assert.match(err.message, /AKT_VAD_BIN/);
      return true;
    },
  );
});

test('a non-zero exit surfaces the stderr of the binary', async (t) => {
  const fake = fakeVad(t, { segments: [], exit: 4, stderr: 'failed to load model' });
  const vad = vadConfig(fake);

  await assert.rejects(
    () => detectSpeech(vad, 'x.wav'),
    new RegExp(`${vad.bin} exited 4: failed to load model`),
  );
});

test('a hanging binary is killed at the timeout', async (t) => {
  const fake = fakeVad(t, { segments: [], sleep: 30 });
  const vad = vadConfig(fake, { timeoutMs: 1000 });

  await assert.rejects(() => detectSpeech(vad, 'x.wav'), /timed out after 1s/);
});

test('output the parser does not recognise is an error, not an empty list', async (t) => {
  const fake = fakeVad(t, { stdout: 'whisper_init_from_file: loading model\n' });

  await assert.rejects(
    () => detectSpeech(vadConfig(fake), 'x.wav'),
    /unrecognised vad-speech-segments output/,
  );
});
