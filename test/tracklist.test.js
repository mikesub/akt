import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeDescription, parseTracklist } from '../src/tracklist.js';
import { descriptionFixtures } from './helpers.js';

/** The nine content fields the goldens pin, in report order. */
const CONTENT_FIELDS = [
  'artist',
  'country',
  'track',
  'format',
  'album',
  'label',
  'section',
  'is_cherished',
  'note_desc',
];

const DISCLAIMER =
  '*НАСТОЯЩИЙ МАТЕРИАЛ (ИНФОРМАЦИЯ) ПРОИЗВЕДЕН, РАСПРОСТРАНЕН И (ИЛИ) НАПРАВЛЕН ' +
  'ИНОСТРАННЫМ АГЕНТОМ ТРОИЦКИМ АРТЕМИЕМ КИВОВИЧЕМ, ЛИБО КАСАЕТСЯ ДЕЯТЕЛЬНОСТИ ' +
  'ИНОСТРАННОГО АГЕНТА ТРОИЦКОГО АРТЕМИЯ КИВОВИЧА (18+)';

/** The two stages as the pipeline runs them. */
function parse(html) {
  return parseTracklist(normalizeDescription(html));
}

function tracksOf(html) {
  return parse(html).tracks;
}

test('normalizeDescription turns block tags and newlines into line breaks', () => {
  assert.deepEqual(normalizeDescription('<p>one</p><p>two<br />three</p>'), [
    'one',
    'two',
    'three',
  ]);
  assert.deepEqual(normalizeDescription('<div>a</div><li>b</li><h2>c</h2>'), ['a', 'b', 'c']);
  assert.deepEqual(normalizeDescription('a\nb\r\nc'), ['a', 'b', 'c']);
});

test('normalizeDescription drops every other tag, including ones spanning a break', () => {
  assert.deepEqual(
    normalizeDescription('<b>1. Swans (USA) — «Away»</b> <br />LP BIRTHING (Mute)'),
    ['1. Swans (USA) — «Away»', 'LP BIRTHING (Mute)'],
  );
  assert.deepEqual(normalizeDescription('<p><b><br /></b>1. The Black Keys</p>'), [
    '1. The Black Keys',
  ]);
  assert.deepEqual(normalizeDescription('<a href="http://x.test/?a=1&b=2">link</a>'), ['link']);
});

test('normalizeDescription decodes named and numeric entities', () => {
  assert.deepEqual(normalizeDescription('<p>Joe Meek &amp; The Blue Men</p>'), [
    'Joe Meek & The Blue Men',
  ]);
  assert.deepEqual(normalizeDescription('<p>&lt;tag&gt; &quot;q&quot; &#39;a&#39;</p>'), [
    '<tag> "q" \'a\'',
  ]);
  assert.deepEqual(normalizeDescription('<p>&laquo;Away&raquo; &mdash; &ndash; &hellip;</p>'), [
    '«Away» — – …',
  ]);
  assert.deepEqual(normalizeDescription('<p>&#x41;&#x42;</p>'), ['AB']);
  assert.deepEqual(normalizeDescription('<p>a&nbsp;b</p>'), ['a b']);
});

test('normalizeDescription normalises spaces, zero-width marks and quote characters', () => {
  assert.deepEqual(normalizeDescription('<p>a\u00A0b\u202Fc\u2007d</p>'), ['a b c d']);
  assert.deepEqual(normalizeDescription('<p>a\u200Bb\uFEFFc</p>'), ['abc']);
  assert.deepEqual(normalizeDescription('<p>“x” „y‟</p>'), ['"x" "y"']);
  assert.deepEqual(normalizeDescription('<p>‘x’ ‚y‛</p>'), ["'x' 'y'"]);
  // «» and dashes are Russian typography and stay as written.
  assert.deepEqual(normalizeDescription('<p>«x» — y – z</p>'), ['«x» — y – z']);
});

test('normalizeDescription collapses whitespace, trims and drops empty lines', () => {
  assert.deepEqual(normalizeDescription('<p>  a\t\tb   c  </p><p><br /></p><p>d</p>'), [
    'a b c',
    'd',
  ]);
  assert.deepEqual(normalizeDescription('<p></p><p>   </p>'), []);
});

test('normalizeDescription drops the leading foreign-agent disclaimer', () => {
  assert.deepEqual(normalizeDescription(`${DISCLAIMER}<p>1. A</p>`), ['1. A']);
  assert.deepEqual(normalizeDescription(`<p>${DISCLAIMER}</p><p>1. A</p>`), ['1. A']);
  // Only the first line, and only when it is the disclaimer.
  assert.deepEqual(normalizeDescription('<p>В этом выпуске:</p><p>1. A</p>'), [
    'В этом выпуске:',
    '1. A',
  ]);
});

test('normalizeDescription returns an empty list for a missing description', () => {
  assert.deepEqual(normalizeDescription(null), []);
  assert.deepEqual(normalizeDescription(undefined), []);
  assert.deepEqual(normalizeDescription(''), []);
});

test('the newer one-line entry shape parses into every field', () => {
  const [track] = tracksOf(
    `${DISCLAIMER}<p>1. The Black Keys (USA) — «Man on a Mission» LP *NO RAIN, NO FLOWERS* (Easy Eye)</p>`,
  );
  assert.deepEqual(track, {
    position: 1,
    artist: 'The Black Keys',
    country: 'USA',
    track: 'Man on a Mission',
    format: 'LP',
    album: 'NO RAIN, NO FLOWERS',
    label: 'Easy Eye',
    section: null,
    is_cherished: false,
    note_desc: null,
    parse_warning: null,
    raw: '1. The Black Keys (USA) — «Man on a Mission» LP *NO RAIN, NO FLOWERS* (Easy Eye)',
  });
});

test('the older two-line entry shape parses into every field', () => {
  const [track] = tracksOf(
    `${DISCLAIMER}<p>В этом эпизоде:<br /><b>1. Half Japanese (USA) «That’s fate» </b><br />LP Adventure (Fire)</p>` +
      '<p>Новый (22-й) альбом американских арт-панковых примитивистов.</p>',
  );
  assert.deepEqual(track, {
    position: 1,
    artist: 'Half Japanese',
    country: 'USA',
    track: "That's fate",
    format: 'LP',
    album: 'Adventure',
    label: 'Fire',
    section: null,
    is_cherished: false,
    note_desc: 'Новый (22-й) альбом американских арт-панковых примитивистов.',
    parse_warning: null,
    raw: "1. Half Japanese (USA) «That's fate» LP Adventure (Fire)",
  });
});

test('every row carries the raw entry text the LLM fallback repairs', () => {
  const rows = tracksOf('<p>1. A (UK) — «T» LP *X* (L)</p><p>2. Некая группа без разметки</p>');
  assert.deepEqual(
    rows.map((row) => row.raw),
    ['1. A (UK) — «T» LP *X* (L)', '2. Некая группа без разметки'],
    'the fallback sends the raw line, printed number included',
  );
});

test('a two-line entry keeps both of its lines in raw', () => {
  const [track] = tracksOf(
    '<p><b>5. Lenhart Tapes (Serbia) «Vodu brala» </b><br />LP Dens (Glitterbeat)</p>',
  );
  assert.equal(track.raw, '5. Lenhart Tapes (Serbia) «Vodu brala» LP Dens (Glitterbeat)');
});

test('every observed quote style yields the same track name', () => {
  const html =
    '<p>1. A (UK) — «Track» LP *X* (L)</p>' +
    '<p>2. B (UK) — ”Track” LP *X* (L)</p>' +
    '<p>3. C (UK) — “Track” LP *X* (L)</p>';
  assert.deepEqual(
    tracksOf(html).map((row) => row.track),
    ['Track', 'Track', 'Track'],
  );
});

test('an entry with no dash between artist and track still parses', () => {
  const [track] = tracksOf('<p>1. Jenny Hval (Norway)”To be a rose” LP IRIS SILVER MIST (4AD)</p>');
  assert.equal(track.artist, 'Jenny Hval');
  assert.equal(track.country, 'Norway');
  assert.equal(track.track, 'To be a rose');
  assert.equal(track.album, 'IRIS SILVER MIST');
  assert.equal(track.label, '4AD');
  assert.equal(track.parse_warning, null);
});

test('the album marker may be starred, bare uppercase or title case', () => {
  const html =
    '<p>1. A (UK) — «T» LP *STARRED ALBUM* (L)</p>' +
    '<p>2. B (UK)”T” LP BARE ALBUM (L)</p>' +
    '<p><b>3. C (UK) «T» </b><br />LP Title Case Album (L)</p>';
  assert.deepEqual(
    tracksOf(html).map((row) => row.album),
    ['STARRED ALBUM', 'BARE ALBUM', 'Title Case Album'],
  );
});

test('an album with its own parentheses keeps them, and the label is the last group', () => {
  const [track] = tracksOf(
    '<p>4. Timo Kaukolampi (Finland) — «Last Drive for Max» LP *STRIVE (OST)* (Öm Sound)</p>',
  );
  assert.equal(track.album, 'STRIVE (OST)');
  assert.equal(track.label, 'Öm Sound');
});

test('a trailing period after the label is not part of the label', () => {
  const [track] = tracksOf(
    '<p>11. Tav Falco &amp; The Unapproachable Panther Burns (USA/France)”Conjuration of masques” LP CONJURATIONS (Stag-O-Lee).</p>',
  );
  assert.equal(track.label, 'Stag-O-Lee');
  assert.equal(track.album, 'CONJURATIONS');
});

test('LP, SP and EP are all recognised as formats and stored uppercase', () => {
  const html =
    '<p>1. A (UK) — «T» LP *X* (L)</p>' +
    '<p>2. B (UK) — «T» SP *X* (L)</p>' +
    '<p>3. C (UK) — «T» EP *X* (L)</p>' +
    '<p>4. D (UK) — «T» lp *X* (L)</p>';
  assert.deepEqual(
    tracksOf(html).map((row) => row.format),
    ['LP', 'SP', 'EP', 'LP'],
  );
});

test('LP Ibid and LP *Ibid* repeat the previous album and label', () => {
  const rows = tracksOf(
    '<p>1. Pete Seeger (USA)”The Bells of Rhymney” LP WHEN WILL THEY EVER LEARN? (Strawberry)</p>' +
      '<p>Пит Сигер (1919-2014) - первый американский фолкник.</p>' +
      '<p>2. Odetta (USA)”Long time gone” LP Ibid</p>' +
      '<p>Редкая афроамериканка среди фолк-исполнителей.</p>' +
      '<p>3. Joe Meek (UK) — «You Make Me Feel Evil» LP *Ibid*</p>' +
      '<p>Кончил Джо Мик совсем плохо.</p>',
  );
  assert.deepEqual(
    rows.map((row) => [row.album, row.label]),
    [
      ['WHEN WILL THEY EVER LEARN?', 'Strawberry'],
      ['WHEN WILL THEY EVER LEARN?', 'Strawberry'],
      ['WHEN WILL THEY EVER LEARN?', 'Strawberry'],
    ],
  );
  assert.deepEqual(
    rows.map((row) => row.parse_warning),
    [null, null, null],
  );
});

test('Ibid in the artist position repeats the previous artist', () => {
  const rows = tracksOf(
    '<p>1. Kerala Dust (UK) — «Amsterdam» LP *LIGHT, WEST* (Denature)</p>' +
      '<p>2. Ibid (UK) — «Jacobs’s Gun» LP *VIOLET DRIVE* (PIAS)</p>' +
      '<p>3. Ibid — «Echoes of Grace» LP *AN ECHO OF LOVE* (PIAS)</p>',
  );
  assert.deepEqual(
    rows.map((row) => [row.artist, row.country]),
    [
      ['Kerala Dust', 'UK'],
      ['Kerala Dust', 'UK'],
      ['Kerala Dust', 'UK'],
    ],
  );
});

test('an Ibid with nothing to inherit from is flagged, never dropped', () => {
  const rows = tracksOf('<p>1. Ibid (UK) — «T» LP *Ibid*</p>');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].position, 1);
  assert.equal(rows[0].track, 'T');
  assert.equal(rows[0].album, null);
  assert.equal(rows[0].label, null);
  assert.match(rows[0].parse_warning, /ibid_orphan/);
});

test('ft, ft. and & survive in artist names, and countries may be compound', () => {
  const rows = tracksOf(
    '<p>1. The Real Tuesday Weld ft. Oriana Curls (UK) — «Your Version of Me» LP *X* (L)</p>' +
      '<p>2. Solar X ft Lydia Kavina (UK/Russia) «Cycler» LP Divergent Sequences (Art-Tek)</p>' +
      '<p>3. Joe Meek &amp; The Blue Men (Tuva/Russia) — «I Hear a New World» LP *Y* (L)</p>',
  );
  assert.deepEqual(
    rows.map((row) => [row.artist, row.country]),
    [
      ['The Real Tuesday Weld ft. Oriana Curls', 'UK'],
      ['Solar X ft Lydia Kavina', 'UK/Russia'],
      ['Joe Meek & The Blue Men', 'Tuva/Russia'],
    ],
  );
});

test('Cyrillic artist, track and album names are stored as written', () => {
  const [track] = tracksOf(
    '<p>13. Пан Пропал Оркестр (Беларусь)”Хлопотное дельце” LP ХЛОПОТНОЕ ДЕЛЬЦЕ (ППО)</p>',
  );
  assert.equal(track.artist, 'Пан Пропал Оркестр');
  assert.equal(track.country, 'Беларусь');
  assert.equal(track.track, 'Хлопотное дельце');
  assert.equal(track.album, 'ХЛОПОТНОЕ ДЕЛЬЦЕ');
  assert.equal(track.label, 'ППО');
});

test('the first line after an entry is its commentary and covers a bare entry before it', () => {
  const rows = tracksOf(
    '<p>12. Angine de Poitrine (Canada)”Sahardnieh” LP VOL.1 (Self-released)</p>' +
      '<p>13. Angine de Poitrine (Canada)”Sarniezz” LP VOL.2 (Spectacles Bonzai)</p>' +
      '<p>Микротональный инструментальный дуэт, любимцы Тик-Тока.</p>',
  );
  assert.deepEqual(
    rows.map((row) => row.note_desc),
    [
      'Микротональный инструментальный дуэт, любимцы Тик-Тока.',
      'Микротональный инструментальный дуэт, любимцы Тик-Тока.',
    ],
  );
});

test('a second non-numbered line is a section header applying to every later entry', () => {
  const rows = tracksOf(
    '<p>1. A (UK) — «T1» LP *X* (L)</p>' +
      '<p>Комментарий к первому треку.</p>' +
      '<p>В фокусе — давнишние эксперименты лондонца Джо Мика.</p>' +
      '<p>2. B (UK) — «T2» LP *X* (L)</p>' +
      '<p>Комментарий ко второму треку.</p>' +
      '<p>3. C (UK) — «T3» LP *X* (L)</p>',
  );
  assert.deepEqual(
    rows.map((row) => row.section),
    [
      null,
      'В фокусе — давнишние эксперименты лондонца Джо Мика.',
      'В фокусе — давнишние эксперименты лондонца Джо Мика.',
    ],
  );
  assert.equal(rows[0].note_desc, 'Комментарий к первому треку.');
  assert.equal(rows[1].note_desc, 'Комментарий ко второму треку.');
});

test('a header sharing a paragraph with the commentary is still a header', () => {
  const rows = tracksOf(
    '<p><b>5. Lenhart Tapes (Serbia) «Vodu brala» </b><br />LP Dens (Glitterbeat)</p>' +
      '<p>Владимир Ленарт — электронщик из Белграда.<br /><br />Тема: Марк Алмонд — новый альбом и архивные переиздания.</p>' +
      '<p><b>6. Marc Almond (UK) «Trouble of the World» </b><br />LP I’m Not Anyone (BMG)</p>',
  );
  assert.equal(rows[0].section, null);
  assert.equal(rows[0].note_desc, 'Владимир Ленарт — электронщик из Белграда.');
  assert.equal(rows[1].section, 'Тема: Марк Алмонд — новый альбом и архивные переиздания.');
});

test('a later header replaces the previous one', () => {
  const rows = tracksOf(
    '<p>1. A (UK) — «T1» LP *X* (L)</p>' +
      '<p>Комментарий.</p>' +
      '<p>Первый разворот.</p>' +
      '<p>2. B (UK) — «T2» LP *X* (L)</p>' +
      '<p>Комментарий.</p>' +
      '<p>Второй разворот.</p>' +
      '<p>3. C (UK) — «T3» LP *X* (L)</p>',
  );
  assert.deepEqual(
    rows.map((row) => row.section),
    [null, 'Первый разворот.', 'Второй разворот.'],
  );
});

test('lines before the first entry are ignored, not treated as a header', () => {
  const rows = tracksOf(
    `${DISCLAIMER}<p><b>В этом выпуске:</b></p><p>1. A (UK) — «T» LP *X* (L)</p>`,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].section, null);
  assert.equal(rows[0].note_desc, null);
});

test('is_cherished is set by the entry line or by its commentary, case-insensitively', () => {
  const rows = tracksOf(
    '<p>1. A (UK) — «T» LP *X* (L)</p>' +
      '<p>Заветная песня: психоделический гимн из 1969 года!</p>' +
      '<p>2. B (UK) — «T» LP *X* (L)</p>' +
      '<p>Роскошная «заветная песня» из 1999 года.</p>' +
      '<p>3. C (UK) — «Заветная мелодия» LP *X* (L)</p>' +
      '<p>Обычный комментарий.</p>' +
      '<p>4. D (UK) — «T» LP *X* (L)</p>' +
      '<p>Ничего особенного.</p>',
  );
  assert.deepEqual(
    rows.map((row) => row.is_cherished),
    [true, true, true, false],
  );
});

test('an unnumbered episode still yields one row per entry with ordinal positions', () => {
  const rows = tracksOf(
    `${DISCLAIMER}<p>В этом выпуске сфокусируемся на лейбле Dallas — крупнейшем «независимом» в бывшей Югославии.</p>` +
      '<p><b>DECISIVE PINK (Russia/USA) «Destiny» LP TICKET TO FAME (Fire)</b><br />Дебют дуэта.</p>' +
      '<p><b>LET 3 (Croatia) «Mama ŠČ!» EP MAMA ŠČ (Dallas)</b><br />Конкурс «Евровидение».</p>',
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => [row.position, row.artist, row.track, row.format]),
    [
      [1, 'DECISIVE PINK', 'Destiny', 'LP'],
      [2, 'LET 3', 'Mama ŠČ!', 'EP'],
    ],
  );
  assert.equal(rows[0].note_desc, 'Дебют дуэта.');
});

test('position is the ordinal, and a printed number that disagrees is flagged', () => {
  const rows = tracksOf(
    '<p>1. A (UK) — «T» LP *X* (L)</p><p>3. B (UK) — «T» LP *X* (L)</p><p>4. C (UK) — «T» LP *X* (L)</p>',
  );
  assert.deepEqual(
    rows.map((row) => row.position),
    [1, 2, 3],
  );
  assert.equal(rows[0].parse_warning, null);
  assert.match(rows[1].parse_warning, /number_mismatch/);
  assert.match(rows[2].parse_warning, /number_mismatch/);
});

test('an unparseable entry still produces a row with a position, best-effort text and a warning', () => {
  const rows = tracksOf(
    '<p>1. A (UK) — «T» LP *X* (L)</p><p>2. Некая группа без всякой разметки</p><p>3. C (UK) — «T» LP *X* (L)</p>',
  );
  assert.equal(rows.length, 3, 'no entry is ever dropped');
  assert.equal(rows[1].position, 2);
  assert.equal(rows[1].artist, 'Некая группа без всякой разметки');
  assert.equal(rows[1].track, null);
  assert.equal(rows[1].parse_warning, 'no_track,no_country,no_format,no_album,no_label');
});

test('parseTracklist counts warned rows and is deterministic on empty input', () => {
  const result = parse(
    '<p>1. A (UK) — «T» LP *X* (L)</p><p>2. Некая группа</p><p>Ещё одна строка комментария.</p>',
  );
  assert.equal(result.tracks.length, 2, 'the last line is commentary, not an entry');
  assert.equal(result.warned, 1);
  assert.deepEqual(parseTracklist([]), { tracks: [], warned: 0 });
  assert.deepEqual(parseTracklist(normalizeDescription(null)), { tracks: [], warned: 0 });
});

test('a description with no tracklist yields no tracks', () => {
  assert.deepEqual(parse(`${DISCLAIMER}<p>Разговор без треклиста</p>`), { tracks: [], warned: 0 });
});

test('the checked-in fixtures parse at 95% field accuracy or better', (t) => {
  const fixtures = descriptionFixtures();
  assert.ok(fixtures.length >= 10, `expected at least 10 fixtures, got ${fixtures.length}`);

  const score = Object.fromEntries(CONTENT_FIELDS.map((field) => [field, { hit: 0, total: 0 }]));
  const mismatches = [];

  for (const fixture of fixtures) {
    const { tracks } = parse(fixture.html);
    const want = fixture.expected.tracks;
    assert.equal(tracks.length, want.length, `${fixture.name}: expected ${want.length} entries`);
    assert.deepEqual(
      tracks.map((row) => row.position),
      want.map((row) => row.position),
      `${fixture.name}: positions`,
    );
    for (const [index, expected] of want.entries()) {
      const got = tracks[index];
      for (const field of CONTENT_FIELDS) {
        score[field].total++;
        if ((got[field] ?? null) === (expected[field] ?? null)) {
          score[field].hit++;
        } else {
          mismatches.push(
            `${fixture.name} #${expected.position} ${field}: expected ${JSON.stringify(
              expected[field] ?? null,
            )}, got ${JSON.stringify(got[field] ?? null)}`,
          );
        }
      }
    }
  }

  let hit = 0;
  let total = 0;
  for (const field of CONTENT_FIELDS) {
    hit += score[field].hit;
    total += score[field].total;
    const { hit: fieldHit, total: fieldTotal } = score[field];
    t.diagnostic(
      `${field.padEnd(12)} ${((fieldHit / fieldTotal) * 100).toFixed(1).padStart(5)}%  ` +
        `(${fieldHit}/${fieldTotal})`,
    );
  }
  for (const line of mismatches) t.diagnostic(`mismatch: ${line}`);
  const overall = hit / total;
  const percent = `${(overall * 100).toFixed(1)}%`;
  t.diagnostic(
    `${'overall'.padEnd(12)} ${percent.padStart(6)}  (${hit}/${total}) over ${fixtures.length} fixtures`,
  );

  assert.ok(overall >= 0.95, `field accuracy ${(overall * 100).toFixed(1)}% is below 95%`);
});
