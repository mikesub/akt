---
name: new-episode
description: Ingest new or edited podcast episodes into the akt archive — run the pipeline, check the parsed tracks against the episode description, list Apple Music misses, then commit, push and confirm GitHub Pages rebuilt. Use when a new «Стереоплан Троицкого» episode is out, or when the user says to ingest, update or refresh the archive.
---

# Ingest a new episode

Follow AGENTS.md throughout: work on `main`, push right after the commit, no personal contact details anywhere.

This is for «Стереоплан Троицкого» (`bin/stereoplan.js`), the one program still running. The others' playlists are files, run through `node bin/playlists.js <program>` (see README).

## 1. Start clean

```sh
git pull --ff-only && git status --short
```

Stop and ask if the tree has uncommitted changes: they are not yours to commit.

## 2. Run the pipeline

```sh
node bin/stereoplan.js
```

It fetches the feed, saves each episode's description in `programs/stereoplan/descriptions/`, sends every new or edited one to `claude` (about 20 s each), and looks each new track up on Apple Music (about 6 s a track), MusicBrainz (about 3–10 s, slower when it is busy) and Discogs (only a track both left without a year), the three side by side, saving `docs/data/stereoplan.json` as it goes. Read its output:

- `stereoplan: 90 playlists, 1 to parse, 0 tracks already parsed to look up`: how many episodes were new or edited.
- `#90: 13 tracks`: an episode parsed.
- `stereoplan: 90 playlists, 1198 tracks: 1061 on Apple Music, …`: the whole program after the run.
- `apple: 10 by search, 1 from the artist's catalog, 0 from the album, 0 by a near title, 2 not found`: how this run's matches were made.
- `musicbrainz: 9 by search, 1 through the artist, 0 by a near title, 3 not found`: the same for MusicBrainz, which gives the original release year.
- `discogs: 1 by the track, 0 by the album, 1 not found`: the tracks Discogs was asked about, for a missing year.
- Anything on stderr (`#90 musicbrainz: … HTTP 503`, `retrying in …`, `N failed; run again to retry them`) is a failure or throttling. A failed parse keeps the episode's old tracks and a failed lookup is left for the next run: run the command again; if it fails again, stop and report.

If it says `0 to parse` and nothing to look up, there is nothing new: say so and stop.

## 3. Check the result

**Only the expected episodes changed.** `git status --short` and `git diff --stat`: `docs/data/stereoplan.json` and the new episode's `programs/stereoplan/descriptions/<number>.html`. Skim `git diff docs/data/stereoplan.json`: the new episode's entry plus, at most, feed fields of others (title, duration). An existing episode's tracks changing means its description was edited upstream; mention which.

**The tracks match the description.** Print the episode's description as text and compare it with what was parsed, entry by entry (artist, title, album; same count, same order):

```sh
node --input-type=module -e "
import { fetchFeed } from './src/stereoplan.js';
const item = (await fetchFeed()).find((e) => e.number === 89);
console.log(item.description.replace(/<[^>]+>/g, '\n').replace(/\n{2,}/g, '\n'));"
jq '.[] | select(.number == 89) | .tracks' docs/data/stereoplan.json
```

`claude` copies values exactly as written, typos included; that is intended. What would be wrong: a missing or invented entry, a merged pair, the country left in the artist, the label left in the album.

**Apple Music misses:**

```sh
jq -r '.[] | select(.number == 89) | .tracks[] | select(.apple_id == null) | "\(.artist) — \(.track)"' docs/data/stereoplan.json
```

Misses are normal (about 14% overall): songs not in the Dutch store, or names Apple writes differently. List them in the report; don't fix them by hand.

Do not edit `stereoplan.json` by hand. If the parse is wrong, report it and stop: the fix belongs in `src/`, followed by `node bin/stereoplan.js --episode <number>`. A wrong year (Apple only has a reissue) is fixed in `overrides.json` with its source in `why`, then `node bin/stereoplan.js` applies it.

## 4. Commit, push, confirm the site

```sh
git add docs/data/stereoplan.json programs/stereoplan/descriptions
git commit -m "Episode #89: 13 tracks, 11 on Apple Music"
git push
```

One episode per line in the message if several were ingested; name any episode re-parsed because its description was edited. End the message with the attribution line the session asks for.

Then wait for the Pages build of that commit and check the site:

```sh
gh api repos/mikesub/akt/pages/builds/latest -q '"\(.status) \(.commit[:7])"'
curl -s https://akt.mksb.me/data/stereoplan.json | jq 'map(select(.number == 89)) | .[0].tracks | length'
```

## 5. Report

A few lines: which episodes, track counts, how many on Apple Music, the misses by name, anything odd from step 3, and the commit hash once the site serves it.
