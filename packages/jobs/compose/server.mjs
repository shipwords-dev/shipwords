// HTTP server for the compose container (runs in Cloudflare Containers; image in Dockerfile).
// POST /compose  multipart: manifest (JSON: { id, segments: [{ target, fit, cuts? }], audio: { start, duration }, width, height, fps }),
//   segment-0…segment-N (segment videos), audio (original track). Stitches, retimes and mixes, returns an MP4 with the track; results also stay in /tmp/compose/<id>/.
//   A segment with cuts is split at the scene cuts found in its video and each shot is retimed to its length; a missing cut fails the request.
// GET  /files/<id>/song.mp4 | /files/<id>/silent.mp4  read results.
// POST /faces  multipart: video (model output), original (unmasked clip of the shot), seconds, points (JSON [[x, y], ...]).
//   Returns { similarity: [...] }: per point, how closely any face in the output matches the original person there (faces.py). Read-only.
// POST /likeness  multipart: video (composed), people (JSON [{ ranges: [[start, end], ...] seconds }, ...]), photo-0…photo-N.
//   Returns { similarity: [...] }: per person, how much their face in those ranges looks like their photo, or null (faces.py). Read-only.
// POST /extract  multipart: manifest (JSON: { ranges: [[start, end), ...] frames, crop?: [x, y, w, h], width, height, fps }), video.
//   Returns those frames joined into one silent MP4 (the box only, scaled up, with crop): the input of a repair pass. Read-only.
// POST /patch  multipart: manifest (as extract plus id), video, patch (the repaired clip). Returns video with the repaired frames
//   put back; results also stay in /tmp/compose/<id>/ (song.mp4, silent.mp4) like compose.
// Repeating compose with the same id overwrites the same files, so Workflow retries are idempotent.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
  matchCuts,
  parseCutTimes,
  parsePoints,
  splitAtCuts,
} from './compose.mjs';

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
  if (
    !Array.isArray(people) ||
    people.length === 0 ||
    people.length > 10 ||
    !people.every(
      (person) => Array.isArray(person?.ranges) && person.ranges.length > 0 && person.ranges.every(valid),
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
      args.push({ photo, ranges: person.ranges });
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
    await run('ffmpeg', buildExtractArgs({ ...spec, input, frames: await framesOf(input), output }));
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
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const video = join(dir, 'in.mp4');
  const patchFile = join(dir, 'patch.mp4');
  await save(form, 'video', video);
  await save(form, 'patch', patchFile);
  const song = join(dir, 'song.mp4');
  await run(
    'ffmpeg',
    buildPatchArgs({
      ...spec,
      video,
      frames: await framesOf(video),
      patch: patchFile,
      patchDuration: await durationOf(patchFile),
      output: song,
    }),
  );
  await run('ffmpeg', buildSilentArgs(song, join(dir, 'silent.mp4')));
  return song;
}

function sendFile(res, file, size) {
  res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': size });
  createReadStream(file).pipe(res);
}

// The process stops itself rather than trusting the platform to stop it: sleepAfter in @cloudflare/containers can renew
// forever (an unread response body keeps its in-flight count up; re-creating an evicted Durable Object resets the timer),
// and a running instance bills memory whether or not it works. Calls within one job step come seconds apart, while
// waits on the upstream model between repair rounds take 75 s or more, so a minute idle means the step is done.
// The lifetime cap ends even a stuck process; a request cut off by it fails its Workflow step, which retries on a fresh instance.
const IDLE_EXIT_MS = Number(process.env.IDLE_EXIT_MS) || 60_000;
const MAX_LIFETIME_MS = Number(process.env.MAX_LIFETIME_MS) || 10 * 60_000;
let inFlight = 0;
let idleTimer;
const armIdleExit = () => {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => process.exit(0), IDLE_EXIT_MS);
};
armIdleExit();
setTimeout(() => process.exit(0), MAX_LIFETIME_MS);

createServer(async (req, res) => {
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
    if (req.method === 'POST' && req.url === '/compose') {
      const song = await compose(req);
      return sendFile(res, song, (await stat(song)).size);
    }
    if (req.method === 'POST' && req.url === '/extract') {
      const clip = await extract(req);
      return res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': clip.length }).end(clip);
    }
    if (req.method === 'POST' && req.url === '/patch') {
      const song = await patch(req);
      return sendFile(res, song, (await stat(song)).size);
    }
    if (req.method === 'POST' && req.url === '/faces') {
      const body = JSON.stringify({ similarity: await faces(req) });
      return res.writeHead(200, { 'content-type': 'application/json' }).end(body);
    }
    if (req.method === 'POST' && req.url === '/likeness') {
      const body = JSON.stringify({ similarity: await likeness(req) });
      return res.writeHead(200, { 'content-type': 'application/json' }).end(body);
    }
    const match = req.method === 'GET' && req.url?.match(/^\/files\/([a-z0-9_-]{1,80})\/(song|silent)\.mp4$/);
    if (match) {
      const file = join(ROOT, match[1], `${match[2]}.mp4`);
      const info = await stat(file).catch(() => null);
      if (!info) return res.writeHead(404).end('not found');
      return sendFile(res, file, info.size);
    }
    if (req.url === '/health') return res.writeHead(200).end('ok');
    res.writeHead(404).end('not found');
  } catch (error) {
    res.writeHead(500, { 'content-type': 'text/plain' }).end(String(error?.message ?? error));
  }
}).listen(8080);

// Node runs as PID 1 here, and PID 1 ignores SIGTERM unless it has a handler: without this, the stop signal sent after
// sleepAfter does nothing and the instance keeps billing memory for hours. The idle exit above is the primary stop.
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => process.exit(0));
