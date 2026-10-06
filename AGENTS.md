# Agent instructions

Personal automation for one podcast («Стереоплан Троицкого»): fetch the feed, read each episode's tracklist with `claude`, publish a static site. One JSON file, one static page, run by hand on the laptop.

## What this is not

Not a product. No multi-user, no auth, no server, no re-hosting audio. If a change needs a backend or a hosted service, stop and ask.

## Hard boundaries

- Pipeline: `node bin/akt.js` fetches the feed and parses every new or edited episode. Idempotent and resumable: an episode is re-parsed only when its description changes (tracked by `description_hash`) or when asked with `--episode`. A failed episode keeps its previous tracks and is retried on the next run; it never blocks the others.
- Storage: `docs/data/episodes.json` is the only state and the only file the pipeline writes. The feed owns every episode field; `tracks` comes from `claude`. Written with stable key order and feed order, so its git diff is the regression check.
- Site: static files in `docs/`, served by GitHub Pages from `main`. No build step, no bundler. The page loads `docs/data/episodes.json` and does all search and filtering in the browser. No runtime API calls. Publishing is committing `docs/` and pushing `main`.
- LLM: the local `claude` CLI, driven only through `src/llm.js`: print mode, `--json-schema`, no tools, no MCP, cwd outside the repo. It reads the tracklist; it never invents a value the description does not contain.
- HTTP: every outgoing request goes through `src/http.js` (the approach of `../radio`'s radio-facts): a minimum gap per host from that service's published limits, `Retry-After` and rate-limit headers honoured, 429/503 and network errors retried. A new service gets its gap there, with where the limit comes from.
- No audio processing. Tracks come from the episode description only; the site links to the podcast's own MP3.
- Episodes are keyed by RSS `guid` (UUIDs in this feed). Episode numbers in feed metadata are unreliable; parse from title.
- Secrets: none are needed (the `claude` CLI uses its own login). If one ever is: env / `.env` only, never committed.
- Privacy: never send or write the owner's email or any other personal contact detail: not in User-Agent or other request headers, URLs, payloads, code, config, commits or files. No repo URL either: a User-Agent is the runtime's default or just `akt/0.1`, even where an API asks for contact details (MusicBrainz does). If one truly needs a contact, ask first.

## Working rules

- No runtime dependencies: Node stdlib only. Justify any new one in the commit message.
- Russian content is displayed as-is; UI chrome is English. Don't translate the host's notes.
- Work directly on `main`: no feature branches, no worktrees. Push to `origin/main` right after every commit.

## When unsure

Ask a one-line question with the two options you'd pick between. Don't build both.
