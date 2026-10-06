# akt

Tracklist archive for the «Стереоплан Троицкого» podcast: fetch the feed, have `claude` read each
episode's tracklist out of its description, and publish the result as a static site.

## Prerequisites

- Node.js >= 22.13. No `npm install`: there are no dependencies.
- A logged-in `claude` CLI. Each new episode is one `claude -p` call (Opus 5.5, high effort,
  about 20 seconds).

## Run

```sh
node bin/akt.js               # parse every new or edited episode
node bin/akt.js --limit 5     # at most 5, newest first
node bin/akt.js --episode <guid>   # parse one episode again
```

Everything lands in `docs/data/episodes.json`. Review its diff, commit, push: GitHub Pages serves
`docs/`.
