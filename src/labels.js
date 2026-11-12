import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { artistKey } from './artists.js';

/**
 * Each track's record labels, by name: the label its playlist prints
 * (`printed_label`, as printed), else its Discogs release's (`discogs_labels`,
 * `label_from` "discogs"), each label under one spelling. A playlist prints
 * one label many ways ("pias", "PIAS", "[PIAS]"; "Mute", "Mute Records";
 * FM Достоевский's later sources in lower case), and several in one place
 * ("Sub Pop / Bungalow", "Double six/domino"). labels.json (repo root) maps a
 * spelling, as printed or as Discogs names it, to the one to show, or to
 * several (a printed "a/b" that is two labels Discogs has under another
 * spelling), or to null (not a label: a self-release, a placeholder);
 * bin/labels.js proposes the entries and adds only spellings not in it yet,
 * so a hand edit there stays. A spelling not in it is split at "/" and kept
 * as printed, each part again through labels.json. No label (a self-release,
 * none printed and none on Discogs) is null.
 */
const FILE = join(import.meta.dirname, '..', 'labels.json');

let spellings = new Map();

/** labels.json read (again: bin/labels.js --spellings writes it, then applies it). */
export function readSpellings() {
  try {
    spellings = new Map(Object.entries(JSON.parse(readFileSync(FILE, 'utf8'))));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}
readSpellings();

/** A label's spellings share it: artistKey's, without a trailing "Records", "Recordings", "Ltd" and the like. */
export const labelKey = (name) =>
  artistKey(
    name
      .replace(/^\[(.+)\]/, '$1')
      .replace(/[\s,.]+(records?|recordings?|rec\.?|recording\s+co(mpany)?\.?|label|ltd\.?|limited|inc\.?|gmbh|llc)\.?$/i, ''),
  );

/** Not a label: a self-release, a platform, a placeholder. */
const NONE = /^(self[-\s]?(released?|release|produced|published)?|selfreleased?|self-?made|independent|indie|diy|d\.i\.y\.?|private(\s+(press|release|issue))?|no\s+label|not\s+on\s+label.*|unsigned|white\s+label|artists?'?s?\s+(own\s+)?release|eigen(release|verlag)|not\s+released|unreleased|promo|demo|промо|демо|cd-?r|none|n\/a|unknown|bandcamp|soundcloud|youtube|самиздат|независимый|без\s+лейбла|собственн(ый|ое)\s+(лейбл|издание|релиз)|сам(о)?издание|\?+|-+|\.+)$/i;

/** Whether a spelling names no label (a self-release, a placeholder): labels.json can say so too, with null. */
export const notALabel = (spelling) => !spelling || NONE.test(spelling);

/** A spelling with its quotes, a word "label" before it and its extra spaces gone. */
export const tidy = (spelling) =>
  spelling
    .replace(/^["«“„'‘](.+)["»”“'’]$/u, '$1')
    .replace(/^(label|лейбл)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();

/** A printed label's spellings: the whole, when labels.json has it, else its parts at "/" ("BMG/Mute"). */
export function printedSpellings(printed) {
  const whole = tidy(printed ?? '');
  if (!whole) return [];
  return spellings.has(whole) || notALabel(whole) ? [whole] : whole.split(/\s*\/\s*/).map(tidy).filter(Boolean);
}

/**
 * A spelling's names: labels.json's, else itself; none for what is not a label. A name labels.json maps on
 * is followed ("crammed" → "Crammed" → "Crammed Discs"), so one entry renames a label for all its spellings.
 */
function namesOf(spelling, seen = new Set()) {
  if (spellings.has(spelling) && !seen.has(spelling)) {
    const to = spellings.get(spelling);
    if (to === null) return [];
    seen.add(spelling);
    return (Array.isArray(to) ? to : [to]).flatMap((name) => (name === spelling ? [name] : namesOf(name, seen)));
  }
  return notALabel(spelling) ? [] : [spelling];
}

/** Names once each: two spellings of one label (labelKey) are one. */
function once(names) {
  const byKey = new Map();
  for (const n of names) if (!byKey.has(labelKey(n) || n)) byKey.set(labelKey(n) || n, n);
  return [...byKey.values()];
}

/** The labels a printed label names, each once, under its spelling (labels.json); empty for none (a self-release). */
export const labelNames = (printed) => once(printedSpellings(printed).flatMap((s) => namesOf(s)));

/** Discogs' names of a release's labels, without its "(2)" namesake marks and its "Not On Label" placeholders. */
export const discogsLabelNames = (names) =>
  [...new Set((names ?? []).map((n) => n.replace(/\s\(\d+\)$/, '').replace(/\*$/, '').trim()).filter((n) => !notALabel(n)))];

/**
 * A track's `label`: the names its printed label gives, a self-release none (null);
 * else, when the playlist prints none (or only a placeholder), its Discogs release's, through labels.json too.
 * Left out until the playlist was read for its label (bin/labels.js for tracks parsed before the parse read it).
 */
export function labelled(track) {
  const printed = track.printed_label;
  if (printed === undefined) return track;
  const names = labelNames(printed);
  if (names.length > 0 || (printed && !placeholder(printed))) return { ...track, label: names.length ? names : null, label_from: undefined };
  const discogs = once(discogsLabelNames(track.discogs_labels).flatMap((s) => namesOf(s)));
  if (discogs.length > 0) return { ...track, label: discogs, label_from: 'discogs' };
  return { ...track, label: null, label_from: undefined };
}

/** A printed label that only holds a place ("?", "-"): the track goes as one that prints none. */
const placeholder = (printed) => /^[\s?.\-–—]*$/.test(printed);
