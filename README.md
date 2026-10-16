# akt

Tracklist archive for Artemy Troitsky's programs, published as one static site,
https://akt.mksb.me/. Each program's playlists are kept in the repo as their source published
them; `claude` reads each one into tracks, which are then found on Apple Music, MusicBrainz and
Discogs.

- «FM Достоевский» (1997–2013, `fmd`): rebuilt from archived copies of its sites, radar.lv's fan
  archive and its playlist database (`programs/fmd/NOTES.md`).
- Stereo Voodoo (2013–2015, `voodoo`), «Песни и пляски» and «Записки из подполья» (2016–2017,
  `pesni`, `zapiski`): from Apple's copies of their podcast feeds.
- «Музыка на Свободе» on Radio Svoboda (2017–2025, `svoboda`): the feed has no tracklists, so each
  episode's playlist comes from the end of its text article on svoboda.org.
- «Стереоплан Троицкого», the podcast (since 2025, `stereoplan`): the tracklist is in each
  episode's description in the feed.

## Prerequisites

- Node.js >= 22.13. No `npm install`: there are no dependencies.
- A logged-in `claude` CLI. Each new or edited playlist is one `claude -p` call (Opus 5.5, high
  effort, 7–20 seconds).

## Run

Every program goes through one pipeline: each new or edited playlist is parsed by `claude`, then
each track is looked up. Every program but Stereoplan keeps one file per playlist,
`programs/<program>/playlists/<number>.txt`, and one command runs any of them:

```sh
node bin/playlists.js voodoo                        # into docs/data/voodoo.json
node bin/playlists.js pesni --limit 5               # at most 5 playlists, newest first
node bin/playlists.js zapiski --episode 1 --limit 1 # playlist 1 again, and only it
node bin/playlists.js fmd --parse-only              # parse, look nothing up
node bin/playlists.js svoboda --misses              # look up again what Apple Music or MusicBrainz missed
node bin/playlists.js fmd --misses --only '`'      # only the misses whose names match the pattern
```

`--musicbrainz` asks MusicBrainz again for every track (and searches Apple Music again for each
link that looks wrong); `--relink` looks everything up again from scratch. Stereoplan's playlists
are its feed's episode descriptions, and «Музыка на Свободе» can fetch its own:

```sh
node bin/stereoplan.js        # fetch the feed, keep the descriptions in programs/stereoplan/descriptions/, run
node bin/svoboda.js --fetch   # fetch the articles in programs/svoboda/articles.txt into programs/svoboda/playlists/,
                              # and list what is missing in programs/svoboda/MISSING.md
node bin/svoboda.js           # the same run as node bin/playlists.js svoboda
```

Both take the same options. Run one program at a time: the lookups are paced per process
(`--parse-only` makes no requests, so it can run beside another). A run is resumable: interrupted,
or with failed lookups, the same command picks up where it stopped.

A Svoboda playlist found elsewhere goes in by hand as `programs/svoboda/playlists/<number>.txt`. An article
on a two-part subject carries both parts' playlists, and each gets its own file. A header's number
is sometimes wrong; such a file is renumbered by hand, by date, with a `note:` line saying why.
«FM Достоевский»'s playlists are built from its sources by `node bin/fmd-playlists.js` (see
`programs/fmd/NOTES.md`): never edit them by hand.

Each track is found on Apple Music (the link) and on MusicBrainz (the original release year);
Discogs fills a year both leave out, and `overrides.json` fixes what none gets right.
`titles.json` restores names a playlist prints in another form, such as the XLS's Russian names in
Latin letters, from the artist's own titles on MusicBrainz or elsewhere in the archive. A year after
the episode aired (a reissue's) is ignored and the track looked up again.

This application uses Discogs' API but is not affiliated with, sponsored or endorsed by Discogs.
'Discogs' is a trademark of Zink Media, LLC.

Everything lands in `docs/data/<program>.json` (`stereoplan.json`, `svoboda.json`, …); each
program's raw playlists stay in the repo too (`programs/stereoplan/descriptions/`, `programs/svoboda/playlists/`, …),
so nothing depends on a source staying online. Review the diff, commit, push: GitHub Pages
serves `docs/`.

## Thanks

A considerable part of the «FM Достоевский» archive is built on the work of the fans at
[radar.lv/fmd](https://radar.lv/fmd), who collected its playlists for years: their episode posts
and their playlist database's export. Huge thanks to them.

## License

The playlists are compiled and written by Artemy Troitsky, for his programs; the files in
`*/playlists/` and the track lists in the data copy them from where they were published
(svoboda.org, the podcast feeds, fmd.soyuz.ru and finam.fm), and remain his and their
publishers'. Neither license below covers them.

- Code: [MIT](LICENSE).
- Data (`docs/data/`, `overrides.json`, `titles.json`, `countries.json`): what was found for those
  tracks (years, links, countries), under [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/), so that MusicBrainz's genres
  (CC BY-NC-SA 3.0, whose ShareAlike allows later versions) can join it. Until 2026-10-16 it was
  CC0 1.0, and the versions published until then stay so.
