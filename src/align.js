import { fold } from '../docs/lib/translit.js';

/**
 * Deciding which song each track is, from the audio's own boundaries.
 *
 * The segmentation gives a list of music intervals; every one of them has a
 * lead-in, the speech between the end of the previous song and its own start.
 * A transcript segment in that lead-in is exactly «a mention whose first
 * following music interval is this one», which is what the issue asks for, so
 * name matches, `intro_segment` and the equal-count diagonal all become
 * evidence on (track, interval) pairs. A small dynamic programme then picks
 * the best strictly increasing assignment, which is where the monotonicity
 * constraint is enforced: it is not a repair afterwards, it is the only shape
 * of answer this function can produce.
 *
 * Nothing here returns a second. The answer is an index into the music
 * intervals, and only the step turns that into `start_sec`, so no code path
 * can invent a timestamp that is not a boundary the VAD found.
 */

/** A form has to match a segment this well to count as naming the track. */
export const STRONG = 0.8;

/** Below this a candidate is noise rather than a weaker match. */
export const WEAK = 0.6;

/**
 * Shorter forms are matched as whole words — «оса» is not in «колбаса» — and
 * on their own never carry a match past `medium`: a word that short is as
 * likely to be ordinary speech as a name.
 */
export const MIN_FUZZY_LEN = 5;

/** A mention this close to the song counts as announcing it. */
export const NEAR_SEC = 45;

/**
 * What each kind of evidence is worth to the assignment, and what it says
 * about the result. The weights are hand-tuned and only their order matters:
 * a name at the boundary beats a name spoken far from it, which beats the
 * bare fact that the counts line up.
 */
const KINDS = {
  nameNear: { weight: 4, evidence: 'name', confidence: 'high' },
  nameFar: { weight: 3, evidence: 'name', confidence: 'medium' },
  nameWeak: { weight: 2, evidence: 'name', confidence: 'medium' },
  intro: { weight: 2, evidence: 'intro', confidence: 'medium' },
  diagonal: { weight: 1, evidence: 'order', confidence: 'low' },
};

/** Ties are broken by this order, so the answer never depends on input order. */
const PRIORITY = ['nameNear', 'nameFar', 'nameWeak', 'intro', 'diagonal'];

/** Every name that could be spoken for a track: artist, title, and aliases. */
export function nameForms(track, synonyms = null) {
  const forms = new Set();
  const add = (value) => {
    const folded = fold(value);
    if (folded !== '') forms.add(folded);
  };

  add(track.artist);
  add(track.track);
  for (const alias of synonyms?.get(fold(track.artist)) ?? []) add(alias);

  return [...forms];
}

/** Whether `form` occurs in `text` as a whole word rather than inside one. */
function containsWord(text, form) {
  let at = text.indexOf(form);
  while (at !== -1) {
    const before = at === 0 || text[at - 1] === ' ';
    const after = at + form.length === text.length || text[at + form.length] === ' ';
    if (before && after) return true;
    at = text.indexOf(form, at + 1);
  }
  return false;
}

/**
 * Sellers' approximate substring search, anchored to the starts of words: the
 * fewest edits turning `pattern` into a stretch of `text` that begins one.
 *
 * The textbook version lets a match start anywhere, and at these lengths that
 * is too generous — «роадс» (Roads) is two edits from the «равс» buried in
 * «здравствуйте», which is enough to call a greeting a song. A name is spoken
 * as a word, so only a word start is free here; the end stays free, which is
 * what lets a Russian case ending hang off the back of a matched name.
 */
function anchoredDistance(pattern, text) {
  let previous = Array.from({ length: pattern.length + 1 }, (_, index) => index);
  let current = new Array(pattern.length + 1);
  // The text itself begins a word, so a match that consumes none of it costs
  // no more than deleting the pattern.
  let best = pattern.length;

  for (let column = 1; column <= text.length; column++) {
    current[0] = text[column - 1] === ' ' ? 0 : Number.POSITIVE_INFINITY;
    for (let row = 1; row <= pattern.length; row++) {
      const cost = pattern[row - 1] === text[column - 1] ? 0 : 1;
      current[row] = Math.min(previous[row] + 1, current[row - 1] + 1, previous[row - 1] + cost);
    }
    if (current[pattern.length] < best) best = current[pattern.length];
    [previous, current] = [current, previous];
  }
  return best;
}

/**
 * How well a folded name matches folded speech, in [0, 1]. Whisper mishears a
 * letter and the transliteration is approximate to begin with, so this is an
 * edit distance from a word the host said rather than an equality — except for
 * short forms, where one edit is most of the word and only a whole word will
 * do.
 */
export function matchScore(form, text) {
  const pattern = String(form ?? '');
  const haystack = String(text ?? '');
  if (pattern === '' || haystack === '') return 0;
  if (pattern.length < MIN_FUZZY_LEN) return containsWord(haystack, pattern) ? 1 : 0;
  return Math.max(0, 1 - anchoredDistance(pattern, haystack) / pattern.length);
}

function cell(kind, score) {
  return { kind, score, ...KINDS[kind] };
}

/** The better of two candidates for the same pair, or the only one there is. */
function stronger(current, candidate) {
  if (current === null) return candidate;
  if (candidate.weight !== current.weight) {
    return candidate.weight > current.weight ? candidate : current;
  }
  if (candidate.kind !== current.kind) {
    return PRIORITY.indexOf(candidate.kind) < PRIORITY.indexOf(current.kind) ? candidate : current;
  }
  return candidate.score > current.score ? candidate : current;
}

/** The music interval a segment is the lead-in to, or -1 for none. */
function leadIn(segment, music) {
  for (const [index, interval] of music.entries()) {
    const from = index === 0 ? Number.NEGATIVE_INFINITY : music[index - 1].end;
    if (segment.end > from && segment.end <= interval.start) return index;
  }
  return -1;
}

/** One row of evidence per track, one column per music interval. */
function evidenceMatrix(tracks, segments, music, synonyms) {
  const spoken = segments.map((segment) => ({
    lead: leadIn(segment, music),
    text: fold(segment.text),
    end: segment.end,
  }));
  // The count match: with as many songs as tracks, being the i-th of each is
  // itself evidence, weak enough for any real mention to override it.
  const counted = tracks.length === music.length;

  return tracks.map((track, position) => {
    const forms = nameForms(track, synonyms);
    const row = new Array(music.length).fill(null);

    for (const [index, segment] of spoken.entries()) {
      if (segment.lead === -1) continue;
      let score = 0;
      // A form too short to be matched fuzzily is also too short to be sure
      // of. «Кино» is one of the most played bands in this feed and the
      // ordinary word for films, «Дом» and «Ночь» are titles and everyday
      // nouns, and nothing here can tell the two apart — so a hit on one is
      // evidence, but only a form long enough to be a name on its own can
      // carry it to `high`.
      let distinctive = 0;
      for (const form of forms) {
        const hit = matchScore(form, segment.text);
        score = Math.max(score, hit);
        if (form.length >= MIN_FUZZY_LEN) distinctive = Math.max(distinctive, hit);
      }
      if (score >= WEAK) {
        const near = music[segment.lead].start - segment.end <= NEAR_SEC;
        const named = distinctive >= STRONG;
        const kind = !named ? 'nameWeak' : near ? 'nameNear' : 'nameFar';
        row[segment.lead] = stronger(row[segment.lead], cell(kind, score));
      }
      // The fallback from issue 6: a segment the extraction already decided
      // introduces this track, whether or not it names it.
      if (index === track.intro_segment) {
        row[segment.lead] = stronger(row[segment.lead], cell('intro', score));
      }
    }

    if (counted) row[position] = stronger(row[position], cell('diagonal', 0));
    return row;
  });
}

/**
 * The strictly increasing assignment with the most evidence behind it.
 *
 * Ties go to assigning over skipping an interval, and to skipping an interval
 * over skipping a track, which is what keeps the answer deterministic when
 * two readings are equally supported.
 */
function bestAssignment(matrix, trackCount, musicCount) {
  const total = Array.from({ length: trackCount + 1 }, () => new Array(musicCount + 1).fill(0));
  const choice = Array.from({ length: trackCount + 1 }, () => new Array(musicCount + 1).fill(null));

  for (let track = trackCount - 1; track >= 0; track--) {
    for (let interval = musicCount - 1; interval >= 0; interval--) {
      const evidence = matrix[track][interval];
      // Only a pair with evidence is ever assigned here: order alone is left
      // to the gap fill below, which knows it is guessing.
      const assign = evidence === null ? -1 : evidence.weight + total[track + 1][interval + 1];
      const skipInterval = total[track][interval + 1];
      const skipTrack = total[track + 1][interval];

      let best = assign;
      let taken = 'assign';
      if (skipInterval > best) {
        best = skipInterval;
        taken = 'interval';
      }
      if (skipTrack > best) {
        best = skipTrack;
        taken = 'track';
      }
      total[track][interval] = best;
      choice[track][interval] = taken;
    }
  }

  const assigned = [];
  let track = 0;
  let interval = 0;
  while (track < trackCount && interval < musicCount) {
    const taken = choice[track][interval];
    if (taken === 'assign') {
      assigned.push([track, interval]);
      track++;
      interval++;
    } else if (taken === 'interval') {
      interval++;
    } else {
      track++;
    }
  }
  return assigned;
}

/**
 * Tracks with no evidence, between two that have some: when the songs left
 * free are exactly as many as the tracks left over, there is only one order
 * they can be in. Anything less certain than that stays unplaced.
 */
function fillGaps(placements, musicCount) {
  let lastTrack = -1;
  let lastInterval = -1;

  for (let index = 0; index <= placements.length; index++) {
    if (index < placements.length && placements[index].interval === null) continue;

    const waiting = index - lastTrack - 1;
    const from = lastInterval + 1;
    const until = index === placements.length ? musicCount : placements[index].interval;
    if (waiting > 0 && until - from === waiting) {
      for (let step = 0; step < waiting; step++) {
        const placement = placements[lastTrack + 1 + step];
        placement.interval = from + step;
        placement.confidence = KINDS.diagonal.confidence;
        placement.evidence = KINDS.diagonal.evidence;
      }
    }
    if (index < placements.length) {
      lastTrack = index;
      lastInterval = placements[index].interval;
    }
  }
}

/**
 * Place every track on a music interval, or on none. Pure and deterministic:
 * the same tracklist, transcript and segmentation always give the same list of
 * `{ position, interval, confidence, evidence }`.
 */
export function alignTracks({ tracks = [], segments = [], intervals = [], synonyms = null } = {}) {
  const placements = tracks.map((track) => ({
    position: track.position,
    interval: null,
    confidence: null,
    evidence: null,
  }));
  const music = intervals.filter((interval) => interval.label === 'music');
  if (placements.length === 0 || music.length === 0) return placements;

  const matrix = evidenceMatrix(tracks, segments, music, synonyms);
  for (const [track, interval] of bestAssignment(matrix, tracks.length, music.length)) {
    const evidence = matrix[track][interval];
    placements[track].interval = interval;
    placements[track].confidence = evidence.confidence;
    placements[track].evidence = evidence.evidence;
  }
  fillGaps(placements, music.length);

  return placements;
}
