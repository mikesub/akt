# «FM Достоевский»: how the sources agree

Written by `node bin/fmd-playlists.js` (do not edit by hand). For every episode two or more
sources have, their lists are compared entry by entry: the same number of entries, and the
same artists in the same order (ignoring case, accents and punctuation, a leading «the», and
allowing for transliteration and small spelling differences). Titles are compared the same way
wherever the artists match. The source each playlist file uses is the highest ranked (see
programs/fmd/NOTES.md); where another source lists other songs, its `note:` says so.

## Summary

| Sources compared | Episodes | Agree | Count differs | Artists differ | Order only | Titles: same | Titles: Russian vs Latin | Titles: other |
|---|---|---|---|---|---|---|---|---|
| Finam page vs Finam 2010 RSS (#702–#713) | 12 | 12 (100%) | 0 | 0 | 0 | 100% | 0% | 0% |
| Finam page vs CUE sheet (#702, #704–#707) | 5 | 2 (40%) | 3 | 0 | 0 | 100% | 0% | 0% |
| fmd.soyuz.ru vs radar.lv post («ФМ Достоевский …», lower case) (#304–#457) | 103 | 103 (100%) | 0 | 0 | 0 | 100% | 0% | 0% |
| fmd.soyuz.ru vs radar.lv post («FM Достоевский …», Title Case) (#289–#353) | 40 | 39 (98%) | 0 | 1 | 0 | 100% | 0% | 0% |
| fmd.soyuz.ru vs CUE sheet (#289–#619) | 159 | 124 (78%) | 35 | 0 | 0 | 99% | 1% | 0% |
| fmd.soyuz.ru vs XLS (#289–#316, #318–#374, #376–#499) | 209 | 202 (97%) | 6 | 1 | 0 | 100% | 0% | 0% |
| radar.lv post («ФМ Достоевский …», lower case) vs radar.lv post («FM Достоевский …», Title Case) (#304–#352) | 15 | 15 (100%) | 0 | 0 | 0 | 100% | 0% | 0% |
| radar.lv post («FM Достоевский …», Title Case) vs CUE sheet (#129–#353) | 163 | 154 (94%) | 8 | 1 | 0 | 100% | 0% | 0% |
| radar.lv post («ФМ Достоевский …», lower case) vs CUE sheet (#304–#352) | 15 | 15 (100%) | 0 | 0 | 0 | 100% | 0% | 0% |
| fmd.soyuz.ru vs undefined (#289–#619) | 284 | 280 (99%) | 2 | 2 | 0 | 100% | 0% | 0% |
| radar.lv post («FM Достоевский …», Title Case) vs undefined (#129–#353) | 163 | 163 (100%) | 0 | 0 | 0 | 100% | 0% | 0% |
| radar.lv post («ФМ Достоевский …», lower case) vs undefined (#304–#457) | 102 | 100 (98%) | 2 | 0 | 0 | 100% | 0% | 0% |
| undefined vs CUE sheet (#129–#707) | 364 | 307 (84%) | 55 | 2 | 0 | 99% | 1% | 0% |
| undefined vs XLS (#129–#499) | 288 | 278 (97%) | 9 | 0 | 1 | 100% | 0% | 0% |
| radar.lv post («FM Достоевский …», Title Case) vs XLS (#129–#353) | 163 | 161 (99%) | 1 | 0 | 1 | 100% | 0% | 0% |
| radar.lv post («ФМ Достоевский …», lower case) vs XLS (#304–#457) | 103 | 99 (96%) | 4 | 0 | 0 | 100% | 0% | 0% |
| CUE sheet vs XLS (#129–#499) | 178 | 162 (91%) | 14 | 1 | 1 | 100% | 0% | 0% |

«Titles: Russian vs Latin» counts matched entries whose title is in Cyrillic in one source and in
Latin letters in the other: a transliteration or an English translation. «Titles: other» are
titles that differ some other way (a typo, another song by the same artist). Some examples:

- fmd.soyuz.ru vs CUE sheet: #484 «over my head» / «pull the strings»; #486 «what someone said to me» / «we will be a factory»
- undefined vs CUE sheet: #484 «over my head» / «pull the strings»
- CUE sheet vs XLS: #484 «pull the strings» / «over my head»; #486 «we will be a factory» / «what someone said to me»

## What it says

- **The radar.lv posts titled «FM Достоевский N от …» (#129–#353) and the XLS are one source, not
  two.** Both come from radar.lv's playlist database: the same Title Case, the same backquote for
  an apostrophe («Jim O`Rourke»), the same host's notes; they agree in 161 of 163 episodes.
  Their agreement says nothing about either's accuracy. The posts titled «ФМ Достоевский N от …»
  (#304–#457, lower case, notes on lines of their own) are copies of the program's own lists: they
  agree with fmd.soyuz.ru in 103 of 103 episodes.
- **The XLS is right about which songs an episode had, wherever it can be checked.** Against
  fmd.soyuz.ru (209 episodes, #289–#499) it has the same artists in the same order in 202; in
  6 it lacks one entry, in 1 the two differ by a duplicated row (#333, where every source has
  a copying slip). Every title matched, Russian ones included: in those years the XLS keeps
  Cyrillic as the site printed it. Its spelling problem is in its early years, which nothing else
  covers: there, Russian names and titles are mostly in Latin letters, transliterated or translated
  into English (НОМ's «Любовь инженера» is «Love Of An Engineer»). Rows by artists from Russia,
  Ukraine and Belarus in the XLS, by whether they are spelled in Cyrillic:

  | Episodes | Cyrillic | Latin letters only |
  |---|---|---|
  | #1–#50 | 1 | 74 |
  | #51–#100 | 12 | 29 |
  | #101–#150 | 29 | 4 |
  | #151–#200 | 20 | 2 |
  | #201–#250 | 13 | 5 |
  | #251–#300 | 7 | 2 |
  | #301–#350 | 7 | 3 |
  | #351–#400 | 2 | 5 |
  | #401–#450 | 3 | 16 |
  | #451–#499 | 17 | 6 |

  So the XLS-only episodes (#1–#128 and the few after with no other source) can be trusted for
  artists and order, less for Russian titles before about #100, which will need finding by hand.
- **CUE sheets follow the recording, not the plan.** Against fmd.soyuz.ru (159 episodes) they agree
  in 124 and never reorder; where they differ the sheet lacks songs the playlist has: mostly the
  last one (29 of the 123 sheets from #484 on that a playlist covers), sometimes one in the middle, and #607's sheet
  stops after 7 songs. Two radar.lv posts say why: «13 трэк АКТ из программы "выкинул"» (#171) and
  «Вместо заявленного в плейлисте 7 трека звучит на самом деле группа "Дочь Монро и Кеннеди"» (#152),
  both as the CUE sheets have it. So a playlist names what was planned; a song it has and the sheet
  lacks may not have aired. The CUE-only episodes (#620–#701) may in turn lack a last song that was
  planned but not aired, or not recorded.
- **fmd.soyuz.ru's pages are not all cp1251**: those of #289–#419 (page ids up to 157) are DOS
  cp866, the later ones (and id 105, #374) cp1251. The script decodes each page both ways and keeps
  the one that reads as Russian.
- **Numbering**: radar.lv's post and CUE sheet for «#148» (8 Dec 1999) hold the XLS's #147 (same
  date, same list); the XLS's #148 (15 Dec 1999) is another list, found nowhere else, and the weekly
  run (#146 on 1 Dec, #149 on 22 Dec) agrees with the XLS. They are filed as #147. radar.lv's
  second CUE sheet for #675 (`_0`) carries #675's timings but #674's songs (plus a 17th): left out.

## Copies of one source

- #350: on two fmd.soyuz.ru pages, ids 75 and 76; 14 entries in id 75 vs 1 in id 76; only in id 75: «pretty girls make graves», «arthur h», «brassy» and 10 more; id 75 used
- #618: 2 CUE sheets; 2 list the same songs
- #681: 2 CUE sheets; 2 list the same songs
- #691: 4 CUE sheets; 4 list the same songs
- #696: 2 CUE sheets; FM_Dostoevsky_N696_25.07.2010_0.cue names the songs; FM_Dostoevsky_N696_25.07.2010.cue holds timings only
- #702: 4 CUE sheets; 4 list the same songs
- #703: 2 CUE sheets; all hold timings only, no names
- FM_Dostoevsky_N675_2010.02.28_0.cue is left out: #675's second sheet: #675's timings, but the names of #674's 16 songs (as #674's own sheet has them) plus a 17th, «zakopower "kiebys ty"»

## Dates the sources disagree on

The date used is the chosen source's, unless two or more others agree on another and none on
its, or its date is out of order with the episodes either side and another source's is not. A
date a day or two off may be the day a list was posted rather than the day it aired.

- #171: date: radar.lv's «FM» post says 2000-06-16, but the CUE sheet and the XLS say 2000-06-14, which is used
- #289: date: fmd.soyuz.ru says 2002-10-21, but radar.lv's «FM» post and the CUE sheet and the XLS say 2002-09-21, which is used
- #314: date: the XLS says 2003-03-15
- #316: date: radar.lv's «FM» post and the CUE sheet and the XLS say 2003-03-29
- #318: date: fmd.soyuz.ru says 2003-04-12, but radar.lv's «FM» post and the CUE sheet and the XLS say 2003-04-05, which is used
- #324: date: fmd.soyuz.ru says 2003-05-22, but radar.lv's «FM» post and the CUE sheet and the XLS say 2003-05-24, which is used
- #326: date: the XLS says 2003-06-07
- #383: date: fmd.soyuz.ru says 2004-08-16, out of order with the episodes either side, but the XLS says 2004-07-24; 2004-07-24 is used
- #514: date: the CUE sheet says 2006-01-28
- #515: date: the CUE sheet says 2007-02-07
- #595: date: 2008-08-17, as the fans' collection names it («595. #595 17.08.2008.mp3»), a week after #594 and before #596; fmd.soyuz.ru gives 2008-08-18, a Monday, which it gives #596 too
- #596: date: 2008-08-24, as the fans' collection names it («596. #596 24.08.2008.mp3»), a week after #595 and before #597 (2008-08-31); fmd.soyuz.ru gives 2008-08-18, #595's
- #683: date: 2010-04-25, the Sunday it aired at 01:08 on Эхо Москвы (its program listing), as the fans' collection names it («683. #683 25.04.2010.mp3»); radar.lv's CUE sheet says 2010-04-24

## Episodes where the sources list different songs

The source used (first named) against each source that differs materially: another number of
entries, or an artist one has and the other has not. Differences of spelling, titles or order
alone are not listed.

- #129 (radar.lv's «FM» post): vs the XLS: 12 entries in radar.lv's «FM» post vs 13 in the XLS; only in the XLS: «Ananda Shankar & Outcaste»
- #147 (radar.lv's «FM» post): vs the CUE sheet: 14 entries in radar.lv's «FM» post vs 13 in the CUE sheet; only in radar.lv's «FM» post: «Labradford»
- #152 (radar.lv's «FM» post): vs the CUE sheet: 13 entries in both; only in radar.lv's «FM» post: «Kandia Konyate»; only in the CUE sheet: «Дочь Монро и Кеннеди»
- #168 (radar.lv's «FM» post): vs the CUE sheet: 14 entries in radar.lv's «FM» post vs 13 in the CUE sheet; only in radar.lv's «FM» post: «The JP's»
- #171 (radar.lv's «FM» post): vs the CUE sheet: 14 entries in radar.lv's «FM» post vs 13 in the CUE sheet; only in radar.lv's «FM» post: «The JP's»
- #196 (radar.lv's «FM» post): vs the CUE sheet: 14 entries in radar.lv's «FM» post vs 13 in the CUE sheet; only in radar.lv's «FM» post: «Sneakster»
- #251 (radar.lv's «FM» post): vs the CUE sheet: 14 entries in radar.lv's «FM» post vs 13 in the CUE sheet; only in radar.lv's «FM» post: «La Rionda»
- #263 (radar.lv's «FM» post): vs the CUE sheet: 15 entries in radar.lv's «FM» post vs 14 in the CUE sheet; only in radar.lv's «FM» post: «Piano Magic»
- #308 (fmd.soyuz.ru): vs the CUE sheet: 15 entries in fmd.soyuz.ru vs 14 in the CUE sheet; only in fmd.soyuz.ru: «fan club orchestra»
- #333 (fmd.soyuz.ru): vs radar.lv's «FM» post: 16 entries in both; only in fmd.soyuz.ru: «la sega del canto»; only in radar.lv's «FM» post: «Dj Me Dj You»; vs the CUE sheet: 16 entries in fmd.soyuz.ru vs 15 in the CUE sheet; only in fmd.soyuz.ru: «la sega del canto»; vs the mp3's tags: 16 entries in both; only in fmd.soyuz.ru: «la sega del canto»; only in the mp3's tags: «Dj Me Dj You»; vs the XLS: 16 entries in both; only in fmd.soyuz.ru: «la sega del canto»; only in the XLS: «dj me dj you»
- #402 (fmd.soyuz.ru): vs the mp3's tags: 16 entries in fmd.soyuz.ru vs 17 in the mp3's tags; only in the mp3's tags: «old dirty perverts»
- #403 (fmd.soyuz.ru): vs the XLS: 17 entries in fmd.soyuz.ru vs 16 in the XLS; only in fmd.soyuz.ru: «stendec»
- #405 (fmd.soyuz.ru): vs the XLS: 17 entries in fmd.soyuz.ru vs 16 in the XLS; only in fmd.soyuz.ru: «mark tranmer»
- #414 (fmd.soyuz.ru): vs the mp3's tags: 16 entries in fmd.soyuz.ru vs 17 in the mp3's tags; only in the mp3's tags: «idiots»
- #420 (fmd.soyuz.ru): vs the XLS: 17 entries in fmd.soyuz.ru vs 16 in the XLS; only in fmd.soyuz.ru: «ni ni win shwe»
- #447 (fmd.soyuz.ru): vs the XLS: 17 entries in fmd.soyuz.ru vs 16 in the XLS; only in fmd.soyuz.ru: «unknown»
- #459 (fmd.soyuz.ru): vs the XLS: 17 entries in fmd.soyuz.ru vs 16 in the XLS; only in fmd.soyuz.ru: «saing saing maw»
- #467 (fmd.soyuz.ru): vs the XLS: 17 entries in fmd.soyuz.ru vs 16 in the XLS; only in fmd.soyuz.ru: «dim dim»
- #485 (fmd.soyuz.ru): vs the CUE sheet: 16 entries in fmd.soyuz.ru vs 15 in the CUE sheet; only in fmd.soyuz.ru: «the national trust»
- #486 (fmd.soyuz.ru): vs the CUE sheet: 17 entries in fmd.soyuz.ru vs 16 in the CUE sheet; only in fmd.soyuz.ru: «avantgarde is the french word for shit», «tony strange»; only in the CUE sheet: «super reverb»
- #492 (fmd.soyuz.ru): vs the CUE sheet: 18 entries in fmd.soyuz.ru vs 17 in the CUE sheet; only in fmd.soyuz.ru: «extra golden»
- #493 (fmd.soyuz.ru): vs the CUE sheet: 17 entries in fmd.soyuz.ru vs 16 in the CUE sheet; only in fmd.soyuz.ru: «deaf center»
- #498 (fmd.soyuz.ru): vs the CUE sheet: 17 entries in fmd.soyuz.ru vs 15 in the CUE sheet; only in fmd.soyuz.ru: «je m'appelle mads & bounty niller», «wechsel garland»
- #504 (fmd.soyuz.ru): vs the CUE sheet: 17 entries in fmd.soyuz.ru vs 16 in the CUE sheet; only in fmd.soyuz.ru: «peeping tom»
- #505 (fmd.soyuz.ru): vs the CUE sheet: 16 entries in fmd.soyuz.ru vs 15 in the CUE sheet; only in fmd.soyuz.ru: «sheriff»
- #508 (fmd.soyuz.ru): vs the CUE sheet: 17 entries in fmd.soyuz.ru vs 16 in the CUE sheet; only in fmd.soyuz.ru: «trespassers william»
- #511 (fmd.soyuz.ru): vs the CUE sheet: 17 entries in fmd.soyuz.ru vs 16 in the CUE sheet; only in fmd.soyuz.ru: «etran finatawa»
- #523 (fmd.soyuz.ru): vs the CUE sheet: 17 entries in fmd.soyuz.ru vs 16 in the CUE sheet; only in fmd.soyuz.ru: «the low lows»
- #524 (fmd.soyuz.ru): vs the CUE sheet: 16 entries in fmd.soyuz.ru vs 15 in the CUE sheet; only in fmd.soyuz.ru: «xela»
- #525 (fmd.soyuz.ru): vs the CUE sheet: 17 entries in fmd.soyuz.ru vs 16 in the CUE sheet; only in fmd.soyuz.ru: «daniel smutny»
- #535 (fmd.soyuz.ru): vs the CUE sheet: 18 entries in fmd.soyuz.ru vs 17 in the CUE sheet; only in fmd.soyuz.ru: «chateau flight»
- #537 (fmd.soyuz.ru): vs the CUE sheet: 17 entries in fmd.soyuz.ru vs 16 in the CUE sheet; only in fmd.soyuz.ru: «the nelsonics»
- #552 (fmd.soyuz.ru): vs the CUE sheet: 17 entries in fmd.soyuz.ru vs 16 in the CUE sheet; only in fmd.soyuz.ru: «the bad examples»
- #554 (fmd.soyuz.ru): vs the CUE sheet: 17 entries in fmd.soyuz.ru vs 16 in the CUE sheet; only in fmd.soyuz.ru: «naomi tani»
- #556 (fmd.soyuz.ru): vs the CUE sheet: 17 entries in fmd.soyuz.ru vs 16 in the CUE sheet; only in fmd.soyuz.ru: «kumi taguchi»
- #558 (fmd.soyuz.ru): vs the CUE sheet: 17 entries in fmd.soyuz.ru vs 16 in the CUE sheet; only in fmd.soyuz.ru: «karsh kale»
- #562 (fmd.soyuz.ru): vs the CUE sheet: 17 entries in fmd.soyuz.ru vs 16 in the CUE sheet; only in fmd.soyuz.ru: «white shoes & the couples company»
- #566 (fmd.soyuz.ru): vs the CUE sheet: 17 entries in fmd.soyuz.ru vs 16 in the CUE sheet; only in fmd.soyuz.ru: «giant brain»
- #568 (fmd.soyuz.ru): vs the CUE sheet: 17 entries in fmd.soyuz.ru vs 15 in the CUE sheet; only in fmd.soyuz.ru: «montevideo», «recoil»
- #572 (fmd.soyuz.ru): vs the CUE sheet: 17 entries in fmd.soyuz.ru vs 16 in the CUE sheet; only in fmd.soyuz.ru: «the mount fuji doomjazz corporation»
- #575 (fmd.soyuz.ru): vs the CUE sheet: 17 entries in fmd.soyuz.ru vs 16 in the CUE sheet; only in fmd.soyuz.ru: «bebel gilberto»
- #582 (fmd.soyuz.ru): vs the CUE sheet: 17 entries in fmd.soyuz.ru vs 16 in the CUE sheet; only in fmd.soyuz.ru: «мумий тролль»
- #584 (fmd.soyuz.ru): vs the CUE sheet: 18 entries in fmd.soyuz.ru vs 17 in the CUE sheet; only in fmd.soyuz.ru: «сергей кротов»
- #592 (fmd.soyuz.ru): vs the CUE sheet: 17 entries in fmd.soyuz.ru vs 16 in the CUE sheet; only in fmd.soyuz.ru: «am-boy»
- #598 (fmd.soyuz.ru): vs the CUE sheet: 16 entries in fmd.soyuz.ru vs 15 in the CUE sheet; only in fmd.soyuz.ru: «singapore sling»
- #599 (fmd.soyuz.ru): vs the CUE sheet: 17 entries in fmd.soyuz.ru vs 16 in the CUE sheet; only in fmd.soyuz.ru: «yasushi yoshida»
- #600 (fmd.soyuz.ru): vs the CUE sheet: 17 entries in fmd.soyuz.ru vs 16 in the CUE sheet; only in fmd.soyuz.ru: «the whip»
- #601 (fmd.soyuz.ru): vs the CUE sheet: 17 entries in fmd.soyuz.ru vs 16 in the CUE sheet; only in fmd.soyuz.ru: «kim humphreys»
- #602 (fmd.soyuz.ru): vs the CUE sheet: 17 entries in fmd.soyuz.ru vs 16 in the CUE sheet; only in fmd.soyuz.ru: «chicha libre»
- #605 (fmd.soyuz.ru): vs the CUE sheet: 16 entries in fmd.soyuz.ru vs 15 in the CUE sheet; only in fmd.soyuz.ru: «proyecto mirage»
- #606 (fmd.soyuz.ru): vs the mp3's tags: 17 entries in both; only in fmd.soyuz.ru: «adam green», «the duke spirit», «haydamaky» and 14 more; only in the mp3's tags: «boozoo bajou feat.tony joe white», «gutevolk», «arctic monkeys» and 14 more
- #607 (fmd.soyuz.ru): vs the CUE sheet: 16 entries in fmd.soyuz.ru vs 7 in the CUE sheet; only in fmd.soyuz.ru: «sun city girls», «barbara carlotti», «the spook of the thirteenth lock» and 6 more
- #621 (the mp3's tags): vs the CUE sheet: 17 entries in the mp3's tags vs 16 in the CUE sheet; only in the mp3's tags: «max tundra»
- #634 (the mp3's tags): vs the CUE sheet: 17 entries in the mp3's tags vs 16 in the CUE sheet; only in the mp3's tags: «cinkusi i teta liza»
- #638 (the mp3's tags): vs the CUE sheet: 17 entries in the mp3's tags vs 16 in the CUE sheet; only in the mp3's tags: «Atom Tm»
- #642 (the mp3's tags): vs the CUE sheet: 17 entries in the mp3's tags vs 16 in the CUE sheet; only in the mp3's tags: «La Papa Verde»
- #643 (the mp3's tags): vs the CUE sheet: 17 entries in the mp3's tags vs 16 in the CUE sheet; only in the mp3's tags: «alamaailman vasarat»
- #663 (the mp3's tags): vs the CUE sheet: 17 entries in the mp3's tags vs 16 in the CUE sheet; only in the mp3's tags: «simian mobile disco»
- #674 (the mp3's tags): vs the CUE sheet: 17 entries in the mp3's tags vs 16 in the CUE sheet; only in the mp3's tags: «zakopower»
- #678 (the mp3's tags): vs the CUE sheet: 16 entries in the mp3's tags vs 15 in the CUE sheet; only in the mp3's tags: «karuna khyal»
- #679 (the mp3's tags): vs the CUE sheet: 17 entries in the mp3's tags vs 15 in the CUE sheet; only in the mp3's tags: «dial m for murder!», «nguyen le»
- #681 (the mp3's tags): vs the CUE sheet: 17 entries in the mp3's tags vs 16 in the CUE sheet; only in the mp3's tags: «riserva moac»
- #683 (the mp3's tags): vs the CUE sheet: 17 entries in the mp3's tags vs 16 in the CUE sheet; only in the mp3's tags: «the vampires of dartmore»
- #690 (the mp3's tags): vs the CUE sheet: 17 entries in the mp3's tags vs 16 in the CUE sheet; only in the mp3's tags: «crimson butterfly»
- #704 (the Finam page): vs the CUE sheet: 15 entries in the Finam page vs 14 in the CUE sheet; only in the Finam page: «tempelhof»
- #706 (the Finam page): vs the CUE sheet: 15 entries in the Finam page vs 14 in the CUE sheet; only in the Finam page: «tommy t feat. gigi»
- #707 (the Finam page): vs the CUE sheet: 15 entries in the Finam page vs 14 in the CUE sheet; only in the Finam page: «decoder ring»
