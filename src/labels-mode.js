import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dumpDate, labelsOf, records } from './dumps.js';

/**
 * bin/discogs-dump.js --labels: each track's Discogs release's labels
 * (`discogs_labels`, as Discogs names them), from the releases dump: a track
 * with a discogs_id gets its release's; one with a master and no release (from
 * the masters dump), the master's main release's. A track shows them only when
 * its playlist prints no label (src/labels.js). One pass over the releases
 * dump (about 18 minutes), and over the masters dump for the main releases.
 * Without --write a dry run. With --write, sets discogs_labels where they
 * differ; a release the dump lacks (merged or deleted since) leaves the track as
 * it is. With --matches <file>, the labels found are saved there, or read back
 * when it exists. `tracks` are the script's ({ program, episode, t }); `save`
 * writes changed tracks back through the pipeline.
 */
export async function labelsMode({ opts, tracks, save }) {
  const started = Date.now();
  const masterOnly = tracks.filter((x) => !x.t.discogs_id && x.t.discogs_master_id);
  let labels; // release id -> names
  let mains; // master id -> main release id
  if (opts.matches && existsSync(opts.matches)) {
    const saved = JSON.parse(readFileSync(opts.matches, 'utf8'));
    labels = new Map(saved.labels);
    mains = new Map(saved.mains);
  } else {
    const wantMasters = new Set(masterOnly.map((x) => x.t.discogs_master_id));
    mains = new Map();
    await records(opts.masters, 'master', (rec) => {
      const id = Number(rec.match(/<master id="(\d+)"/)?.[1]);
      if (!wantMasters.has(id)) return;
      const main = Number(rec.match(/<main_release>(\d+)<\/main_release>/)?.[1]);
      if (main) mains.set(id, main);
    });
    console.error(`masters: ${mains.size} main releases of ${wantMasters.size} masters, ${((Date.now() - started) / 1000).toFixed(0)} s`);
    const wanted = new Set([...tracks.map((x) => x.t.discogs_id).filter(Boolean), ...mains.values()]);
    labels = new Map();
    let seen = 0;
    const t0 = Date.now();
    await records(opts.releases, 'release', (rec) => {
      if (++seen % 2_000_000 === 0) console.error(`releases: ${seen / 1_000_000}M read, ${labels.size} of ${wanted.size} found, ${((Date.now() - t0) / 60000).toFixed(1)} min`);
      const id = Number(rec.slice(0, 40).match(/<release id="(\d+)"/)?.[1]);
      if (!wanted.has(id)) return;
      // Copied out (a JSON round trip): a substring would keep the whole record, and the dump's buffer, alive.
      labels.set(id, JSON.parse(JSON.stringify(labelsOf(rec))));
    });
    console.error(`releases: ${labels.size} of ${wanted.size} found in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
    if (opts.matches) writeFileSync(opts.matches, JSON.stringify({ labels: [...labels], mains: [...mains] }));
  }

  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const changed = new Set();
  const r = { release: 0, main: 0, missing: 0, none: 0, same: 0 };
  for (const x of tracks) {
    const release = x.t.discogs_id || (x.t.discogs_master_id && mains.get(x.t.discogs_master_id));
    if (!release) continue;
    const names = labels.get(release);
    if (!names) {
      r.missing++;
      continue;
    }
    if (names.length === 0) r.none++;
    if (same(x.t.discogs_labels, names)) {
      r.same++;
      continue;
    }
    r[x.t.discogs_id ? 'release' : 'main']++;
    if (opts.write) {
      x.t.discogs_labels = names;
      changed.add(x.t);
    }
  }
  console.error(
    `labels: ${r.release} tracks ${opts.write ? 'set' : 'to set'} from their release, ${r.main} from their master's main release, ` +
      `${r.same} unchanged; ${r.none} of a release with no label; ${r.missing} of a release not in the dump of ${dumpDate(opts.releases)}`,
  );
  if (opts.write) save(changed);
  console.error(`done in ${((Date.now() - started) / 1000).toFixed(0)} s`);
}
