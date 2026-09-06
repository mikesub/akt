# Agent instructions
 
Personal automation for one podcast («Стереоплан Троицкого»). One user, one Ubuntu box, one SQLite file, one static site.
 
## What this is not
 
Not a product. No multi-user, no auth, no server, no re-hosting audio. If a change needs a backend or a hosted service, stop and ask.
 
## Hard boundaries
 
- Pipeline: single CLI, runs from cron on Ubuntu, idempotent and resumable. Every step advances `episode.status`; a failure must not block other episodes.
- Storage: a sqlite db is the source of truth. The site is a pure export of it.
- Site: static files on GitHub Pages. All search is client-side over exported JSON. No runtime API calls.
- Transcription: local Whisper on CPU. Slow is fine, unattended is mandatory.
- LLM: API calls allowed for extraction/alignment only, with strict JSON schemas. Never use an LLM for something a regex does reliably; never let it invent a timestamp — seconds come from audio segmentation.
- Secrets: env / `.env` only. Never committed. `.env.example` lists every key.
- Episodes are keyed by RSS `guid`. Episode numbers in feed metadata are unreliable; parse from title.
 
## Working rules
 
- Deterministic first, LLM fallback second. Log how often the fallback fires.
- Every pipeline step must be re-runnable on a single episode: `run --episode <guid> --step <step>`.
- Export must be deterministic (stable ordering) so git diffs of `site/data/` are readable.
- Keep dependencies minimal and boring. Prefer stdlib. Justify any new dependency in the PR description.
- Russian content is displayed as-is; UI chrome is English. Don't translate the host's notes.
- Don't touch `synonyms.yaml` semantics without a test that a RU and an EN query return the same set.
 
## When unsure
 
Ask a one-line question with the two options you'd pick between. Don't build both.
