# akt

Pipeline CLI for the «Стереоплан Троицкого» podcast archive.

## Prerequisites

- Node.js >= 22.13 (`node:sqlite`, `parseArgs`)
- `ffmpeg` on `PATH` (decodes each episode to 16 kHz mono PCM WAV; override with `AKT_FFMPEG`)

Copy `.env.example` and adjust. `akt run` is newest-first and idempotent:

```sh
akt run --limit 5
akt run --episode <guid> --step download
```
