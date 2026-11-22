import type { ObjectStore } from './store';

// Effect video compose: stitch segments (model outputs or base clips) in order into one video, mix in the original track, plus a silent version.
// The actual ffmpeg runs in the compose service (packages/jobs/compose/); this side only reads files from the object store, hands
// them to the service and stores the results.

import type { CropBox, FacePoint } from './models';

export interface ComposeSegment {
  /** R2 key. */
  key: string;
  /** Seconds this occupies in the output. */
  target: number;
  /** stretch: retime the whole segment to target; trim: take the first target seconds at real speed. */
  fit: 'stretch' | 'trim';
  /** Shot cut times in the final cut: the container splits at the cuts it finds and retimes each shot (overrides fit). */
  cuts?: readonly number[];
}

export interface ComposeInput {
  jobId: string;
  segments: ComposeSegment[];
  audio: { key: string; start: number; duration: number };
  width: number;
  height: number;
  fps: number;
}

export interface FacesInput {
  jobId: string;
  /** Model output (R2 key). */
  key: string;
  /** Unmasked original clip of the shot (R2 key); original faces are read from its first frame. */
  originalKey: string;
  /** Face centers (fractions of width and height) in the original's first frame, or at t seconds for [x, y, t]; one per slot to check. */
  points: FacePoint[];
  /** Only look at the first few seconds of the output. */
  seconds: number;
  /**
   * Per point, the time ranges (seconds on the output) to look in: the shots that point stands for, so a score says the original is
   * still in those shots and not somewhere else. Without it every point looks at the whole output.
   */
  windows?: readonly (readonly (readonly [number, number])[])[];
}

export interface LikenessInput {
  jobId: string;
  /** Composed video (R2 key). */
  key: string;
  /**
   * One per person: their photo (an R2 key, or a URL such as an upstream prep result), the seconds [start, end) they appear in, and
   * optionally per range the spots of that shot as fractions of width and height, theirs first: then the face in their spot is scored,
   * not the best face in the frame (which in a group shot finds someone else).
   */
  people: {
    photo: { key: string } | { url: string };
    ranges: [number, number][];
    spots?: [number, number][][];
  }[];
}

export interface ExtractInput {
  jobId: string;
  /** Composed video (R2 key). */
  key: string;
  /** Frame ranges [start, end) to join, in order. */
  ranges: [number, number][];
  /** Cut this box out of the joined frames and scale it up to the full width. */
  crop?: CropBox;
  width: number;
  height: number;
  fps: number;
}

export interface PatchInput extends ExtractInput {
  /** Container work name, unique per pass ([a-z0-9_-]). */
  name: string;
  /** Repaired clip (R2 key) from the frames extract gave the model, any size and frame rate. */
  patchKey: string;
}

export interface Composer {
  /** Crop a borderless 2x2 sheet in row-major order. Read-only and repeatable. */
  splitSheet?(input: { jobId: string; image: ArrayBuffer }): Promise<ArrayBuffer[]>;
  /** Repeated calls with the same jobId give the same result, safe for step retries. */
  compose(input: ComposeInput): Promise<{ song: ArrayBuffer; silent: ArrayBuffer }>;
  /**
   * Output check: for each point, the highest face similarity (cosine, 0–1) between the original person there and any face in the output.
   * High means the original person is still in the output (not swapped). Same order as points. Read-only, repeatable.
   */
  faces(input: FacesInput): Promise<number[]>;
  /**
   * Likeness check: per person, the median over sampled frames of their ranges of the similarity (cosine, 0–1) between their photo and the
   * face in their spot (or the best face in the frame, without spots);
   * null when the photo shows no face (an animal, say) or no frame was read. Same order as people. Read-only, repeatable.
   */
  likeness(input: LikenessInput): Promise<(number | null)[]>;
  /** Repair input: the frames of the given ranges joined into one silent clip (or a box of them). Read-only, repeatable. */
  extract(input: ExtractInput): Promise<ArrayBuffer>;
  /**
   * Put a repaired clip back over the same frames: the clip is retimed to their length and scaled to the frame, or to the box with
   * feathered inner edges; everything else, and the soundtrack, stays as it was. Returns with-track and silent versions. Repeatable.
   */
  patch(input: PatchInput): Promise<{ song: ArrayBuffer; silent: ArrayBuffer }>;
}

async function blobOf(bucket: ObjectStore, key: string): Promise<Blob> {
  const object = await bucket.get(key);
  if (!object) throw new Error(`compose input missing: ${key}`);
  return new Blob([await object.arrayBuffer()], { type: 'application/octet-stream' });
}

export interface HttpComposerOptions {
  /**
   * The service's concurrency lane (compose/limit.mjs). Job steps use the default, background. A site that stitches inside a web
   * request, while the visitor waits, passes 'interactive': it gets slots that background work never takes, so it doesn't queue behind
   * every site's swap checks and repairs on the machine.
   */
  lane?: 'background' | 'interactive';
}

/**
 * The compose service (packages/jobs/compose) over HTTP at baseUrl. One service per machine: compose and patch leave their results
 * in the service's work directory under the job or pass name, and the silent copy is fetched from there right after.
 */
export function httpComposer(
  baseUrl: string,
  bucket: ObjectStore,
  fetcher: typeof fetch = fetch,
  options: HttpComposerOptions = {},
): Composer {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const lane: Record<string, string> =
    options.lane === 'interactive' ? { 'x-compose-lane': 'interactive' } : {};
  const call = (path: string, init?: RequestInit) =>
    fetcher(`${base}${path}`, {
      ...init,
      headers: { ...lane, ...(init?.headers as Record<string, string>) },
    });
  return {
    async splitSheet(input) {
      const form = new FormData();
      form.set('image', new Blob([input.image]), 'sheet');
      const response = await call('/split-sheet', { method: 'POST', body: form });
      if (!response.ok) throw new Error(`split sheet failed: ${response.status} ${await response.text()}`);
      const { images } = (await response.json()) as { images: string[] };
      if (
        !Array.isArray(images) ||
        images.length !== 4 ||
        images.some((image) => typeof image !== 'string' || !image)
      )
        throw new Error('split sheet returned invalid images');
      return images.map((image) => Uint8Array.from(atob(image), (char) => char.charCodeAt(0)).buffer);
    },
    async compose(input) {
      const form = new FormData();
      form.set(
        'manifest',
        JSON.stringify({
          id: input.jobId,
          segments: input.segments.map(({ target, fit, cuts }) => ({
            target,
            fit,
            ...(cuts ? { cuts } : {}),
          })),
          audio: { start: input.audio.start, duration: input.audio.duration },
          width: input.width,
          height: input.height,
          fps: input.fps,
        }),
      );
      for (const [index, segment] of input.segments.entries()) {
        form.set(`segment-${index}`, await blobOf(bucket, segment.key), `${index}.mp4`);
      }
      form.set('audio', await blobOf(bucket, input.audio.key), 'audio');

      const composed = await call('/compose', { method: 'POST', body: form });
      if (!composed.ok) throw new Error(`compose failed: ${composed.status} ${await composed.text()}`);
      const song = await composed.arrayBuffer();
      const silent = await call(`/files/${input.jobId}/silent.mp4`);
      if (!silent.ok) throw new Error(`compose silent copy failed: ${silent.status} ${await silent.text()}`);
      return { song, silent: await silent.arrayBuffer() };
    },
    async faces(input) {
      const form = new FormData();
      form.set('seconds', String(input.seconds));
      form.set('points', JSON.stringify(input.points));
      if (input.windows) form.set('windows', JSON.stringify(input.windows));
      form.set('video', await blobOf(bucket, input.key), 'video.mp4');
      form.set('original', await blobOf(bucket, input.originalKey), 'original.mp4');
      const response = await call('/faces', { method: 'POST', body: form });
      if (!response.ok) throw new Error(`faces failed: ${response.status} ${await response.text()}`);
      const { similarity } = (await response.json()) as { similarity?: unknown };
      if (
        !Array.isArray(similarity) ||
        similarity.length !== input.points.length ||
        !similarity.every((value) => typeof value === 'number')
      )
        throw new Error('faces returned no scores');
      return similarity as number[];
    },
    async likeness(input) {
      const form = new FormData();
      form.set(
        'people',
        JSON.stringify(input.people.map(({ ranges, spots }) => ({ ranges, ...(spots ? { spots } : {}) }))),
      );
      form.set('video', await blobOf(bucket, input.key), 'video.mp4');
      // A photo can be listed several times (each likeness slot is also scored against the others' photos): fetch each once, in parallel.
      const blobs = new Map<string, Promise<Blob>>();
      const blobFor = (photo: { key: string } | { url: string }) => {
        const id = 'key' in photo ? `key:${photo.key}` : `url:${photo.url}`;
        if (!blobs.has(id))
          blobs.set(
            id,
            'key' in photo
              ? blobOf(bucket, photo.key)
              : fetch(photo.url).then((response) => {
                  if (!response.ok) throw new Error(`likeness photo ${photo.url} failed: ${response.status}`);
                  return response.blob();
                }),
          );
        return blobs.get(id)!;
      };
      const photos = await Promise.all(input.people.map(({ photo }) => blobFor(photo)));
      for (const [i, blob] of photos.entries()) form.set(`photo-${i}`, blob, 'photo');
      const response = await call('/likeness', { method: 'POST', body: form });
      if (!response.ok) throw new Error(`likeness failed: ${response.status} ${await response.text()}`);
      const { similarity } = (await response.json()) as { similarity?: unknown };
      if (
        !Array.isArray(similarity) ||
        similarity.length !== input.people.length ||
        !similarity.every((value) => value === null || typeof value === 'number')
      )
        throw new Error('likeness returned no scores');
      return similarity as (number | null)[];
    },
    async extract(input) {
      const form = new FormData();
      form.set('manifest', JSON.stringify(cutManifest(input)));
      form.set('video', await blobOf(bucket, input.key), 'video.mp4');
      const response = await call('/extract', { method: 'POST', body: form });
      if (!response.ok) throw new Error(`extract failed: ${response.status} ${await response.text()}`);
      return response.arrayBuffer();
    },
    async patch(input) {
      const form = new FormData();
      form.set('manifest', JSON.stringify({ ...cutManifest(input), id: input.name }));
      form.set('video', await blobOf(bucket, input.key), 'video.mp4');
      form.set('patch', await blobOf(bucket, input.patchKey), 'patch.mp4');
      const response = await call('/patch', { method: 'POST', body: form });
      if (!response.ok) throw new Error(`patch failed: ${response.status} ${await response.text()}`);
      const song = await response.arrayBuffer();
      const silent = await call(`/files/${input.name}/silent.mp4`);
      if (!silent.ok) throw new Error(`patch silent copy failed: ${silent.status} ${await silent.text()}`);
      return { song, silent: await silent.arrayBuffer() };
    },
  };
}

function cutManifest({ ranges, crop, width, height, fps }: ExtractInput) {
  return { ranges, ...(crop ? { crop } : {}), width, height, fps };
}
