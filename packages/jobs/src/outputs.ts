import { isMp3, stripAudioTags } from './audio-tags';
import type { ComposeSegment } from './compose';
import { activeJob, type StoredOutput } from './lifecycle';
import { partsOf } from './models';
import type { RunnerDeps } from './runner';
import type { OutputFile } from './upstream';

// Writing a job's deliverables to R2: upstream results copied in, and effect segments stitched into the final video.

function extensionFor(mediaType: string): string {
  const subtype = mediaType.split('/')[1]?.split(';')[0] ?? 'bin';
  if (subtype === 'mpeg' && mediaType.startsWith('audio/')) return 'mp3';
  return subtype === 'jpeg' ? 'jpg' : subtype.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin';
}

/** Upstream result links expire, so copy the files into our own R2 before finishing. */
export async function storeOutputs(
  deps: RunnerDeps,
  jobId: string,
  files: OutputFile[],
  /** Starting index of this segment's outputs in a multi-part job, so keys don't collide. */
  startIndex = 0,
): Promise<StoredOutput[]> {
  const fetcher = deps.fetcher ?? fetch;
  const stored: StoredOutput[] = [];
  for (const [index, file] of files.entries()) {
    const response = await fetcher(file.url);
    if (!response.ok || !response.body)
      throw new Error(`download output ${index} failed: ${response.status}`);
    const mediaType = response.headers.get('content-type') ?? file.mediaType;
    const key = `jobs/${jobId}/${startIndex + index}.${extensionFor(mediaType)}`;
    // Songs are a few MB, so buffering them to drop the provider's ID3 tags is cheap; other outputs stream straight through.
    const body = isMp3(mediaType)
      ? stripAudioTags(new Uint8Array(await response.arrayBuffer()))
      : response.body;
    await deps.bucket.put(key, body, { httpMetadata: { contentType: mediaType } });
    stored.push({ key, mediaType });
  }
  return stored;
}

/** Stitch the output in effect segment order: rendered segments use model outputs, the rest use base clips. Stored as a with-track and a silent file. */
export async function composeOutputs(
  deps: RunnerDeps,
  jobId: string,
  partKeys: ReadonlyMap<string, string>,
  startIndex: number,
): Promise<StoredOutput[] | null> {
  const job = await activeJob(deps.db, jobId);
  if (!job) return null;
  const model = deps.models.find((m) => m.id === job.modelId);
  const effect = model?.effect;
  if (!effect?.compose) throw new Error(`model ${job.modelId} has no compose config`);
  if (!deps.composer) throw new Error('compose is not configured for this site');
  // A job created under an older effect config (for example before its shots were merged into one) rendered segments the current
  // config no longer lists: composing would silently use base clips for them and deliver the original footage. Fail with a refund instead.
  const known = new Set(effect.segments.map((segment) => segment.id));
  const stale = partsOf(job, model!)
    .filter((part) => part.kind !== 'image' && !known.has(part.id))
    .map((part) => part.id);
  if (stale.length > 0) throw new Error(`segments ${stale.join(', ')} are no longer in the effect config`);
  const segments: ComposeSegment[] = effect.segments.map((segment) => {
    const rendered = partKeys.get(segment.id);
    // Shot cuts only apply to the model output; base clips already have the original timing.
    return rendered
      ? {
          key: rendered,
          target: segment.target!,
          fit: segment.fit ?? 'stretch',
          ...(segment.cuts ? { cuts: segment.cuts } : {}),
        }
      : { key: segment.base!, target: segment.target!, fit: 'stretch' };
  });
  const { audio, audioStart, audioDuration, width, height, fps } = effect.compose;
  const result = await deps.composer.compose({
    jobId,
    segments,
    audio: { key: audio, start: audioStart, duration: audioDuration },
    width,
    height,
    fps,
  });
  const song = `jobs/${jobId}/${startIndex}.mp4`;
  const silent = `jobs/${jobId}/${startIndex + 1}.mp4`;
  const meta = { httpMetadata: { contentType: 'video/mp4' } };
  await deps.bucket.put(song, result.song, meta);
  await deps.bucket.put(silent, result.silent, meta);
  return [
    { key: song, mediaType: 'video/mp4' },
    { key: silent, mediaType: 'video/mp4' },
  ];
}
