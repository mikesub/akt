---
name: new-episode
description: Ingest new or edited podcast episodes into the akt archive — run the pipeline, check the parsed tracks against the episode description, list Apple Music misses, then commit, push and confirm GitHub Pages rebuilt. Use when a new «Стереоплан Троицкого» episode is out, or when the user says to ingest, update or refresh the archive.
---

# Ingest a new episode

Follow AGENTS.md throughout: work on `main`, push right after the commit, no personal contact details anywhere.

## 1. Start clean

```sh
git pull --ff-only && git status --short
```

Stop and ask if the tree has uncommitted changes: they are not yours to commit.

## 2. Run the pipeline

```sh
node bin/akt.js
```

It fetches the feed, sends every new or edited episode's description to `claude` (about 20 s each), then looks each track up on Apple Music (3 s apart), writing `docs/data/episodes.json` after every step. Read its output:

- `88 episodes in the feed, 1 to do, doing 1`: how many episodes were new or edited.
- `#89: 13 tracks, 11 on Apple Music`: one line per episode done.
- `apple: 10 by search, 1 from the artist's catalog, 0 by a near title, 2 not found`: how the matches were made.
- Anything else on stderr (`… failed`, `retrying in …`) is a failure or throttling. A failed episode keeps its old tracks and is retried by running the command again; do that once, and stop and report if it fails again.

If it says `0 to do`, there is nothing new: say so and stop.

## 3. Check the result

**Only the expected episodes changed.** `git diff --stat docs/data/episodes.json` and skim `git diff docs/data/episodes.json`: the new episode's entry plus, at most, feed fields of others (title, duration). An existing episode's tracks changing means its description was edited upstream; mention which.

**The tracks match the description.** Print the episode's description as text and compare it with what was parsed, entry by entry (artist, title, album; same count, same order):

```sh
node --input-type=module -e "
import { fetchFeed } from './src/feed.js';
const item = (await fetchFeed()).find((e) => e.number === 89);
console.log(item.description.replace(/<[^>]+>/g, '\n').replace(/\n{2,}/g, '\n'));"
jq '.[] | select(.number == 89) | .tracks' docs/data/episodes.json
```

`claude` copies values exactly as written, typos included; that is intended. What would be wrong: a missing or invented entry, a merged pair, the country left in the artist, the label left in the album.

**Apple Music misses:**

```sh
jq -r '.[] | select(.number == 89) | .tracks[] | select(.apple_id == null) | "\(.artist) — \(.track)"' docs/data/episodes.json
```

Misses are normal (about 14% overall): songs not in the Dutch store, or names Apple writes differently. List them in the report; don't fix them by hand.

Do not edit `episodes.json` by hand. If the parse is wrong, report it and stop: the fix belongs in `src/`, followed by `node bin/akt.js --episode <guid>`.

## 4. Commit, push, confirm the site

```sh
git add docs/data/episodes.json
git commit -m "Episode #89: 13 tracks, 11 on Apple Music"
git push
```

One episode per line in the message if several were ingested; name any episode re-parsed because its description was edited. End the message with the attribution line the session asks for.

Then wait for the Pages build of that commit and check the site:

```sh
gh api repos/mikesub/akt/pages/builds/latest -q '"\(.status) \(.commit[:7])"'
curl -s https://mikesub.github.io/akt/data/episodes.json | jq 'map(select(.number == 89)) | .[0].tracks | length'
```

## 5. Report

A few lines: which episodes, track counts, how many on Apple Music, the misses by name, anything odd from step 3, and the commit hash once the site serves it.
