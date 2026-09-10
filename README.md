# akt

Pipeline CLI for the «Стереоплан Троицкого» podcast archive.

## Prerequisites

- Node.js >= 22.13 (`node:sqlite`, `parseArgs`)
- `ffmpeg` on `PATH` (decodes each episode to 16 kHz mono PCM WAV; override with `AKT_FFMPEG`)
- [whisper.cpp](https://github.com/ggml-org/whisper.cpp) built on this box, with `whisper-cli` and
  the `vad-speech-segments` example on `PATH` (override with `WHISPER_CLI` and `AKT_VAD_BIN`). A
  CPU build is what this pipeline expects; transcription always runs with `-ng`.

The two model files are downloaded once by hand — the pipeline never fetches them, and a missing
one is reported as an error naming the command below. From a whisper.cpp checkout, with `<akt>`
the directory holding this README:

```sh
sh ./models/download-ggml-model.sh large-v3 <akt>/models
sh ./models/download-vad-model.sh silero-v6.2.0 <akt>/models
```

Build the VAD example with `cmake --build build -j --target vad-speech-segments`. `models/` is
git-ignored; set `WHISPER_MODEL_DIR` and `AKT_VAD_MODEL` if the weights live outside the repo.

Copy `.env.example` and adjust. `akt run` is newest-first and idempotent:

```sh
akt run --limit 5
akt run --episode <guid> --step download
akt run --episode <guid> --step segment
akt run --episode <guid> --step transcribe
akt run --episode <guid> --step extract
akt run --episode <guid> --step align
```

`align` gives each track the exact second its music starts on, taken from the speech/music
boundaries `segment` found — never from the transcript text and never from a model. When the
host's Cyrillic rendering of a name is not what letter-by-letter transliteration produces
(«Битлз» for Beatles), add the artist to `synonyms.yaml`; the same groups are what the site's
search treats as one artist.

## Choosing the whisper model

There is one configured model and no automatic fallback: a fallback would spend the whole budget
before starting over with a smaller one, on every slow episode. Pick it once with a 3-minute
benchmark on a real episode's WAV:

```sh
time whisper-cli -m models/ggml-large-v3.bin -f media/<guid>.wav -l ru -ng -np -d 180000
```

An episode is about 62 minutes, of which roughly 10 are speech — `--vad` means only those are
transcribed — so multiply the measured time by about 3.5 to estimate a whole episode. If that
exceeds `WHISPER_TIMEOUT` (default 3600 seconds), set `WHISPER_MODEL=large-v3-turbo` in `.env`
once and leave it. Which model produced a transcript is recorded in `transcript.model`.
