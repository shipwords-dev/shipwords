// HTTP server for the compose service: one long-running container per machine, reached over the internal network (image in Dockerfile).
// POST /compose  multipart: manifest (JSON: { id, segments: [{ target, fit, cuts? }], audio: { start, duration }, width, height, fps }),
//   segment-0…segment-N (segment videos), audio (original track). Stitches, retimes and mixes, returns an MP4 with the track; results also stay in /tmp/compose/<id>/.
//   A segment with cuts is split at the scene cuts found in its video and each shot is retimed to its length; a missing cut fails the request.
// GET  /files/<id>/song.mp4 | /files/<id>/silent.mp4  read results.
// POST /faces  multipart: video (model output), original (unmasked clip of the shot), seconds, points (JSON [[x, y], ...]).
//   Returns { similarity: [...] }: per point, how closely any face in the output matches the original person there (faces.py). Read-only.
// POST /likeness  multipart: video (composed), people (JSON [{ ranges: [[start, end], ...] seconds, spots?: [[[x, y], ...] per range] }, ...]),
//   photo-0…photo-N. Returns { similarity: [...] }: per person, how much their face in those ranges (the face in their spot, own spot first,
//   when spots are given) looks like their photo, or null (faces.py). Read-only.
// POST /extract  multipart: manifest (JSON: { ranges: [[start, end), ...] frames, crop?: [x, y, w, h], width, height, fps }), video.
//   Returns those frames joined into one MP4 with the same stretch of the video's soundtrack, if it has one (the box only, scaled
//   up, with crop): the input of a repair pass. Read-only.
// POST /patch  multipart: manifest (as extract plus id), video, patch (the repaired clip). Returns video with the repaired frames
//   put back: a whole-frame clip covers the frame and replaces them; a box is lined up frame by frame on the background (align.py;
//   stretched over the box if that fails). Results also stay in /tmp/compose/<id>/ (song.mp4, silent.mp4) like compose.
// Repeating compose with the same id overwrites the same files, so step retries are idempotent.
// Heavy requests run at most MAX_JOBS (default 2) at a time, plus MAX_INTERACTIVE_JOBS (default 1) for requests sent with
// x-compose-lane: interactive (limit.mjs); the rest wait. Work directories are removed KEEP_MS (default 2 h)
// after they were last written, since no container teardown cleans them any more.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  buildCutArgs,
  buildExtractArgs,
  buildFfmpegArgs,
  buildPatchArgs,
  buildSilentArgs,
  checkRanges,
  clampRanges,
  cropPixels,
  ENCODE,
  matchCuts,
  parseCutTimes,
  parsePoints,
  parseWindows,
  splitAtCuts,
} from './compose.mjs';
import { Busy, createLanes, laneOf } from './limit.mjs';

const run = promisify(execFile);
const ROOT = '/tmp/compose';
const ID = /^[a-z0-9_-]{1,80}$/;

async function durationOf(file) {
  const { stdout } = await run('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'csv=p=0',
    file,
  ]);
  const value = Number(stdout.trim());
  if (!(value > 0)) throw new Error(`cannot read duration of ${file}`);
  return value;
}

/**
 * Length of the first video stream (s). A repaired clip carries the soundtrack it was given, which can run past its picture; the
 * container duration counts that tail, and retiming the picture by it would squeeze the frames and shift everything after the range.
 */
async function videoDurationOf(file) {
  // JSON, not CSV: side data such as a rotation matrix adds fields to a CSV row ("1.000000,"), which would read as no duration.
  const { stdout } = await run('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=duration',
    '-of',
    'json',
    file,
  ]);
  const value = Number(JSON.parse(stdout).streams?.[0]?.duration);
  return value > 0 ? value : durationOf(file);
}

/** Whether the file has an audio stream. */
async function hasAudio(file) {
  const { stdout } = await run('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'a',
    '-show_entries',
    'stream=index',
    '-of',
    'csv=p=0',
    file,
  ]);
  return stdout.trim() !== '';
}

/** Video frames actually in the file (packets of the first video stream; our MP4s have one frame per packet). */
async function framesOf(file) {
  const { stdout } = await run('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-count_packets',
    '-show_entries',
    'stream=nb_read_packets',
    '-of',
    'csv=p=0',
    file,
  ]);
  const value = Number(stdout.trim());
  if (!(value > 0)) throw new Error(`cannot count frames of ${file}`);
  return value;
}

async function save(form, field, file) {
  const value = form.get(field);
  if (!value || typeof value === 'string') throw new Error(`missing file ${field}`);
  await writeFile(file, Buffer.from(await value.arrayBuffer()));
}

async function compose(req) {
  const form = await new Request('http://local/', {
    method: 'POST',
    headers: req.headers,
    body: req,
    duplex: 'half',
  }).formData();
  const manifest = JSON.parse(String(form.get('manifest') ?? '{}'));
  if (!ID.test(manifest.id ?? '')) throw new Error('bad id');
  if (!Array.isArray(manifest.segments) || manifest.segments.length === 0) throw new Error('no segments');
  const dir = join(ROOT, manifest.id);
  const release = hold(dir);
  try {
    return await composeInto(form, manifest, dir);
  } finally {
    release();
    await utimes(dir, new Date(), new Date()).catch(() => {});
  }
}

async function composeInto(form, manifest, dir) {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const segments = [];
  for (const [i, segment] of manifest.segments.entries()) {
    const file = join(dir, `in-${i}.mp4`);
    await save(form, `segment-${i}`, file);
    const duration = await durationOf(file);
    if (!Array.isArray(segment.cuts) || segment.cuts.length === 0) {
      segments.push({ file, duration, target: segment.target, fit: segment.fit });
      continue;
    }
    const cuts = segment.cuts.map(Number);
    if (!cuts.every((cut, j) => cut > (j === 0 ? 0 : cuts[j - 1]) && cut < segment.target))
      throw new Error('bad cuts');
    // showinfo logs at info level; -nostats keeps progress lines out of stderr.
    const { stderr } = await run('ffmpeg', buildCutArgs(file), { maxBuffer: 16 * 1024 * 1024 });
    const detected = matchCuts(cuts, parseCutTimes(stderr));
    if (!detected) throw new Error(`segment ${i}: shot cuts not found in the output`);
    segments.push(...splitAtCuts({ file, duration, target: segment.target, cuts, detected }));
  }
  const audioFile = join(dir, 'audio-src');
  await save(form, 'audio', audioFile);
  const audio = { file: audioFile, start: manifest.audio.start, duration: manifest.audio.duration };
  const song = join(dir, 'song.mp4');
  await run(
    'ffmpeg',
    buildFfmpegArgs({
      segments,
      audio,
      width: manifest.width,
      height: manifest.height,
      fps: manifest.fps,
      output: song,
    }),
  );
  await run('ffmpeg', buildSilentArgs(song, join(dir, 'silent.mp4')));
  return song;
}

async function faces(req) {
  const form = await new Request('http://local/', {
    method: 'POST',
    headers: req.headers,
    body: req,
    duplex: 'half',
  }).formData();
  const seconds = Number(form.get('seconds'));
  if (!(Number.isFinite(seconds) && seconds > 0 && seconds <= 60)) throw new Error('bad seconds');
  const points = parsePoints(String(form.get('points') ?? ''));
  const windows = form.has('windows') ? parseWindows(String(form.get('windows')), points.length) : null;
  const dir = join('/tmp/faces', randomUUID());
  await mkdir(dir, { recursive: true });
  try {
    const video = join(dir, 'video.mp4');
    const original = join(dir, 'original.mp4');
    await save(form, 'video', video);
    await save(form, 'original', original);
    const { stdout } = await run('python3', [
      'faces.py',
      video,
      original,
      String(seconds),
      JSON.stringify(points),
      ...(windows ? [JSON.stringify(windows)] : []),
    ]);
    const similarity = JSON.parse(stdout);
    if (!Array.isArray(similarity) || similarity.length !== points.length)
      throw new Error('bad faces output');
    return similarity;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function likeness(req) {
  const form = await formOf(req);
  const people = JSON.parse(String(form.get('people') ?? ''));
  const valid = (range) =>
    Array.isArray(range) &&
    range.length === 2 &&
    range.every((value) => Number.isFinite(value) && value >= 0 && value <= 60) &&
    range[0] < range[1];
  const point = (spot) =>
    Array.isArray(spot) &&
    spot.length === 2 &&
    spot.every((value) => Number.isFinite(value) && value >= 0 && value <= 1);
  // Optional spots: per range, this person's spot first, then the other people's spots in that shot.
  const spotted = (person) =>
    person.spots === undefined ||
    (Array.isArray(person.spots) &&
      person.spots.length === person.ranges.length &&
      person.spots.every(
        (spots) => Array.isArray(spots) && spots.length > 0 && spots.length <= 10 && spots.every(point),
      ));
  if (
    !Array.isArray(people) ||
    people.length === 0 ||
    people.length > 10 ||
    !people.every(
      (person) =>
        Array.isArray(person?.ranges) &&
        person.ranges.length > 0 &&
        person.ranges.every(valid) &&
        spotted(person),
    )
  )
    throw new Error('bad people');
  const dir = join('/tmp/faces', randomUUID());
  await mkdir(dir, { recursive: true });
  try {
    const video = join(dir, 'video.mp4');
    await save(form, 'video', video);
    const args = [];
    for (const [i, person] of people.entries()) {
      const photo = join(dir, `photo-${i}`);
      await save(form, `photo-${i}`, photo);
      args.push({ photo, ranges: person.ranges, ...(person.spots ? { spots: person.spots } : {}) });
    }
    const { stdout } = await run('python3', ['faces.py', 'likeness', video, JSON.stringify(args)]);
    const similarity = JSON.parse(stdout);
    if (!Array.isArray(similarity) || similarity.length !== people.length)
      throw new Error('bad likeness output');
    return similarity;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function formOf(req) {
  return new Request('http://local/', {
    method: 'POST',
    headers: req.headers,
    body: req,
    duplex: 'half',
  }).formData();
}

function cutSpec(manifest) {
  const { width, height, fps } = manifest;
  if (![width, height, fps].every((value) => Number.isInteger(value) && value > 0 && value <= 4096))
    throw new Error('bad size');
  return { ranges: checkRanges(manifest.ranges), crop: manifest.crop, width, height, fps };
}

async function extract(req) {
  const form = await formOf(req);
  const spec = cutSpec(JSON.parse(String(form.get('manifest') ?? '{}')));
  const dir = join('/tmp/extract', randomUUID());
  await mkdir(dir, { recursive: true });
  try {
    const input = join(dir, 'video.mp4');
    const output = join(dir, 'clip.mp4');
    await save(form, 'video', input);
    await run(
      'ffmpeg',
      buildExtractArgs({
        ...spec,
        input,
        frames: await framesOf(input),
        audio: await hasAudio(input),
        output,
      }),
    );
    return await readFile(output);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function patch(req) {
  const form = await formOf(req);
  const manifest = JSON.parse(String(form.get('manifest') ?? '{}'));
  if (!ID.test(manifest.id ?? '')) throw new Error('bad id');
  const spec = cutSpec(manifest);
  const dir = join(ROOT, manifest.id);
  const release = hold(dir);
  try {
    return await patchInto(form, manifest, spec, dir);
  } finally {
    release();
    await utimes(dir, new Date(), new Date()).catch(() => {});
  }
}

async function patchInto(form, manifest, spec, dir) {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const video = join(dir, 'in.mp4');
  const patchFile = join(dir, 'patch.mp4');
  await save(form, 'video', video);
  await save(form, 'patch', patchFile);
  const song = join(dir, 'song.mp4');
  const frames = await framesOf(video);
  const replaceFrames = async () =>
    run(
      'ffmpeg',
      buildPatchArgs({
        ...spec,
        video,
        frames,
        patch: patchFile,
        patchDuration: await videoDurationOf(patchFile),
        output: song,
      }),
    );
  if (!spec.crop) {
    // A whole-frame clip replaces the frames outright, scaled to cover the frame. Aligning it on the background (align.py) instead
    // leaves the strips it doesn't cover showing the frame before repair, and those strips can hold a second copy of a face.
    await replaceFrames();
  } else {
    // Line the repaired box up with the frames it replaces (align.py); if that fails, stretch it over the box as before.
    try {
      const box = cropPixels(spec.crop, spec.width, spec.height);
      const plan = { ranges: clampRanges(spec.ranges, frames), box, fps: spec.fps, encode: ENCODE };
      const { stdout } = await run('python3', ['align.py', video, patchFile, song, JSON.stringify(plan)], {
        maxBuffer: 1 << 20,
      });
      console.log(JSON.stringify({ event: 'patch aligned', id: manifest.id, ...JSON.parse(stdout) }));
    } catch (error) {
      console.log(
        JSON.stringify({ event: 'patch align failed, stretching', id: manifest.id, error: String(error) }),
      );
      await replaceFrames();
    }
  }
  await run('ffmpeg', buildSilentArgs(song, join(dir, 'silent.mp4')));
  return song;
}

function sendFile(res, file, size) {
  res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': size });
  createReadStream(file).pipe(res);
}

async function splitSheet(req) {
  const form = await new Request('http://local/', {
    method: 'POST',
    headers: req.headers,
    body: req,
    duplex: 'half',
  }).formData();
  const dir = join(ROOT, `sheet-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  try {
    const source = join(dir, 'source');
    await save(form, 'image', source);
    const images = [];
    for (let view = 0; view < 4; view++) {
      const target = join(dir, `${view}.png`);
      await run('ffmpeg', [
        '-y',
        '-v',
        'error',
        '-i',
        source,
        '-vf',
        `format=rgb24,crop=floor(iw/2):floor(ih/2):${view % 2}*floor(iw/2):${Math.floor(view / 2)}*floor(ih/2):exact=1`,
        '-frames:v',
        '1',
        '-threads',
        '1',
        target,
      ]);
      images.push((await readFile(target)).toString('base64'));
    }
    return images;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Optional self-stop, for platforms that bill an idle instance (it was needed on Cloudflare Containers, where sleepAfter could
// renew forever). Off unless IDLE_EXIT_MS / MAX_LIFETIME_MS are set: as a long-running service it just keeps running.
const IDLE_EXIT_MS = Number(process.env.IDLE_EXIT_MS) || 0;
const MAX_LIFETIME_MS = Number(process.env.MAX_LIFETIME_MS) || 0;
let inFlight = 0;
let idleTimer;
const armIdleExit = () => {
  clearTimeout(idleTimer);
  if (IDLE_EXIT_MS > 0) idleTimer = setTimeout(() => process.exit(0), IDLE_EXIT_MS);
};
armIdleExit();
if (MAX_LIFETIME_MS > 0) setTimeout(() => process.exit(0), MAX_LIFETIME_MS);

// ffmpeg and the face checks are CPU-heavy: a few at a time per lane (limit.mjs). A stitch a visitor waits on (x-compose-lane:
// interactive) has its own slots, so it never queues behind the machine's background job steps.
const lanes = createLanes();
const limited = (req, work) => lanes[laneOf(req.headers)].run(work, (leave) => req.once('close', leave));

// Work directories in use (a compose or patch writing them, a download reading them) are never swept.
const inUse = new Map();
function hold(dir) {
  inUse.set(dir, (inUse.get(dir) ?? 0) + 1);
  return () => {
    const left = inUse.get(dir) - 1;
    if (left > 0) inUse.set(dir, left);
    else inUse.delete(dir);
  };
}

// Work directories left by compose, patch, faces and extract: removed once untouched for KEEP_MS.
const KEEP_MS = Number(process.env.KEEP_MS) || 2 * 3_600_000;
async function sweep() {
  for (const root of [ROOT, '/tmp/faces', '/tmp/extract']) {
    const entries = await readdir(root).catch(() => []);
    for (const entry of entries) {
      const dir = join(root, entry);
      if (inUse.has(dir)) continue;
      const info = await stat(dir).catch(() => null);
      if (info && Date.now() - info.mtimeMs > KEEP_MS)
        await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
setInterval(() => void sweep(), 10 * 60_000).unref();

const server = createServer(async (req, res) => {
  // Health probes are not work and must not keep the instance alive.
  if (req.url !== '/health') {
    inFlight++;
    clearTimeout(idleTimer);
    // close fires both when the response finishes and when the caller goes away.
    res.on('close', () => {
      if (--inFlight === 0) armIdleExit();
    });
  }
  try {
    if (req.method === 'POST' && req.url === '/split-sheet') {
      const body = JSON.stringify({ images: await limited(req, () => splitSheet(req)) });
      return res.writeHead(200, { 'content-type': 'application/json' }).end(body);
    }
    if (req.method === 'POST' && req.url === '/compose') {
      const song = await limited(req, () => compose(req));
      return sendFile(res, song, (await stat(song)).size);
    }
    if (req.method === 'POST' && req.url === '/extract') {
      const clip = await limited(req, () => extract(req));
      return res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': clip.length }).end(clip);
    }
    if (req.method === 'POST' && req.url === '/patch') {
      const song = await limited(req, () => patch(req));
      return sendFile(res, song, (await stat(song)).size);
    }
    if (req.method === 'POST' && req.url === '/faces') {
      const body = JSON.stringify({ similarity: await limited(req, () => faces(req)) });
      return res.writeHead(200, { 'content-type': 'application/json' }).end(body);
    }
    if (req.method === 'POST' && req.url === '/likeness') {
      const body = JSON.stringify({ similarity: await limited(req, () => likeness(req)) });
      return res.writeHead(200, { 'content-type': 'application/json' }).end(body);
    }
    const match = req.method === 'GET' && req.url?.match(/^\/files\/([a-z0-9_-]{1,80})\/(song|silent)\.mp4$/);
    if (match) {
      const file = join(ROOT, match[1], `${match[2]}.mp4`);
      const info = await stat(file).catch(() => null);
      if (!info) return res.writeHead(404).end('not found');
      const release = hold(join(ROOT, match[1]));
      res.once('close', release);
      return sendFile(res, file, info.size);
    }
    if (req.url === '/health') return res.writeHead(200).end('ok');
    res.writeHead(404).end('not found');
  } catch (error) {
    if (error instanceof Busy) return res.writeHead(503, { 'retry-after': '30' }).end('busy');
    res.writeHead(500, { 'content-type': 'text/plain' }).end(String(error?.message ?? error));
  }
});
// Internal network only. A queued request's body stays unread until its turn, so the receive timeout must not run out meanwhile;
// headers still have to arrive in time.
server.requestTimeout = 0;
server.listen(8080);

// Node runs as PID 1 here, and PID 1 ignores SIGTERM unless it has a handler: without this, docker stop waits for its timeout and
// then kills the process.
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => process.exit(0));
