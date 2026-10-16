#!/usr/bin/env node
// Apple Music decade playlists in the owner's library from the data, through the
// web player's tokens in .env (APPLE_AUTHORIZATION, APPLE_MEDIA_USER_TOKEN, copied
// from music.apple.com's request headers). Unofficial and against Apple's terms
// (AGENTS.md); the tokens rotate.
//
//   node bin/applemusic.js 1980            creates «Троицкий: 1980-е», or adds what is new since the last run
//   node bin/applemusic.js 1980 --rebuild  deletes it and creates it again, in order (a new playlist id)
//
// applemusic.json keeps, per decade, the playlist's library id and every Apple id
// ever sent to it: the delta is what the data wants minus what was sent, so a
// track Apple dropped (not playable here) or stored under another id is never
// sent twice. Saved after every chunk, so a failed run is just run again.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { request } from '../src/http.js';

const REPO = join(import.meta.dirname, '..');
const MANIFEST = join(REPO, 'applemusic.json');
const API = 'https://amp-api.music.apple.com/v1';
const CHUNK = 100;

process.loadEnvFile(`${REPO}/.env`);

const decade = Number(process.argv[2]);
const rebuild = process.argv.includes('--rebuild');
if (!Number.isInteger(decade) || decade % 10) throw new Error('usage: node bin/applemusic.js <decade, e.g. 1980> [--rebuild]');

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

// What the data wants: every program's tracks of the decade with an Apple id,
// each once, by year, then air date, then place in the episode.
const rows = [];
for (const f of readdirSync(`${REPO}/docs/data`).filter((f) => f.endsWith('.json'))) {
  for (const ep of JSON.parse(readFileSync(`${REPO}/docs/data/${f}`, 'utf8'))) {
    (ep.tracks ?? []).forEach((t, i) => {
      if (t.apple_id && t.year >= decade && t.year < decade + 10) rows.push({ id: String(t.apple_id), year: t.year, date: ep.published_at ?? '', i, label: `${f.replace('.json', '')} ${ep.number} ${t.artist} — ${t.track}` });
    });
  }
}
rows.sort((a, b) => a.year - b.year || a.date.localeCompare(b.date) || a.i - b.i);
const wanted = new Map();
for (const r of rows) if (!wanted.has(r.id)) wanted.set(r.id, r.label);

let entry = manifest[decade];
if (entry && rebuild) {
  await api(`/me/library/playlists/${entry.playlist}`, { method: 'DELETE' });
  console.log(`deleted ${entry.playlist}`);
  delete manifest[decade];
  save();
  entry = undefined;
}

const sent = new Set(entry?.sent ?? []);
const delta = [...wanted.keys()].filter((id) => !sent.has(id));
console.log(`${decade}-е: ${wanted.size} tracks wanted, ${sent.size} sent before, ${delta.length} new`);
for (const id of sent) if (!wanted.has(id)) console.log(`  in the playlist, no longer wanted (remove by hand): ${id}`);

const tracks = (ids) => ids.map((id) => ({ id, type: 'songs' }));
for (let at = 0; at < delta.length; at += CHUNK) {
  const chunk = delta.slice(at, at + CHUNK);
  if (!entry) {
    const res = await api('/me/library/playlists', {
      method: 'POST',
      body: {
        attributes: { name: `Троицкий: ${decade}-е`, description: `Треки ${decade}-х из программ Артемия Троицкого, по году. akt.mksb.me` },
        relationships: { tracks: { data: tracks(chunk) } },
      },
    });
    entry = manifest[decade] = { playlist: res.data[0].id, sent: [] };
    console.log(`created «Троицкий: ${decade}-е» ${entry.playlist}`);
  } else {
    await api(`/me/library/playlists/${entry.playlist}/tracks`, { method: 'POST', body: { data: tracks(chunk) } });
  }
  entry.sent.push(...chunk);
  save();
  console.log(`  ${at + chunk.length}/${delta.length}`);
}
if (!entry) process.exit(0);

// Check: what of the wanted is not in the playlist (Apple drops what is not playable here).
const got = new Set();
let total = 0;
for (let next = `/me/library/playlists/${entry.playlist}/tracks?limit=100`; next; ) {
  const res = await api(next.replace(/^\/v1/, ''));
  for (const t of res?.data ?? []) got.add(String(t.attributes.playParams?.catalogId ?? ''));
  total += res?.data?.length ?? 0;
  next = res?.next;
}
console.log(`playlist has ${total} tracks`);
for (const [id, label] of wanted) if (!got.has(id)) console.log(`  not in the playlist: ${id} ${label}`);
