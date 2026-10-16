#!/usr/bin/env node
// Apple Music decade playlists in the owner's library from the data, through the
// web player's tokens in .env (APPLE_AUTHORIZATION, APPLE_MEDIA_USER_TOKEN, copied
// from music.apple.com's request headers). Unofficial and against Apple's terms
// (AGENTS.md); the tokens rotate.
//
//   node bin/applemusic.js                    every playlist: creates it, or adds what is new since the last run
//   node bin/applemusic.js 1980 2020          only those
//   node bin/applemusic.js 1980 --rebuild     deletes it and creates it again, in order (a new playlist id)
//
// applemusic.json keeps, per playlist, its library id, name and description, and
// every Apple id ever sent to it: the delta is what the data wants minus what was
// sent, so a track Apple dropped (not playable here) or stored under another id
// is never sent twice. Saved after every chunk, so a failed run is just run again.
// A changed name or description is set on the playlist in place.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { request } from '../src/http.js';

const REPO = join(import.meta.dirname, '..');
const MANIFEST = join(REPO, 'applemusic.json');
const API = 'https://amp-api.music.apple.com/v1';
const CHUNK = 100;

/**
 * A playlist per decade from the 1960s, and one for everything before (1930s–1950s,
 * nothing older in the data). The names are the owner's («AKT.1960s», «AKT.1930-50s»).
 */
const PLAYLISTS = [
  { key: '1930', from: 0, to: 1959, name: 'AKT.1930-50s', label: '1930–1950-е' },
  ...[1960, 1970, 1980, 1990, 2000, 2010, 2020].map((d) => ({ key: String(d), from: d, to: d + 9, name: `AKT.${d}s`, label: `${d}-е` })),
].map((p) => ({ ...p, description: `${p.label} из программ Артемия Троицкого. https://akt.mksb.me` }));

const args = process.argv.slice(2);
const rebuild = args.includes('--rebuild');
const keys = args.filter((a) => !a.startsWith('--'));
const unknown = keys.filter((k) => !PLAYLISTS.some((p) => p.key === k));
if (unknown.length) throw new Error(`no such playlist: ${unknown.join(', ')} (have ${PLAYLISTS.map((p) => p.key).join(', ')})`);
if (rebuild && !keys.length) throw new Error('--rebuild needs the playlists named');

process.loadEnvFile(`${REPO}/.env`);
const auth = process.env.APPLE_AUTHORIZATION?.replace(/^Bearer\s+/i, '');
const mut = process.env.APPLE_MEDIA_USER_TOKEN;
if (!auth || !mut) throw new Error(`${REPO}/.env needs APPLE_AUTHORIZATION and APPLE_MEDIA_USER_TOKEN`);
const headers = { Authorization: `Bearer ${auth}`, 'Media-User-Token': mut, Origin: 'https://music.apple.com', Referer: 'https://music.apple.com/' };

async function api(path, opts = {}) {
  try {
    return await request(`${API}${path}`, { ...opts, headers });
  } catch (err) {
    if (/HTTP 40[13]/.test(err.message)) throw new Error(`${err.message}: the tokens have likely expired, copy them again from music.apple.com into .env`);
    throw err;
  }
}

const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : {};
const save = () => writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);

// Every program's tracks with an Apple id and a year, by year, then air date, then place in the episode.
const rows = [];
for (const f of readdirSync(join(REPO, 'docs', 'data')).filter((f) => f.endsWith('.json'))) {
  for (const ep of JSON.parse(readFileSync(join(REPO, 'docs', 'data', f), 'utf8'))) {
    (ep.tracks ?? []).forEach((t, i) => {
      if (t.apple_id && t.year) rows.push({ id: String(t.apple_id), year: t.year, date: ep.published_at ?? '', i, label: `${f.replace('.json', '')} ${ep.number} ${t.artist} — ${t.track}` });
    });
  }
}
rows.sort((a, b) => a.year - b.year || a.date.localeCompare(b.date) || a.i - b.i);

const tracks = (ids) => ids.map((id) => ({ id, type: 'songs' }));

/** The catalog ids in a library playlist, and how many tracks it has. */
async function contents(playlist) {
  const ids = new Set();
  let total = 0;
  for (let next = `/me/library/playlists/${playlist}/tracks?limit=100`; next; ) {
    const res = await api(next.replace(/^\/v1/, ''));
    for (const t of res?.data ?? []) ids.add(String(t.attributes.playParams?.catalogId ?? ''));
    total += res?.data?.length ?? 0;
    next = res?.next;
  }
  return { ids, total };
}

async function sync(p) {
  const wanted = new Map();
  for (const r of rows) if (r.year >= p.from && r.year <= p.to && !wanted.has(r.id)) wanted.set(r.id, r.label);

  let entry = manifest[p.key];
  if (entry && rebuild) {
    await api(`/me/library/playlists/${entry.playlist}`, { method: 'DELETE' });
    console.log(`deleted ${entry.playlist}`);
    delete manifest[p.key];
    save();
    entry = undefined;
  }
  if (entry && (entry.name !== p.name || entry.description !== p.description)) {
    await api(`/me/library/playlists/${entry.playlist}`, { method: 'PATCH', body: { attributes: { name: p.name, description: p.description } } });
    Object.assign(entry, { name: p.name, description: p.description });
    save();
    console.log(`renamed ${entry.playlist} to ${p.name}`);
  }

  const sent = new Set(entry?.sent ?? []);
  const delta = [...wanted.keys()].filter((id) => !sent.has(id));
  console.log(`${p.name}: ${wanted.size} tracks wanted, ${sent.size} sent before, ${delta.length} new`);
  for (const id of sent) if (!wanted.has(id)) console.log(`  in the playlist, no longer wanted (remove by hand): ${id}`);

  for (let at = 0; at < delta.length; at += CHUNK) {
    const chunk = delta.slice(at, at + CHUNK);
    if (!entry) {
      const res = await api('/me/library/playlists', {
        method: 'POST',
        body: { attributes: { name: p.name, description: p.description }, relationships: { tracks: { data: tracks(chunk) } } },
      });
      entry = manifest[p.key] = { playlist: res.data[0].id, name: p.name, description: p.description, sent: [] };
      console.log(`  created ${p.name} ${entry.playlist}`);
    } else {
      try {
        await api(`/me/library/playlists/${entry.playlist}/tracks`, { method: 'POST', body: { data: tracks(chunk) } });
      } catch (err) {
        // Apple answers a 500 now and then after the tracks went in: if any of the chunk
        // is there, it all was (what is missing, Apple dropped), so go on without adding
        // it twice; else stop, and the next run sends it again.
        const { ids } = await contents(entry.playlist);
        if (!chunk.some((id) => ids.has(id))) throw err;
        console.error(`  ${err.message}, but the tracks went in`);
      }
    }
    entry.sent.push(...chunk);
    save();
    console.log(`  ${at + chunk.length}/${delta.length}`);
  }
  if (!entry) return;

  // Check: what of the wanted is not in the playlist (Apple drops what is not playable here).
  const { ids: got, total } = await contents(entry.playlist);
  console.log(`  the playlist has ${total} tracks`);
  for (const [id, label] of wanted) if (!got.has(id)) console.log(`  not in the playlist: ${id} ${label}`);
}

for (const p of PLAYLISTS) if (!keys.length || keys.includes(p.key)) await sync(p);
