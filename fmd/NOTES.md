# «FM Достоевский»: sources

Notes for whoever picks this up. The sources are gathered in `fmd/sources/` and mapped below.
`node bin/fmd-playlists.js` rebuilds every `fmd/playlists/<number>.txt` from them (offline,
deterministic; it deletes and rewrites the whole folder), plus `fmd/CROSSCHECK.md` (how the
sources agree where they overlap) and `fmd/MISSING.md` (what no source has): 775 playlist
files, 45 episodes missing, one possibly incomplete (#701). `node bin/playlists.js fmd` parses
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
| CUE sheets | 78 | #620–#701 but #623, #624, #633, #666 |
| the XLS | 158 | #1–#128, and 30 within #131–#375 that nothing else has |

Decided by hand (in the script, with why): radar.lv's post and CUE sheet titled #148 (8 Dec 1999)
hold the XLS's #147 and are filed as #147 (the XLS's #148 is another list, 15 Dec); #675's second
CUE sheet (`_0`) carries #674's songs and is left out. A label given as an artist's e-mail address
is left out of the entry. To add an episode found later, save its source in `fmd/sources/` and
teach the script to read it: a file written by hand in `fmd/playlists/` is lost on the next rebuild.

## Numbering

#1 (1997) to #820 (27.01.2013), weekly. On Финам FM from Sep 2010 the program kept a second count:
«PLAYLIST #820 (№119 по нумерации Финам.fm) от 27.01.2013.», and Finam's №1 aired 05.09.2010 (its
RSS item says so), so №N = #(N + 701) and Finam is #702–#820. The program's finam.fm page still
listed №119 as the newest in Feb 2014: #820 is the last episode.

## Sources (`fmd/sources/`)

Trust, highest first: finam.fm and fmd.soyuz.ru pages (the program's own sites, original
spelling) > radar.lv's episode posts > radar.lv's CUE sheets > the XLS. The XLS is used only where
nothing else has an episode. What the cross-check found (`fmd/CROSSCHECK.md`): the XLS has the same
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
  playlists. So a CUE-only episode (#620–#701) may lack a last song that was planned; its note says
  so. Several episodes have more than one sheet (`_0`, `_1`…): duplicates, or timings only. #703's two sheets hold timings only, no names (Finam's RSS has the episode).
  #701's covers the whole hour but has 5 songs and long talk: the last show before Finam, maybe
  a farewell; the owner may check by ear. The recordings themselves are not used.
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

## Coverage

775 of the 820 episodes have a playlist in at least one source. Best source per stretch, then the rest for cross-checking:

| Episodes | Have | Missing |
|---|---|---|
| #1–#128 (1997 – 1999) | XLS only | – |
| #129–#288 (1999 – Oct 2002) | radar.lv posts and CUE sheets (original spelling), XLS | #187, #190–#195, #288 |
| #289–#619 (Oct 2002 – 01.02.2009) | fmd.soyuz.ru; radar.lv and CUE sheets in parts; XLS to #499 | #317 |
| #620–#701 (Feb 2009 – Sep 2010) | CUE sheets only | #623, #624, #633, #666 |
| #702–#820 (Finam №1–№119) | Finam pages (`finam.fm/found.json` maps № to page id), the 2010 RSS; CUE sheets to #707 | never captured: #715–#720, #723 (the program page's 2011 sidebar names them, but no page was kept), #753, #754, #764, #767, #769–#771, #778, #781, #790–#794, #796, #798, #800, #801, #803, #804, #806, #807, #809, #810; #795's only capture is broken, no list (checked by the owner); #802's page is broken too, but its print version, `6765-print.html`, has the list (16 entries); #780's list has no «PLAYLIST» line at all (checked: 15 entries) |
