# «FM Достоевский»: sources

Notes for whoever picks this up. The sources are gathered in `programs/fmd/sources/` and mapped below.
`node bin/fmd-playlists.js` rebuilds every `programs/fmd/playlists/<number>.txt` from them (offline,
deterministic; it deletes and rewrites the whole folder), plus `programs/fmd/CROSSCHECK.md` (how the
sources agree where they overlap) and `programs/fmd/MISSING.md` (what no source has): 779 playlist
files, 41 episodes missing. #701 has 5 songs, the rest talk: complete (the owner listened). `node bin/playlists.js fmd` parses
them into `docs/data/fmd.json`, like every other program's.

## Playlist files

Same layout as Svoboda's: `url:`, `date:`, `title:`, `note:` lines, a blank line, one entry per
line as the source prints it (host's notes, footers and site chrome dropped). The `note:` names the
source and says what else a reader must know: another source listing other songs, a date the
sources disagree on, an entry without a title another source has. From each episode's best source:

| Source | Files | Episodes |
|---|---|---|
| Finam pages (one from #802's print page) | 87 | #702–#820 but the 32 with no list captured; №1–№12 agree with the 2010 RSS |
| fmd.soyuz.ru | 329 | #289–#619 but #317, #375 |
| radar.lv posts | 123 | within #129–#288 |
| mp3 tags | 81 | #620–#701 but #666 (#623, #624, #633 found nowhere else) |
| the owner's list, by ear | 1 | #666 |
| the XLS | 158 | #1–#128, and 30 within #131–#375 that nothing else has |

Decided by hand (in the script, with why): radar.lv's post and CUE sheet titled #148 (8 Dec 1999)
hold the XLS's #147 and are filed as #147 (the XLS's #148 is another list, 15 Dec); #675's second
CUE sheet (`_0`) carries #674's songs and is left out. A label given as an artist's e-mail address
is left out of the entry. To add an episode found later, save its source in `programs/fmd/sources/` and
teach the script to read it: a file written by hand in `programs/fmd/playlists/` is lost on the next rebuild.

## Numbering

#1 (1997) to #820 (27.01.2013), weekly. On Финам FM from Sep 2010 the program kept a second count:
«PLAYLIST #820 (№119 по нумерации Финам.fm) от 27.01.2013.», and Finam's №1 aired 05.09.2010 (its
RSS item says so), so №N = #(N + 701) and Finam is #702–#820. The program's finam.fm page still
listed №119 as the newest in Feb 2014: #820 is the last episode.

## Sources (`programs/fmd/sources/`)

Trust, highest first: finam.fm and fmd.soyuz.ru pages (the program's own sites, original
spelling) > radar.lv's episode posts > the mp3 tags > radar.lv's CUE sheets > the XLS. The XLS is used only where
nothing else has an episode. What the cross-check found (`programs/fmd/CROSSCHECK.md`): the XLS has the same
songs in the same order as fmd.soyuz.ru in 202 of 209 episodes, and the same titles; its Russian
names and titles are in Latin letters mostly before about #100, where nothing else can check it.

- `radar.lv/fmd_up499.xls`: the export of radar.lv's dead playlist database (last saved Oct 2006),
  given by the owner. One sheet, `FMD_sorted`, columns `ID, bNum, Date, sNum, Artist, Country,
  Song, CD, Label, Comment`: 7,518 rows, 490 episodes, #1–#499 (no #187, #190–#195, #288, #317).
  `Date` is an Excel serial, set for 395 episodes from #63 (1998-01-06) on. `Comment` is the
  host's note on the track: not wanted. **Russian titles are transliterated or translated into
  English**: «NOM — Love Of An Engineer, In The Name Of Sensibility» is НОМ, «Любовь инженера»,
  «Во имя разума»; nothing finds them in that form. `fmd_up499.csv` beside it is the same sheet as
  UTF-8 CSV (dates as YYYY-MM-DD), for Node to read; the XLS stays as the original.
- `radar.lv/`: the fans' archive, https://radar.lv/fmd/archive (`archive-<page>.html`, all 30 list
  pages) and `posts.json` (298 posts: 267 are episode posts, 251 numbers, all within #129–#457, so
  they only cross-check the XLS; none fills its gaps). Every post is saved, `node-<id>.html` (UTF-8;
  `posts.json` maps each node id to its title, «FM Достоевский 353 от 27 декабря 2003 года»): 264
  with a playlist. Node 965 (#129) holds an MP3 and the list, its notes inline; node 310 is an index
  of 2005, node 1438 a request for help with missing episodes.
  **Two kinds of post**: «FM Достоевский N от <d> <month> <yyyy> года» (#129–#353) come from the
  same playlist database as the XLS (Title Case, backquotes for apostrophes, the same notes; they
  agree with it in 161 of 163 episodes), so they are not an independent witness; «ФМ Достоевский
  N от dd.mm.yyyy» (#304–#457, lower case) copy the program's own lists (they agree with
  fmd.soyuz.ru in all 103). robots.txt asks a 10 s Crawl-delay, already in `src/http.js`. Lines read
  `N. Artist (Country) "Track" CD "Album" (Label)`, followed by the host's note: `[…]` (which can
  run over a line break, or sit at the end of the entry's line) in the first kind, a bare line in
  the second. A few posts end with a P.S. on what actually aired (#152, #171, #237, #263): the
  playlist file's note quotes it. The script reads them with code.
- `radar.lv/cue/`: CUE sheets radar.lv keeps beside its episode recordings (`https://radar.lv/files/`,
  listed in its sitemap; `urls.txt` is that list): 377 sheets, 5,754 songs, for 366 episodes from #129 to #707,
  including #620–#701 but for #623, #624, #633 and #666 (the only source for that stretch). Each
  song is a track with `PERFORMER`, `TITLE` and `REM FMDALBUM <album>` (from #604; #484–#603 have
  no album; the sheets to #353 put album and label in the performer, «Artist [Album, Label]»); the
  tracks titled «(Track 03)» are the host talking, between songs. Structured, so read them with code, not
  `claude`. **Encodings are mixed**: 169 sheets are UTF-8, 208 cp1251; try UTF-8 and fall back.
  Decide the encoding per whole file: a sheet can be ASCII for its first lines and cp1251 later.
  A sheet can be partial: #607's has the first 7 of the 16 songs fmd.soyuz.ru lists (in the same
  order: the sheets never reorder). **A sheet follows the recording, not the plan**: of the 123
  sheets from #484 on that a playlist covers, 29 lack the playlist's last song and a few a middle
  one, and radar.lv's P.S. on #152 and #171 (a song replaced, a song cut) match the sheets, not the
  playlists. So a CUE-only episode (#620–#701) could lack a last song that was planned, until the mp3
  tags gave the full lists. Several episodes have more than one sheet (`_0`, `_1`…): duplicates, or timings only. #703's two sheets hold timings only, no names (Finam's RSS has the episode).
  #701's covers the whole hour but has 5 songs and long talk: the last episode on Эхо Москвы before
  Finam; the owner listened (2026-10-18): only those 5 songs, the rest talk. The recordings themselves are not used. Since the mp3 tags
  (below) came in, no playlist is taken from a CUE sheet: they cross-check.
- `owner/<number>.txt`: playlists the owner wrote down by ear for episodes no other source has, as
  they wrote them: a numbered line per song (artist, title, album, country, year, in no fixed layout), each
  followed by the record's Discogs or Apple Music page or «not on discogs», which the playlist leaves out
  (its records and years went into `overrides.json`). #666 (2026-10-18, a two-hour episode, 20 songs).
  Trusted below every other source; dated by `DATES` in the script.
- `mp3-tags/tags.json`: the playlists in a fans' collection of the program's mp3s (2026-10-17): 494
  episodes, #129–#707, each in its file's ID3 comment. Saved as number → the file's name, title, track and
  comment (the tracklist, as the file has it, with `\r\n`); the files' other tags (encoder and the like)
  are not kept, and two labels given as e-mail addresses (#474, #584) are left out. A line reads
  «1 \tArtist (Country) "Song" CD "Album" (Label)», the early years' with the host's note after a comma,
  «…(Label), (Note)», left out as elsewhere. They are radar.lv's playlist database again, as its posts
  and the XLS have it (Title Case with the notes to about #353, lower case later), but with every song's
  country and label, which the CUE sheets lack: for #620–#701, the CUE-only stretch, they have the sheets'
  songs in the same order, and in 12 episodes the song or two a sheet misses (13 songs: #621, #634, #638,
  #642, #643, #663, #674, #678, #679, #681, #683, #690).
  Ranked between radar.lv's posts and the CUE sheets. **The names slip**: the leading number is the
  episode's, not the title's «#…» («209. #206 07.03.2001.mp3» is #209; «441. #414 03.08.2005» is #441), and
  a few dates are off («#417 19.03.2006» for 2005), so their date is used only where no other source dates
  the episode (#623, #624, #633). Twice they are right where the others are not, set by hand in `DATES` in
  `bin/fmd-playlists.js`: «#595 17.08.2008» and «#596 24.08.2008», which fmd.soyuz.ru dates both 2008-08-18,
  and «#683 25.04.2010», as Эхо Москвы's listing has it, a day after the CUE sheet. #606's comment holds
  another list than fmd.soyuz.ru's (17 songs, none in common but one): the CROSSCHECK notes it, the site's is
  kept. Such a source has no page: an episode taken from it keeps its link to another source's
  (the CUE sheet's).
- `fmd.soyuz.ru/`: the program's old site, captured by the Wayback Machine: 331 pages
  `/?s=_ARCHIVE&id_playlist=<id>`, saved as `<id>.html` (raw bytes, re-fetched 2026-10-14) with
  `index.json` mapping each id to its episode. **The id is not the episode number.** They cover
  #289–#619 (21.10.2002 to 01.02.2009); #317 and #375 are not there, #350 is on two pages (ids 75
  and 76; 76 has only the first entry), and id 106 is a "not found" page. **The pages are not
  UTF-8, and not all one encoding**: ids up to 157 (#289–#419, captured from the site's first
  years) are DOS cp866, the later ones (and id 105, #374) cp1251 («Lюк (украина) "будулай" CD
  "sex"»). The script decodes each page both ways and keeps the one that reads as Russian.
  A few header dates are wrong (#289 says 21.10.2002 for 21.09; #383 16.08.2004 for 24.07): the
  script takes the other sources' date there and says so. Their header
  says the program then aired on «Эхо Москвы» 91.2 FM. Each entry is four lines: number; artist; `(country) "track" CD
  "album" (label)`; the host's one-line note (drop it). Header: `PLAYLIST #369 17.04.2004.`
- `finam.fm/`: Финам FM's pages, captured by the Wayback Machine.
  - `rss-2010.xml`: the program's feed as of Nov 2010, №1–№12 with full playlists in the item
    descriptions (№4–№6 lay them out differently: check).
  - `<id>.html` (captured around 2014) and `near-<id>.html` (captured nearest the episode's own
    date): episode pages, `/archive-view/<id>/`. Header `PLAYLIST #820 (№119 по нумерации
    Финам.fm) от 27.01.2013.`; the full list is in the HTML even where the page shows «Читать
    полностью». `items.json` maps page ids to titles and dates. «… Коллекция» items are reposts:
    skip them.
  - `broadcast-29-*.html`: the program page, captured 2010–2011; its sidebar lists the episodes
    newest at the time.
  - The pages were found by walking the captured `finam.fm/archive-view/` ids (about 38 apart a
    week) and reading each page's title; the 26 episodes in «Coverage» were never captured.
    Headers vary: «PLAYLIST #820 (№119 по нумерации Финам.fm) от 27.01.2013.» on some pages, just
    «PLAYLIST 787 22.04.2012.» on others (№86), so the number and the date are read, not the «№»;
    some pages have no header line at all (#780), and the playlist is found by its numbered
    «… CD "…"» lines. A page's print version (`/archive-view/<id>/print/`) is a separate capture:
    #802's saved the list its page lost; none exists for the episodes never captured.
- `web.archive.org/`: the Wayback index queries used (`fmd.soyuz.ru-cdx.json`,
  `finam.fm-broadcast-29-cdx.json`).
- fmd.soyuz.ru's «next program» page (`/?s=_NEXTRADIO`) shows the latest playlist on the day it was
  captured, and the site kept it up after its archive list stopped at #619. All 61 distinct captures of it, of
  the front page and of `/?s=_FRONTPAGE` (2002–2016) were read on 2026-10-18: none has a missing episode, and
  every list matches the playlist here, #620–#635 and #724–#799 included. The capture headed «PLAYLIST #311
  15.02.2003» is #310's list (a typo; the site's own #311 page is right). The site kept FMD's count into
  «Stereo Voodoo»: its «PLAYLIST #826 15.04.2013» is Voodoo's #4, so #821 is Voodoo's #1.

## Coverage

779 of the 820 episodes have a playlist in at least one source. Best source per stretch, then the rest for cross-checking:

| Episodes | Have | Missing |
|---|---|---|
| #1–#128 (1997 – 1999) | XLS only | – |
| #129–#288 (1999 – Oct 2002) | radar.lv posts and CUE sheets (original spelling), XLS | #187, #190–#195, #288 |
| #289–#619 (Oct 2002 – 01.02.2009) | fmd.soyuz.ru; radar.lv and CUE sheets in parts; XLS to #499 | #317 |
| #620–#701 (Feb 2009 – Sep 2010) | mp3 tags (with countries and labels), CUE sheets; #666 the owner's list, by ear | – |
| #702–#820 (Finam №1–№119) | Finam pages (`finam.fm/found.json` maps № to page id), the 2010 RSS; CUE sheets to #707 | never captured: #715–#720, #723 (the program page's 2011 sidebar names them, but no page was kept), #753, #754, #764, #767, #769–#771, #778, #781, #790–#794, #796, #798, #800, #801, #803, #804, #806, #807, #809, #810; #795's only capture is broken, no list (checked by the owner); #802's page is broken too, but its print version, `6765-print.html`, has the list (16 entries); #780's list has no «PLAYLIST» line at all (checked: 15 entries) |
