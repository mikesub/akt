import { fileSize, mediaPaths } from '../media.js';
import { transcribeWav } from '../whisper.js';

const UPSERT = `
INSERT INTO transcript (episode_guid, segments, model) VALUES (?, ?, ?)
ON CONFLICT(episode_guid) DO UPDATE SET segments = excluded.segments, model = excluded.model`;

/**
 * Transcribe one episode's speech into timestamped Russian segments.
 *
 * The WAV is whatever `download` decoded — nothing here decodes again — and
 * the speech/music decision is whisper.cpp's own VAD, so the seconds stored
 * are episode seconds that `align` can trust. Which model produced them is
 * recorded alongside, because the user may switch to `large-v3-turbo` on a
 * box that cannot finish an episode in the budget.
 */
export const transcribe = {
  name: 'transcribe',
  target: 'transcribed',
  async run(ctx, row) {
    const { wav } = mediaPaths(ctx.mediaDir, row.guid);
    if ((await fileSize(wav)) === null) {
      throw new Error(`${row.guid}: no wav at ${wav}; run --step download first`);
    }

    const startedAt = Date.now();
    const segments = await transcribeWav(ctx.whisper, wav);
    const model = ctx.whisper.model;
    ctx.db.prepare(UPSERT).run(row.guid, JSON.stringify(segments), model);

    const speech = segments.reduce((total, segment) => total + (segment.end - segment.start), 0);
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    const counted = `${segments.length} segments, ${speech.toFixed(1)}s of speech`;
    ctx.log(`${row.guid}: transcribe ${counted}, ${model}, ${elapsed}s`);

    return { segments: segments.length, model };
  },
};
