// Effect video compose: retime each segment (model render or base clip) back to real speed, concatenate in order, then mix in the original track.
// Depends only on Node built-ins and the image's ffmpeg; server.mjs uses it for HTTP requests, tests call buildFfmpegArgs directly.

/**
 * @typedef {{ file: string; duration: number; target: number; fit?: 'stretch' | 'trim'; start?: number; ratio?: number }} Segment
 *   file: local file; duration: the file's actual length (s), or the piece length when start is set; target: length it should occupy in the output (s).
 *   fit: stretch (default) retimes the whole segment to target; trim takes the first target seconds at real speed.
 *   start: read only duration seconds from this point of the file (one shot of a longer clip, see splitAtCuts).
 *   ratio: fixed retime factor (setpts multiplier), overriding fit; the result is still cut or padded to target.
 * @typedef {{ file: string; start: number; duration: number }} Audio
 *   Original track: cut duration seconds starting at file's start second.
 */

/**
 * Build ffmpeg args. Segments are scaled to width×height and fps, retimed by target/duration, concatenated, and optionally mixed with an audio track.
 * @param {{ segments: Segment[]; audio?: Audio | null; width: number; height: number; fps: number; output: string }} spec
 */
export function buildFfmpegArgs(spec) {
  const { segments, audio, width, height, fps, output } = spec;
  if (!segments.length) throw new Error('no segments');
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  for (const segment of segments) {
    if (!(segment.duration > 0 && segment.target > 0)) throw new Error('segment durations must be positive');
    if (segment.ratio !== undefined && !(segment.ratio > 0))
      throw new Error('segment ratio must be positive');
    if (segment.start !== undefined) {
      if (!(segment.start >= 0)) throw new Error('segment start must not be negative');
      args.push('-ss', segment.start.toFixed(6), '-t', segment.duration.toFixed(6));
    }
    args.push('-i', segment.file);
  }
  if (audio) args.push('-ss', String(audio.start), '-t', String(audio.duration), '-i', audio.file);

  const frames = (seconds) => Math.round(seconds * fps);
  // Models render in whole seconds but often add 1 frame (6s comes out as 6.04s); using the actual length would skew the whole segment and break lip sync.
  // Within 1.5 frames we use the whole second; the extra frames are trimmed by the frame-count cut below.
  const nominal = (seconds) => {
    const whole = Math.round(seconds);
    return whole > 0 && Math.abs(seconds - whole) <= 1.5 / fps ? whole : seconds;
  };
  const filters = segments.map((segment, i) => {
    const ratio =
      segment.ratio !== undefined
        ? segment.ratio
        : segment.fit === 'trim'
          ? 1
          : segment.target / nominal(segment.duration);
    // Pad by the last frame at least one second, and enough to cover whatever the retimed segment is short of target,
    // so the frame-count cut below always yields exactly target (a fixed ratio can leave the last shot short by more than a second).
    const pad = fps + Math.max(0, frames(segment.target) - Math.floor(segment.duration * ratio * fps));
    // Retime first, then normalize frame rate, then cut by frame count so each segment is exact and the concat doesn't drift.
    return (
      `[${i}:v]setpts=${ratio.toFixed(6)}*(PTS-STARTPTS),scale=${width}:${height}:force_original_aspect_ratio=increase,` +
      `crop=${width}:${height},setsar=1,fps=${fps},tpad=stop_mode=clone:stop=${pad},trim=end_frame=${frames(segment.target)},setpts=PTS-STARTPTS[v${i}]`
    );
  });
  const inputs = segments.map((_, i) => `[v${i}]`).join('');
  filters.push(`${inputs}concat=n=${segments.length}:v=1:a=0[v]`);
  args.push('-filter_complex', filters.join(';'), '-map', '[v]');
  if (audio) args.push('-map', `${segments.length}:a`, '-c:a', 'aac', '-b:a', '160k', '-shortest');
  args.push(
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    output,
  );
  return args;
}

/** Scene cut detection: ffmpeg prints one showinfo line per frame whose scene score passes the threshold. Read pts_time from stderr. */
export function buildCutArgs(file) {
  return [
    '-hide_banner',
    '-nostats',
    '-i',
    file,
    '-an',
    '-vf',
    "select='gt(scene,0.3)',showinfo",
    '-f',
    'null',
    '-',
  ];
}

/** Cut times (s) from buildCutArgs stderr, in order. */
export function parseCutTimes(stderr) {
  return [...String(stderr).matchAll(/Parsed_showinfo[^\n]*\spts_time:\s*([0-9.]+)/g)].map((match) =>
    Number(match[1]),
  );
}

/**
 * Match each expected cut to the nearest detected cut within tolerance seconds, keeping them in order.
 * Extra detected cuts (flashes, fast motion) are ignored. Returns null if any expected cut has no match.
 */
export function matchCuts(expected, detected, tolerance = 0.5) {
  const matched = [];
  let after = 0;
  for (const cut of expected) {
    let best = null;
    for (const time of detected) {
      if (time <= after || Math.abs(time - cut) > tolerance) continue;
      if (best === null || Math.abs(time - cut) < Math.abs(best - cut)) best = time;
    }
    if (best === null) return null;
    matched.push(best);
    after = best;
  }
  return matched;
}

/** Seconds the last shot may fall short of its target (padded with its last frame) before the output counts as broken. */
const LAST_SHOT_SLACK = 0.5;

/**
 * Split one rendered clip into its shots at the matched cuts and retime each shot to its length in the final cut.
 * cuts: expected cut times in the final cut; detected: the matched cut times in the clip (same length, from matchCuts).
 * The last shot has no closing cut, so it uses the drift of the last cut and is cut or padded to the remaining target;
 * more than LAST_SHOT_SLACK short throws (the model dropped the end of the clip).
 */
export function splitAtCuts({ file, duration, target, cuts, detected }) {
  if (cuts.length !== detected.length || cuts.length === 0)
    throw new Error('cuts and detected cuts must match');
  const ends = [...cuts, target];
  const starts = [0, ...detected];
  return ends.map((end, i) => {
    const from = starts[i];
    const shot = end - (i === 0 ? 0 : cuts[i - 1]);
    if (i < cuts.length) {
      const length = detected[i] - from;
      return { file, start: from, duration: length, target: shot, ratio: shot / length };
    }
    const ratio = cuts[cuts.length - 1] / detected[detected.length - 1];
    const length = duration - from;
    // A last shot much shorter than the original would be padded with a frozen frame; treat it as a broken output instead.
    if (!(length * ratio >= shot - LAST_SHOT_SLACK))
      throw new Error(`last shot is ${(length * ratio).toFixed(2)}s, expected ${shot.toFixed(2)}s`);
    return { file, start: from, duration: length, target: shot, ratio };
  });
}

/**
 * Output check points: a JSON list of 1–10 points, each [x, y] or [x, y, t]: a face center as fractions of the frame (0–1),
 * and optionally the time (0–60 s) in the original clip to read that face from. Throws on anything else.
 */
export function parsePoints(text) {
  const points = JSON.parse(text);
  if (
    !Array.isArray(points) ||
    points.length === 0 ||
    points.length > 10 ||
    !points.every(
      (point) =>
        Array.isArray(point) &&
        (point.length === 2 || point.length === 3) &&
        point.every((value) => typeof value === 'number' && Number.isFinite(value)) &&
        point[0] >= 0 &&
        point[0] <= 1 &&
        point[1] >= 0 &&
        point[1] <= 1 &&
        (point.length === 2 || (point[2] >= 0 && point[2] <= 60)),
    )
  )
    throw new Error('bad points');
  return points;
}

/**
 * Face check windows: per point, 1–10 [start, end] time ranges in seconds (0–120, start < end). Throws on anything else.
 * @param {string} text
 * @param {number} count number of points
 */
export function parseWindows(text, count) {
  const windows = JSON.parse(text);
  if (
    !Array.isArray(windows) ||
    windows.length !== count ||
    !windows.every(
      (ranges) =>
        Array.isArray(ranges) &&
        ranges.length > 0 &&
        ranges.length <= 10 &&
        ranges.every(
          (range) =>
            Array.isArray(range) &&
            range.length === 2 &&
            range.every(
              (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 120,
            ) &&
            range[0] < range[1],
        ),
    )
  )
    throw new Error('bad windows');
  return windows;
}

/**
 * Repair frame ranges: a JSON-parsed list of 1–10 [start, end) frame pairs, increasing and not overlapping. Throws on anything else.
 * @param {unknown} ranges
 * @returns {[number, number][]}
 */
export function checkRanges(ranges) {
  if (
    !Array.isArray(ranges) ||
    ranges.length === 0 ||
    ranges.length > 10 ||
    !ranges.every(
      (range, i) =>
        Array.isArray(range) &&
        range.length === 2 &&
        range.every((value) => Number.isSafeInteger(value)) &&
        range[0] >= (i === 0 ? 0 : ranges[i - 1][1]) &&
        range[1] > range[0],
    )
  )
    throw new Error('bad ranges');
  return ranges;
}

/**
 * A crop box [x, y, width, height] as fractions of a width×height frame, in even pixels inside the frame. Throws on a bad box.
 * @param {unknown} box
 */
export function cropPixels(box, width, height) {
  if (
    !Array.isArray(box) ||
    box.length !== 4 ||
    !box.every((value) => typeof value === 'number' && value >= 0 && value <= 1) ||
    !(box[2] > 0 && box[3] > 0)
  )
    throw new Error('bad crop');
  const even = (value) => 2 * Math.round(value / 2);
  const x = Math.min(even(box[0] * width), width - 2);
  const y = Math.min(even(box[1] * height), height - 2);
  return {
    x,
    y,
    w: Math.max(2, Math.min(even(box[2] * width), width - x)),
    h: Math.max(2, Math.min(even(box[3] * height), height - y)),
  };
}

/**
 * Ranges cut to a video's actual frame count. Compose ends the video with the soundtrack (-shortest), which can drop the last frame
 * the shot lengths add up to; extract and patch both cut the same way, so the repaired clip still lines up. Throws if nothing is left.
 * @param {[number, number][]} ranges
 * @returns {[number, number][]}
 */
export function clampRanges(ranges, frames) {
  const kept = ranges
    .filter(([start]) => start < frames)
    .map(([start, end]) => [start, Math.min(end, frames)]);
  if (kept.length === 0) throw new Error('ranges start past the video');
  return kept;
}

export const ENCODE = [
  '-c:v',
  'libx264',
  '-preset',
  'veryfast',
  '-crf',
  '18',
  '-pix_fmt',
  'yuv420p',
  '-movflags',
  '+faststart',
];

/**
 * Repair input: join the frames of each range (one input per range, so nothing is buffered while another range plays), and with crop
 * cut that box out and scale it up to the frame width (replace models work better on a person filling the frame). No audio.
 * @param {{ input: string; frames: number; ranges: [number, number][]; crop?: number[]; width: number; height: number; output: string }} spec
 *   frames: frame count of input; ranges are cut to it (clampRanges).
 */
export function buildExtractArgs({ input, frames, ranges: wanted, crop, width, height, output }) {
  const ranges = clampRanges(wanted, frames);
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  for (const _ of ranges) args.push('-i', input);
  const filters = ranges.map(
    ([start, end], i) => `[${i}:v]trim=start_frame=${start}:end_frame=${end},setpts=PTS-STARTPTS[c${i}]`,
  );
  let joined = `${ranges.map((_, i) => `[c${i}]`).join('')}concat=n=${ranges.length}:v=1:a=0`;
  if (crop) {
    const box = cropPixels(crop, width, height);
    joined += `,crop=${box.w}:${box.h}:${box.x}:${box.y},scale=${width}:-2`;
  }
  filters.push(`${joined}[v]`);
  return [...args, '-filter_complex', filters.join(';'), '-map', '[v]', '-an', ...ENCODE, output];
}

/**
 * Alpha expression for a pasted box: opaque inside, fading to transparent over `feather` pixels at edges inside the frame,
 * hard at edges on the frame border (nothing to blend with there).
 */
function featherAlpha(box, width, height, feather) {
  const left = box.x > 0 ? 'X' : feather;
  const right = box.x + box.w < width ? '(W-1-X)' : feather;
  const top = box.y > 0 ? 'Y' : feather;
  const bottom = box.y + box.h < height ? '(H-1-Y)' : feather;
  return `255*min(1,min(min(${left},${right}),min(${top},${bottom}))/${feather})`;
}

/**
 * Put a repaired clip back over the frames buildExtractArgs took. The clip (any size, frame rate and a slightly different length)
 * is retimed to the ranges' total length, scaled to the frame or the box, and split back into the ranges in order. A whole-frame
 * clip replaces those frames; a box is overlaid on them with feathered inner edges. Frames outside the ranges and the audio are kept.
 * @param {{ video: string; frames: number; patch: string; patchDuration: number; ranges: [number, number][]; crop?: number[];
 *   width: number; height: number; fps: number; output: string }} spec
 *   frames: frame count of video; ranges are cut to it as in buildExtractArgs.
 */
export function buildPatchArgs(spec) {
  const { video, frames, patch, patchDuration, crop, width, height, fps, output } = spec;
  if (!(patchDuration > 0)) throw new Error('patch duration must be positive');
  const ranges = clampRanges(spec.ranges, frames);
  const box = crop ? cropPixels(crop, width, height) : { x: 0, y: 0, w: width, h: height };
  const feather = Math.max(2, Math.min(48, Math.floor(Math.min(box.w, box.h) / 4)));
  const length = ranges.reduce((sum, [start, end]) => sum + end - start, 0);
  const ratio = length / fps / patchDuration;

  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', video];
  const filters = [];
  const pieces = [];
  let input = 1;
  const base = (start, end) => {
    args.push('-i', video);
    const label = `b${input}`;
    filters.push(
      `[${input++}:v]trim=start_frame=${start}${end === null ? '' : `:end_frame=${end}`},setpts=PTS-STARTPTS[${label}]`,
    );
    return label;
  };
  let offset = 0;
  let previous = 0;
  for (const [start, end] of ranges) {
    if (start > previous) pieces.push(base(previous, start));
    args.push('-i', patch);
    const label = `p${input}`;
    filters.push(
      `[${input++}:v]setpts=${ratio.toFixed(6)}*(PTS-STARTPTS),fps=${fps},scale=${box.w}:${box.h},setsar=1,` +
        `tpad=stop_mode=clone:stop=${fps},trim=start_frame=${offset}:end_frame=${offset + end - start},setpts=PTS-STARTPTS` +
        (crop
          ? `,format=yuva420p,geq=lum='p(X,Y)':cb='p(X,Y)':cr='p(X,Y)':a='${featherAlpha(box, width, height, feather)}'`
          : '') +
        `[${label}]`,
    );
    if (crop) {
      const under = base(start, end);
      filters.push(`[${under}][${label}]overlay=${box.x}:${box.y}[o${label}]`);
      pieces.push(`o${label}`);
    } else pieces.push(label);
    offset += end - start;
    previous = end;
  }
  if (previous < frames) pieces.push(base(previous, null));
  filters.push(
    `${pieces.map((label) => `[${label}]`).join('')}concat=n=${pieces.length}:v=1:a=0,format=yuv420p[v]`,
  );
  return [
    ...args,
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[v]',
    '-map',
    '0:a?',
    '-c:a',
    'copy',
    ...ENCODE,
    output,
  ];
}

/** Silent version: drop the audio track, copy the video stream as-is. */
export function buildSilentArgs(input, output) {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    input,
    '-an',
    '-c:v',
    'copy',
    '-movflags',
    '+faststart',
    output,
  ];
}
