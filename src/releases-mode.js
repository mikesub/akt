import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dumpDate, parseMaster, records } from './dumps.js';
import { bare, credited, main } from './match.js';
import { choose, exact, matchable, matchedArtistIds, matchReleases } from './releases.js';

/**
 * bin/discogs-dump.js --releases: the archive's tracks against the releases
 * dump (src/releases.js), a dry-run report, and with --write the ids, genres
 * and years its usage describes. `tracks` are the script's ({ program, episode,
 * aired, airYear, t }); `save` writes changed tracks back through the pipeline.
 */
export async function releasesMode({ opts, tracks, save }) {
  const started = Date.now();
  const lead = (artist) => bare(credited(main(artist ?? ''))[0] ?? '');

  // Who to match: no release yet (absent, or null: not found online); a release whose master was never recorded;
  // and, as an accuracy check only, tracks with a release and a master from the API.
  const open = (t) => t.artist && t.track && matchable(t.track) && !t.discogs_id;
  const checked = (t) => t.artist && t.track && t.discogs_id && t.discogs_master_id;
  const wanted = tracks.filter((x) => open(x.t) || checked(x.t));
  const byRelease = new Set(tracks.filter((x) => x.t.discogs_id && !('discogs_master_id' in x.t)).map((x) => x.t.discogs_id));
  const skippedTitles = tracks.filter((x) => x.t.artist && x.t.track && !x.t.discogs_id && !matchable(x.t.track)).length;

  // With --matches, the pass's matches are saved there, and read back instead of a new pass when the file exists
  // (a dry run, then --write, without reading 10 GB twice). Tracks are keyed by program, episode and place.
  const keyOf = (x) => `${x.program}|${x.episode}|${x.index}`;
  let pass;
  if (opts.matches && existsSync(opts.matches)) {
    const saved = JSON.parse(readFileSync(opts.matches, 'utf8'));
    const byKey = new Map(wanted.map((x) => [keyOf(x), x]));
    pass = { ...saved, matches: new Map(saved.matches.map(([k, v]) => [byKey.get(k), v]).filter(([x]) => x)), releasesById: new Map(saved.releasesById) };
  } else {
    pass = await matchReleases({ releasesFile: opts.releases, artistsFile: opts.artists, wanted, byRelease });
    if (opts.matches) writeFileSync(opts.matches, JSON.stringify({ ...pass, matches: [...pass.matches].map(([x, v]) => [keyOf(x), v]), releasesById: [...pass.releasesById] }));
  }
  const { matches, releasesById, seen, parsed, artistsTime, releasesTime } = pass;

  // The masters behind it all: our tracks' (for the artists they name: the namesake check), the matched releases'
  // (years for reissues, genres and titles for new ones).
  const wantMasters = new Set(tracks.map((x) => x.t.discogs_master_id).filter(Boolean));
  for (const list of matches.values()) for (const { release } of list) if (release.master) wantMasters.add(release.master);
  for (const r of releasesById.values()) if (r.master) wantMasters.add(r.master);
  const masters = new Map();
  const tm = Date.now();
  await records(opts.masters, 'master', (rec) => {
    const id = Number(rec.match(/<master id="(\d+)"/)?.[1]);
    if (wantMasters.has(id)) masters.set(id, parseMaster(rec));
  });
  const mastersTime = Date.now() - tm;
  const masterYears = new Map([...masters].map(([id, m]) => [id, m.year]));

  // The Discogs artists the archive's masters already name, per lead name (masters set by this pass included).
  const linkedNow = () => {
    const linked = new Map();
    for (const x of tracks) {
      const m = x.t.discogs_master_id && masters.get(x.t.discogs_master_id);
      if (!m) continue;
      for (const a of m.artists) if (a.id && bare(a.name) === lead(x.t.artist)) linked.set(lead(x.t.artist), new Set([...(linked.get(lead(x.t.artist)) ?? []), a.id]));
    }
    return linked;
  };

  const r = {
    unmatched: [], namesake: [], disagree: [], compilationOnly: [], releaseOnly: [], newMaster: [], noMaster: [], masterOnly: [],
    fill: [], appleReplaced: [], doubtful: [], afterAir: 0, check: { same: 0, sameMaster: 0, other: [], none: 0 },
  };
  const changed = new Set();
  const review = [];
  const COMPILATION = /\b(best of|greatest|collection|anthology|singles|complete|hits|archives?|anniversary|remaster(ed)?|deluxe)\b/i;

  // A release the API found, without its master recorded: the dump says which (null: none).
  for (const x of tracks) {
    if (!x.t.discogs_id || 'discogs_master_id' in x.t) continue;
    const rel = releasesById.get(x.t.discogs_id);
    if (!rel) continue;
    r.masterOnly.push(x);
    if (opts.write) {
      x.t.discogs_master_id = rel.master;
      const m = rel.master && masters.get(rel.master);
      if (m) Object.assign(x.t, { discogs_genres: m.genres, discogs_styles: m.styles });
      changed.add(x.t);
    }
  }

  // In rounds, when writing: a master set in one round names the Discogs artist that settles a namesake in the
  // next, so one run reaches what running it again would.
  const isCheck = new Set(wanted.filter((x) => checked(x.t)));
  const settled = new Set();
  for (let round = 0; round < 5; round++) {
  const linked = linkedNow();
  Object.assign(r, { unmatched: [], namesake: [], disagree: [], compilationOnly: [] });
  const before = settled.size;
  for (const x of wanted) {
    if (settled.has(x) || (round > 0 && isCheck.has(x))) continue;
    let list = matches.get(x);
    if (isCheck.has(x)) {
      if (!list) r.check.none++;
      else if (list.some(({ release }) => release.id === x.t.discogs_id)) r.check.same++;
      else if (choose(list, masterYears).release.master === x.t.discogs_master_id) r.check.sameMaster++;
      else r.check.other.push({ x, got: choose(list, masterYears).release });
      continue;
    }
    if (!list) {
      r.unmatched.push(x);
      continue;
    }
    // Namesakes: more than one Discogs artist of this name behind the matches, or not the one our masters name.
    const ids = matchedArtistIds(x, list);
    const ours = linked.get(lead(x.t.artist));
    if (ours && ids.size) {
      const common = [...ids].filter((id) => ours.has(id));
      if (!common.length) {
        r.namesake.push(x);
        continue;
      }
      list = list.filter(({ entryArtists }) => entryArtists.some((a) => common.includes(a.id)) || !entryArtists.some((a) => ids.has(a.id)));
    } else if (ids.size > 1) {
      r.namesake.push(x);
      continue;
    }
    if (!list.length) {
      r.namesake.push(x);
      continue;
    }

    // A track with a master already takes a release of that master only.
    const master = x.t.discogs_master_id ?? null;
    if (master) {
      const same = list.filter(({ release }) => release.master === master);
      if (!same.length) {
        r.disagree.push({ x, got: choose(list, masterYears).release });
        continue;
      }
      list = same;
    }
    const { release, year } = choose(list, masterYears, (match) => exact(x, match));
    // Only compilations have it (or "Various"): a link to one says little about the track; left to the API.
    if (!master && (release.compilation || release.artists.some((a) => a.id === 194))) {
      r.compilationOnly.push(x);
      continue;
    }
    settled.add(x);
    if (master) r.releaseOnly.push({ x, release });
    else if (release.master) r.newMaster.push({ x, release });
    else r.noMaster.push({ x, release });

    if (opts.write) {
      x.t.discogs_id = release.id;
      if (!master) {
        x.t.discogs_master_id = release.master;
        const m = release.master && masters.get(release.master);
        if (m) Object.assign(x.t, { discogs_genres: m.genres, discogs_styles: m.styles });
      }
      changed.add(x.t);
    }

    // The year, by YEAR_RANK: Discogs over Apple Music, under MusicBrainz and the owner.
    if (!year) continue;
    if (x.airYear && year > x.airYear) {
      r.afterAir++;
      continue;
    }
    const ourYear = x.t.year ?? null;
    const from = ourYear === null ? null : (x.t.year_from ?? 'apple');
    const row = (kind) => ({
      program: x.program, episode: x.episode, aired: x.aired ?? x.airYear, artist: x.t.artist, track: x.t.track, album: x.t.album,
      our_year: ourYear, year_from: from, master_id: release.master, release_id: release.id,
      master_title: masters.get(release.master)?.title ?? release.title,
      master_artists: (masters.get(release.master)?.artists ?? release.artists).map((a) => a.name).join(', '),
      master_year: year, gap: ourYear === null ? null : ourYear - year, kind,
      video_mentions_track: false, compilation_like: COMPILATION.test(release.title), after_air: false, discogs_namesake: false,
    });
    if (from === null || (from === 'apple' && year <= ourYear + 1)) {
      (from === null ? r.fill : r.appleReplaced).push({ x, from: ourYear, to: year, release });
      if (opts.write && year !== ourYear) Object.assign(x.t, { year, year_from: 'discogs' });
      else if (opts.write) x.t.year_from = 'discogs';
    } else if (from === 'apple') {
      r.doubtful.push(x);
      review.push(row('apple_earlier'));
    } else if (from === 'musicbrainz' && ourYear - year >= 2) {
      r.doubtful.push(x);
      review.push(row('release_earlier'));
    }
  }
  if (!opts.write || settled.size === before) break;
  }

  // ---------------------------------------------------------------- report
  const PROGRAMS = [...new Set(tracks.map((x) => x.program))];
  const by = (list, p) => list.filter((y) => (y.x ?? y).program === p).length;
  const line = (x) => `${x.t.artist} — «${x.t.track}» [${x.t.album ?? ''}] ${x.t.year ?? '—'} (${x.program} ${x.episode})`;
  const rel = (release) => `release ${release.id} «${release.title}» ${release.year ?? '?'}${release.master ? `, master ${release.master}` : ', no master'}${release.compilation ? ', compilation' : ''}${release.reissue ? ', reissue' : ''}`;
  const matched = [...r.releaseOnly, ...r.newMaster, ...r.noMaster];
  const step = Math.max(1, Math.floor(matched.length / 25));
  const out = [];
  out.push(`# Discogs releases dump (${dumpDate(opts.releases)}): ${opts.write ? 'written' : 'dry run'}`, '');
  out.push(`Releases read: ${seen.toLocaleString('en')}, parsed (a wanted performer): ${parsed.toLocaleString('en')}, in ${(releasesTime / 60000).toFixed(1)} min; artists dump ${(artistsTime / 1000).toFixed(0)} s; masters ${(mastersTime / 1000).toFixed(0)} s; all ${((Date.now() - started) / 60000).toFixed(1)} min.`, '');
  out.push(`Asked: ${wanted.filter((x) => open(x.t)).length} tracks without a release (${skippedTitles} more left out: titles too short or generic); ${byRelease.size} releases for their master; ${wanted.filter((x) => checked(x.t)).length} tracks with an API release and master, as a check.`, '');
  out.push('| program | matched | new master | release, no master | release of our master | unmatched | namesake | other master | compilations only |', '|---|---|---|---|---|---|---|---|---|');
  for (const p of [...PROGRAMS, null]) {
    const f = (list) => (p ? by(list, p) : list.length);
    out.push(`| ${p ?? '**all**'} | ${f(matched)} | ${f(r.newMaster)} | ${f(r.noMaster)} | ${f(r.releaseOnly)} | ${f(r.unmatched)} | ${f(r.namesake)} | ${f(r.disagree)} | ${f(r.compilationOnly)} |`);
  }
  out.push('', `Releases the API found, their master now known: ${r.masterOnly.length} (${r.masterOnly.filter((x) => releasesById.get(x.t.discogs_id)?.master).length} with a master).`);
  out.push('', '## Years', '', `- filled (we had none): ${r.fill.length}`, `- Apple Music's replaced (the Discogs year earlier, the same, or one later): ${r.appleReplaced.length} (changed: ${r.appleReplaced.filter((c) => c.to !== c.from).length})`, `- doubtful, for the owner: ${review.length} (${review.filter((x) => x.kind === 'release_earlier').length} Discogs 2+ years before MusicBrainz, ${review.filter((x) => x.kind === 'apple_earlier').length} Discogs 2+ years after Apple's)`, `- after the episode aired (ignored): ${r.afterAir}`);
  out.push('', '## Accuracy against the API', '', `Tracks with an API release and master: the dump matches the same release for ${r.check.same}, another release of the same master for ${r.check.sameMaster}, something else for ${r.check.other.length}, nothing for ${r.check.none}.`);
  for (const { x, got } of r.check.other.slice(0, 20)) out.push(`- ${line(x)}: API release ${x.t.discogs_id} / master ${x.t.discogs_master_id}; dump ${rel(got)}`);
  out.push('', `## Tracks whose dump master differs from their release matches (${r.disagree.length}, up to 20)`, '');
  for (const { x, got } of r.disagree.slice(0, 20)) out.push(`- ${line(x)}: our master ${x.t.discogs_master_id}; the title is on ${rel(got)}`);
  out.push('', '## 25 samples', '');
  for (const { x, release } of matched.filter((_, i) => i % step === 0).slice(0, 25)) out.push(`- ${line(x)} → ${rel(release)}`);
  out.push('', '## Year changes, a sample of 20', '');
  for (const c of [...r.fill, ...r.appleReplaced].filter((c) => c.to !== c.from).slice(0, 20)) out.push(`- ${line(c.x)}: ${c.from ?? '—'} → ${c.to} (${rel(c.release)})`);
  const text = `${out.join('\n')}\n`;
  if (opts.report) writeFileSync(opts.report, text);
  else process.stdout.write(text);

  if (opts.review) writeFileSync(opts.review, `${JSON.stringify(review, null, 2)}\n`);
  if (opts.write && changed.size) save(changed);
  console.error(`releases: ${matched.length} matched, ${r.unmatched.length} unmatched, ${changed.size} tracks ${opts.write ? 'written' : 'would change'}; ${((Date.now() - started) / 60000).toFixed(1)} min`);
}
