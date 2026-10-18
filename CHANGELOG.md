# Data changelog

Changes to the published data, `docs/data/<program>.json` (served at `https://akt.mksb.me/data/<program>.json`),
and to the files it is built from (`overrides.json`, `titles.json`, `artists.json`, `countries.json`), for anyone who
keeps a copy and wants to know whether to download it again. Newest first. **Format** marks a field
added, renamed or removed; **Breaking** marks a change that can break code reading the old format.
Routine updates (a new Стереоплан episode, a single fix) are not listed: the git history of
`docs/data/` has every change.

## 2026-10-18

- Years: 449 tracks (440 `overrides.json` entries) take the year of a Discogs release that has the track, 2+ years
  before MusicBrainz's (a later release's or compilation's), from the releases dump's track-level matches (and one,
  Hazy Osterwald Sextet's «Kriminal Tango», the owner's 1959 already set for the band's other spelling); the
  doubtful matches (compilations, namesakes, live, session, remix or re-recorded versions, misdated releases) wait
  for the owner's review, and a Discogs year 2+ years after Apple's keeps Apple's. In the data from each program's
  next run (or `node bin/countries.js --recode`).
- **Format:** `year_from` keeps its values, but `discogs` can now also come from `overrides.json`: an override
  sets `year_from` to `owner` unless the entry names its own source (here `discogs`, a Discogs year settled by the
  owner's rule rather than found by the owner). Such a year, like the owner's, wins over every lookup.
- 17,740 tracks in every program matched to a Discogs release offline, from Discogs' CC0 releases dump of
  2026-10-01, by track title and artist (`bin/discogs-dump.js --releases`): `discogs_id` set on each (none was
  overwritten), `discogs_master_id` on 6,492 that had none (3,265 a master, with its `discogs_genres` and
  `discogs_styles`; 3,227 `null`, the release having no master), and on 751 releases the API had found. Years:
  120 tracks without one got the earliest Discogs year, 152 Apple years changed to an earlier (or the same, or a
  year later) Discogs year, 741 more Apple years now marked `discogs`; MusicBrainz's and the owner's untouched. 563
  doubtful cases wait for the owner (a Discogs release 2+ years before MusicBrainz's year, or 2+ after Apple's).
- **Format:** a new track field after `year`, `year_from`: where the year comes from, `musicbrainz`, `discogs`,
  `apple` or `owner` (an `overrides.json` year); absent when `year` is null. Every year has one: 17,113 MusicBrainz,
  1,666 Discogs, 1,607 Apple Music, 390 the owner's; 1,070 tracks have no year (as of this entry).
- Years: Apple Music's year now counts only when no other source has one (it is often a reissue's or a
  compilation's); the order is the owner's, MusicBrainz's, Discogs's, Apple's. 175 years changed in a pass over
  every track with a Discogs master (from the masters dump of 2026-10-01, by artist and album): 102 tracks that had
  no year got their master's, 64 Apple years became their master's (earlier, or one year later), 6 Discogs release
  years became their master's, 3 by the owner's review. Another 428 Apple years were the master's too and are now
  marked `discogs`. 143 doubtful cases wait for the owner (MusicBrainz 2+ years after the master, Apple 2+ years
  before it, or a doubtful match).
- **Format:** two new track fields, after `discogs_master_id`, on every track that has one (11,984 in every program):
  `discogs_genres` and `discogs_styles`, the Discogs master's genres and styles as Discogs names them, in its
  order (`["Electronic", "Rock"]`, `["Downtempo", "Leftfield"]`). Two independent lists: Discogs links no style to a
  genre. Album-level: a track gets its record's. `discogs_styles` can be `[]`; a track with no master has neither
  key. CC0, from Discogs' masters dump of 2026-10-01. The CSV has `discogs_genres` and `discogs_styles` columns,
  each joined with "; ".
- `discogs_master_id` set for 11,973 tracks in every program, from Discogs' CC0 masters dump of 2026-10-01
  (data.discogs.com), matched offline by lead artist and album title (`bin/discogs-dump.js`): one master, or
  the lowest of Discogs' duplicates of the same record (same artists, same year); never a "Various"
  compilation's, and never over a master the track had. Album-level: the master of the album as the
  playlist prints it, which may be a later compilation of the artist's; no year or other field changed.
  Such a track may have a `discogs_master_id` and no `discogs_id`.

## 2026-10-17

- **Format:** `discogs_master_id`, after `discogs_id`: the Discogs master of the track's release (the record across
  its editions, `https://www.discogs.com/master/<id>`; its year is the first edition's), `null` when the release
  has none, and no key until Discogs has been asked. Filled as `discogs_id` is, and for releases found before
  by the same backfill. The CSV (`«Скачать CSV»`) has a `discogs_master_url` column after `discogs_url`.
  11 set by hand now (`overrides.json`).
- Artists' spellings normalized: 7,293 tracks in every program now show their artist under one spelling,
  the artist's own (Apple Music's credit, else the archive's), where the playlists printed it in lower or
  upper case, with other spacing or punctuation, without accents, or with or without "The"; 1,128 of
  them more than case. The playlist files keep the spellings as printed. New file `artists.json`, the
  printed spelling to the one shown. For 339 renamed tracks a lookup that had found nothing was dropped,
  to be asked again under the new name (`apple_id`, `mb_id` or `discogs_id` key missing until then).
  Three tracks' inferred countries changed with the merged spellings (Ногу свело!, Кино).
- **Format:** `discogs_id` (a Discogs release, `https://www.discogs.com/release/<id>`) is now looked up for
  every track, as `apple_id` and `mb_id` are; it was only asked for a track Apple Music and MusicBrainz left
  without a year. New tracks get it as they come; the rest of the archive is filled over a day or two
  (`--discogs`), so until then most tracks have no `discogs_id` key at all (not asked yet), as before.
  A Discogs year still counts only when the other two have none. 10 ids set by hand (`overrides.json`).
- **Format:** `country` can hold three codes outside ISO 3166-1, for territories no state is recognized
  for: `X-TIBET`, `X-KURDISTAN`, `X-UYGHURISTAN`. A playlist's "Tibet", "Kurdistan" and "Uighuristan"
  gave no code before. 15 tracks, in every program but `zapiski.json`.
- `country_from` is now left out when `overrides.json` sets the country, as it always should have been:
  11 tracks in `svoboda.json` had `"musicbrainz"` beside a country MusicBrainz never gave.
- About 30 more tracks have a country, set by hand in `overrides.json` from the owner's word or
  MusicBrainz's credits, or inferred once a joke country ("magic land", "milky way", "stimorol") counts as
  none: Svoboda's Ukrainian special of 2022-03-20, Captain Beefheart, Nick Cave & The Bad Seeds, This
  Immortal Coil, Tinariwen, Alan Vega & Panasonic, Orchestra Baobab, Rachid Taha, Stimmhorn.
- «FM Достоевский»: 3 new playlists, #623, #624 and #633, found nowhere before (778 of 820 episodes now,
  42 missing). The playlists of #620–#701 now come from a fans' collection's mp3 tags instead of radar.lv's
  CUE sheets: the same songs, now with every song's country and label (`printed_country` set for all
  1,337 tracks there, where the CUE sheets printed none, so far fewer inferred countries), and 13 songs the
  sheets missed in 12 episodes. Tracks with the same artist, title and album kept their links and years.
  `fmd.json` changed; `countries.json` has 5 more spellings.

## 2026-10-16

- A track whose playlist prints only "Europe" or a placeholder (`"?"`, `"..."`) gets its artist's
  country as one that prints none does: `country_from` can now be set beside a `printed_country`.
  Legendary Pink Dots' "Europe" (#46) is now `NL`, `GB`, as its other episodes print. 10 tracks in
  `fmd.json`, `svoboda.json`, `zapiski.json`; one "(Same)" in `pesni.json` set by hand (`overrides.json`).
- `country` can hold `EU` (ISO 3166-1's reserved code), for a playlist's own "Europe" or "EU": 8 tracks
  in `fmd.json`, `null` before.
- **Format:** three new track fields, after `album`:
  - `printed_country`: the artist's country as the playlist prints it, `"UK/USA"`, `"РФ"`, `"czech rep."`;
    `null` when it prints none.
  - `country`: that country as codes, a list: ISO 3166-1 alpha-2 (`["GB", "US"]`), with `GB-WLS` and
    `GB-NIR` for Wales and Northern Ireland, and former states by their ISO 3166-3 alpha-2 codes (`SU`
    the USSR, `CS` Czechoslovakia, `YU` Yugoslavia, `DD` East Germany, `VD` South Vietnam). `null`
    when unknown, or when what is printed names no single country (`"International"`, `"Kurdistan"`,
    `"Tibet"`). A region is its country (`"Тува"` is `RU`).
  - `country_from`: only on a track whose playlist prints no country: `"archive"` when the codes are
    the ones its artist has most often elsewhere in the archive, `"musicbrainz"` when they are its
    credited artists' countries on MusicBrainz (with `country` `null`: MusicBrainz was asked and
    found nothing certain).

  21,424 of 21,783 tracks have a country: 20,356 as printed, 487 from the archive, 581 from
  MusicBrainz. All six files changed. `countries.json` maps every printed spelling to its codes.
- **License:** the data, `overrides.json`, `titles.json` and `countries.json` are now
  [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/), so that MusicBrainz's genres
  (CC BY-NC-SA 3.0) can join them later. Until this date they were CC0 1.0, and copies made before stay
  CC0.
- «FM Достоевский»: Russian names its early sources print in Latin letters (transliterated or
  translated) restored, from the artists' own releases (`titles.json`), and their tracks looked up
  again under them. `fmd.json` changed.
- «FM Достоевский» added: `fmd.json`, 775 playlists, #1–#820.
- First version: `voodoo.json`, `pesni.json`, `zapiski.json`, `svoboda.json`, `stereoplan.json`.
  Each file is a list of episodes, newest first. An episode has `number`, `title`, `published_at`,
  `url`, `playlist_hash` and `tracks` (Стереоплан's also `guid`, `mp3_url`, `duration_sec`). A track
  has `artist`, `track`, `album`, `apple_id`, `apple_album_id`, `apple_artist_id`, `mb_id`,
  `discogs_id` and `year`; a source's id is missing until that source was asked, and `null` when it
  found nothing.
