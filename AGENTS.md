# Agent instructions

Personal automation for one podcast («Стереоплан Троицкого»). One user, one Ubuntu box, one SQLite file, one static site.

## What this is not

Not a product. No multi-user, no auth, no server, no re-hosting audio. If a change needs a backend or a hosted service, stop and ask.

## Hard boundaries

- Pipeline: single CLI, runs from cron on Ubuntu, idempotent and resumable. Per-episode steps form one linear chain and each advances `episode.status` to its own state: `new → parsed → downloaded → segmented → transcribed → extracted → aligned → genred → linked → published → notified`. `prune`, `export` and `publish` are run-level steps over the whole database, not per-episode transitions. A failure must not block other episodes.
- Failure keeps `status` at the last good state and records `error` + `failed_step`. There is no `failed` status; the next run retries from where it stopped.
- `--step <step>` runs that step regardless of status and sets `status = max(status, step target)`. It never regresses an episode.
- Column ownership: every `track` column is written by exactly one step (the table lives with the schema). Rows are keyed by `(episode_guid, position)`; `parse` upserts and never wipes downstream columns.
- Storage: a sqlite db is the source of truth. The site is a pure export of it. The only files the pipeline writes into the repo are under `docs/`; nothing else it writes is tracked.
- Site: static files in `docs/`, served by GitHub Pages from `main`. No build step, no bundler, nothing from `node_modules` reaches the browser. All search is client-side over exported JSON. No runtime API calls.
- Shared code lives in `docs/lib/` as DOM-free ESM so `node:test` and the pipeline can import it. The pipeline may import from `docs/lib/`; `docs/` never imports pipeline code.
- Audio: VAD first (whisper.cpp's bundled Silero model), then local whisper.cpp on CPU over speech intervals only. Slow is fine, unattended is mandatory. No in-process ML runtimes.
- LLM: a local `claude` / `codex` CLI driven as a subprocess through one adapter, for text extraction only (tracklist repair, spoken notes, genre residue), with strict JSON schemas, cwd outside the repo and tools disabled. Never use an LLM for something a regex does reliably; never let it invent a timestamp — seconds come from audio segmentation.
- Secrets: env / `.env` only. Never committed. `.env.example` lists every key.
- Episodes are keyed by RSS `guid` (UUIDs in this feed). Episode numbers in feed metadata are unreliable; parse from title.

## Working rules

- Deterministic first, LLM fallback second. Log how often the fallback fires.
- Every pipeline step must be re-runnable on a single episode: `run --episode <guid> --step <step>`.
- The chain is only as long as the steps that have landed: `runChain` skips a step whose target the episode already outranks, so a plain run advances an episode across statuses no step owns yet (today `new → downloaded`, because no step targets `parsed`). A step that lands later but sits earlier in the chain must therefore select on work not done — `parse` on episodes with no `track` rows — or be backfilled once over the archive with `akt run --step <step>`.
- `akt run` is newest-first with `--limit`. The archive backfill is the same command run nightly, not a separate mode.
- Export must be deterministic (stable ordering) so git diffs of `docs/data/` are readable.
- Keep dependencies minimal and boring. Prefer stdlib. Justify any new dependency in the PR description.
- Russian content is displayed as-is; UI chrome is English. Don't translate the host's notes.
- Don't touch `synonyms.yaml` semantics without a test that a RU and an EN query return the same set.

## When unsure

Ask a one-line question with the two options you'd pick between. Don't build both.
