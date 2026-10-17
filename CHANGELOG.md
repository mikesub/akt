# Data changelog

Changes to the published data, `docs/data/<program>.json` (served at `https://akt.mksb.me/data/<program>.json`),
and to the files it is built from (`overrides.json`, `titles.json`, `countries.json`), for anyone who
keeps a copy and wants to know whether to download it again. Newest first. **Format** marks a field
added, renamed or removed; **Breaking** marks a change that can break code reading the old format.
Routine updates (a new Стереоплан episode, a single fix) are not listed: the git history of
`docs/data/` has every change.

## 2026-10-17

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
