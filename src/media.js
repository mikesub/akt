import { execFile } from 'node:child_process';
import { open, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SetupError } from './errors.js';

export const DEFAULT_MEDIA_DIR = './media';

/**
 * Guids in this feed are UUIDs, so no filename sanitising is needed — the
 * shape is asserted instead, and anything else is a bug worth stopping on.
 */
export const GUID_PATTERN = /^[0-9a-f-]{36}$/;

/** A whole 55 MB enclosure over a slow line still has to fit in one attempt. */
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;

/** The 16 kHz mono PCM WAV that both `segment` and `transcribe` consume. */
const FFMPEG_ARGS = ['-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav'];

export function assertGuid(guid) {
  if (typeof guid !== 'string' || !GUID_PATTERN.test(guid)) throw new Error(`bad guid: ${guid}`);
  return guid;
}

export function mediaPaths(mediaDir, guid) {
  assertGuid(guid);
  return { mp3: join(mediaDir, `${guid}.mp3`), wav: join(mediaDir, `${guid}.wav`) };
}

/** Size of a file, or null when it does not exist. */
export async function fileSize(path) {
  try {
    return (await stat(path)).size;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * A file counts as verified only when its size equals the length the RSS
 * enclosure declares. On this feed that length is the CDN's Content-Length,
 * so a mismatch is a failure, never a silent pass.
 */
export async function isVerified(path, expectedLength) {
  return (await fileSize(path)) === expectedLength;
}

async function remove(path) {
  try {
    await unlink(path);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Fetch `url` into `dest`, following the CDN redirect, and leave the file in
 * place only once its size matches `expectedLength`. The body lands in
 * `<dest>.part` first, so an interrupted transfer can never be mistaken for a
 * complete file: an interrupted attempt is restarted from zero, which costs
 * one re-transfer and saves a second code path for 206 responses.
 */
export async function downloadMp3(fetchImpl, url, dest, expectedLength) {
  const part = `${dest}.part`;
  try {
    const res = await fetchImpl(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!res.ok) {
      await res.body?.cancel?.();
      throw new Error(`download failed: ${res.status} ${res.statusText} (${url})`);
    }
    const declared = res.headers.get('content-length');
    if (declared !== null && Number(declared) !== expectedLength) {
      await res.body?.cancel?.();
      throw new Error(`content-length ${declared}, expected ${expectedLength} (${url})`);
    }
    await writeFile(part, res.body);
    const size = await fileSize(part);
    if (size !== expectedLength) {
      throw new Error(`downloaded ${size} bytes, expected ${expectedLength} (${url})`);
    }
    await rename(part, dest);
    return size;
  } catch (err) {
    await remove(part).catch(() => {});
    throw err;
  }
}

function ffmpeg(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 4 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (!err) return resolve();
      // No ffmpeg is the box's problem, not this episode's: every other
      // episode would fail identically, so the run stops instead.
      if (err.code === 'ENOENT') {
        const where = `AKT_FFMPEG=${bin}`;
        return reject(new SetupError(`ffmpeg not found (${where}): install it, see README`));
      }
      const detail = String(stderr ?? '').trim() || err.message;
      reject(new Error(`ffmpeg exited ${err.code ?? err.signal ?? 'unknown'}: ${detail}`));
    });
  });
}

/** Decode once, next to the MP3. No later step decodes again. */
export async function decodeWav(ffmpegBin, mp3, wav) {
  const part = `${wav}.part`;
  try {
    await ffmpeg(ffmpegBin, [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      mp3,
      ...FFMPEG_ARGS,
      part,
    ]);
    await rename(part, wav);
  } catch (err) {
    await remove(part).catch(() => {});
    throw err;
  }
}

/**
 * Seconds of audio in a WAV, read from its own header.
 *
 * `segment` needs the exact length of what the VAD saw, and the feed's
 * `duration_sec` is metadata this project does not trust. ffmpeg writes a
 * LIST/INFO chunk between `fmt ` and `data`, so the chunks are walked rather
 * than a 44-byte header assumed.
 */
export async function wavDuration(path) {
  const handle = await open(path);
  try {
    const { size } = await handle.stat();
    const head = Buffer.alloc(12);
    await handle.read(head, 0, 12, 0);
    if (head.toString('latin1', 0, 4) !== 'RIFF' || head.toString('latin1', 8, 12) !== 'WAVE') {
      throw new Error(`not a RIFF/WAVE file: ${path}`);
    }

    let byteRate = null;
    let offset = 12;
    const chunk = Buffer.alloc(8);
    while (offset + 8 <= size) {
      await handle.read(chunk, 0, 8, offset);
      const id = chunk.toString('latin1', 0, 4);
      const declared = chunk.readUInt32LE(4);
      const body = offset + 8;
      if (id === 'fmt ') {
        const fmt = Buffer.alloc(16);
        await handle.read(fmt, 0, 16, body);
        byteRate = fmt.readUInt32LE(8);
      } else if (id === 'data') {
        // A streamed WAV leaves the size unwritten; the rest of the file is it.
        const bytes = declared === 0 || declared === 0xffffffff ? size - body : declared;
        if (!byteRate) throw new Error(`no fmt chunk before data in ${path}`);
        return Math.round((bytes / byteRate) * 100) / 100;
      }
      // Chunks are word-aligned: an odd size is followed by a pad byte.
      offset = body + declared + (declared % 2);
    }
    throw new Error(`no data chunk in ${path}`);
  } finally {
    await handle.close();
  }
}

/** Drop every file this step owns for one episode. Returns how many went. */
export async function removeMedia(mediaDir, guid) {
  const { mp3, wav } = mediaPaths(mediaDir, guid);
  let removed = 0;
  for (const path of [mp3, wav, `${mp3}.part`, `${wav}.part`]) {
    if (await remove(path)) removed++;
  }
  return removed;
}
