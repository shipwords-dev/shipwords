import { describe, expect, it } from 'vitest';
import {
  buildExtractArgs,
  buildFfmpegArgs,
  buildPatchArgs,
  buildSilentArgs,
  checkRanges,
  clampRanges,
  cropPixels,
  matchCuts,
  parseCutTimes,
  parsePoints,
  splitAtCuts,
} from '../compose/compose.mjs';
import { nextRepairPass, shotFrames } from '../src/repair';

// ffmpeg itself runs in the container; here we only check args: retime ratio, frame-count cut, concat order, optional audio.
describe('compose args', () => {
  const spec = {
    segments: [
      { file: 'a.mp4', duration: 5, target: 5.333 },
      { file: 'b.mp4', duration: 4, target: 2.688 },
    ],
    width: 720,
    height: 1280,
    fps: 24,
    output: 'out.mp4',
  };

  it('retimes each segment by target/duration, cuts to target frame count, concatenates in order and mixes the original track', () => {
    const args = buildFfmpegArgs({ ...spec, audio: { file: 'song.mp4', start: 1.375, duration: 8.021 } });
    const graph = args[args.indexOf('-filter_complex') + 1]!;
    expect(graph).toContain('[0:v]setpts=1.066600*(PTS-STARTPTS)');
    expect(graph).toContain('trim=end_frame=128');
    expect(graph).toContain('[1:v]setpts=0.672000*(PTS-STARTPTS)');
    expect(graph).toContain('trim=end_frame=65');
    expect(graph).toContain('[v0][v1]concat=n=2:v=1:a=0[v]');
    expect(args).toEqual(
      expect.arrayContaining(['-ss', '1.375', '-t', '8.021', '-i', 'song.mp4', '-map', '2:a']),
    );
    expect(args.at(-1)).toBe('out.mp4');
  });

  it('an extra model frame does not affect the retime ratio: 6.04s counts as 6s, actual length used only beyond 1.5 frames', () => {
    const graph = (duration: number) => {
      const args = buildFfmpegArgs({ ...spec, segments: [{ file: 'a.mp4', duration, target: 6.292 }] });
      return args[args.indexOf('-filter_complex') + 1]!;
    };
    expect(graph(6.041667)).toContain('setpts=1.048667*(PTS-STARTPTS)');
    expect(graph(5.958333)).toContain('setpts=1.048667*(PTS-STARTPTS)');
    expect(graph(6.2)).toContain('setpts=1.014839*(PTS-STARTPTS)');
    expect(graph(6.041667)).toContain('trim=end_frame=151');
  });

  it('no audio mapping without a track; empty segments and non-positive durations throw', () => {
    expect(buildFfmpegArgs(spec)).not.toContain('-c:a');
    expect(() => buildFfmpegArgs({ ...spec, segments: [] })).toThrow(/no segments/);
    expect(() => buildFfmpegArgs({ ...spec, segments: [{ file: 'a', duration: 0, target: 1 }] })).toThrow(
      /positive/,
    );
  });

  it('silent version drops audio and copies the video stream as-is', () => {
    expect(buildSilentArgs('in.mp4', 'out.mp4')).toEqual(expect.arrayContaining(['-an', '-c:v', 'copy']));
  });
});

// Numbers from a real Kling 4.0 edit: 17.688 s cut list, output 18.042 s with every cut 1–3 frames late.
describe('shot cut alignment', () => {
  const cuts = [5.333, 11.625, 15.0];
  const detected = [5.375, 11.708333, 15.125];

  it('reads showinfo pts_time lines only', () => {
    const stderr = [
      "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'in.mp4':",
      '[Parsed_showinfo_1 @ 0x1] n:   0 pts:  10320 pts_time:5.375   duration:    512',
      '[Parsed_showinfo_1 @ 0x1] n:   1 pts:  22480 pts_time:11.708333 duration:    512',
      'frame=  433 fps=0.0 q=-0.0 Lsize=N/A time=00:00:18.04',
    ].join('\n');
    expect(parseCutTimes(stderr)).toEqual([5.375, 11.708333]);
  });

  it('matches each expected cut to the nearest detected one within the tolerance, ignores extra cuts, null when one is missing', () => {
    expect(matchCuts(cuts, [2.1, ...detected, 17.2])).toEqual(detected);
    expect(matchCuts(cuts, [5.375, 11.708333])).toBeNull();
    expect(matchCuts(cuts, [5.375, 12.3, 15.125])).toBeNull();
    // Two expected cuts never share one detected cut.
    expect(matchCuts([1, 1.2], [1.1])).toBeNull();
  });

  it('allows the whole render to run late or early by up to 0.5 s, but not shots that drift apart', () => {
    // Live Kling renders (2026-11-18): every cut late by 0.29–0.54 s. Matched against cut + 0.29 s, all within 0.25 s.
    expect(matchCuts(cuts, [5.625, 12.125, 15.542])).toEqual([5.625, 12.125, 15.542]);
    // The same shift early.
    expect(matchCuts(cuts, [4.9, 11.2, 14.5])).toEqual([4.9, 11.2, 14.5]);
    // One cut on time, the later ones a second late (the render dropped the end of the clip): no shared offset matches all.
    expect(matchCuts(cuts, [5.417, 12.625, 16.25])).toBeNull();
    // Later than the allowed shift plus the tolerance.
    expect(matchCuts(cuts, [6.4, 12.7, 16.1])).toBeNull();
    // Extra detected cuts (a flash at 5.9 s) are still ignored; the closest cuts win.
    expect(matchCuts(cuts, [2.1, 5.35, 5.9, 11.63, 15.02, 17.2])).toEqual([5.35, 11.63, 15.02]);
    // Uniformly 0.625 s late or early: past the 0.5 s shift, but a 0.5 s shift leaves 0.125 s per cut.
    expect(matchCuts(cuts, [5.958, 12.25, 15.625])).toEqual([5.958, 12.25, 15.625]);
    expect(matchCuts(cuts, [4.708, 11, 14.375])).toEqual([4.708, 11, 14.375]);
    // Only an offset between the observed differences fits (0.1–0.2 s here): interval ends are tried, not just the differences.
    expect(matchCuts([5, 10, 15], [4.9, 10.4, 15.3])).toEqual([4.9, 10.4, 15.3]);
    // Cuts 0.875 s apart in their drift: no single offset brings them all within 0.3 s.
    expect(matchCuts([5, 10, 15], [4.875, 10.75, 15.75])).toBeNull();
    // The in-order assignment is scored as a whole: taking the nearest cut for 5 s (5.15) would leave nothing for 5.4 s.
    expect(matchCuts([5, 5.4], [4.75, 5.15], 0.3, 0)).toEqual([4.75, 5.15]);
    // Equally good either way: late wins (renders pad the start).
    expect(matchCuts([5], [4.5, 5.5])).toEqual([5.5]);
    // Scene detection can log one cut twice; two cuts never land on the same time (a zero-length shot).
    expect(matchCuts([5, 5.1], [5.05, 5.05, 5.35])).toEqual([5.05, 5.35]);
    expect(matchCuts([], [1])).toEqual([]);
    expect(matchCuts([], [])).toEqual([]);
  });

  it('splits into shots retimed to their exact lengths; the last shot uses the last cut drift and is cut to the remaining target', () => {
    const pieces = splitAtCuts({ file: 'k.mp4', duration: 18.041995, target: 17.688, cuts, detected });
    expect(pieces.map((p) => p.start)).toEqual([0, 5.375, 11.708333, 15.125]);
    expect(pieces.map((p) => p.target)).toEqual([5.333, 11.625 - 5.333, 15 - 11.625, 17.688 - 15]);
    for (const piece of pieces.slice(0, 3)) expect(piece.duration * piece.ratio).toBeCloseTo(piece.target, 9);
    expect(pieces[3]!.ratio).toBeCloseTo(15 / 15.125, 9);
    const args = buildFfmpegArgs({ segments: pieces, width: 720, height: 1280, fps: 24, output: 'o.mp4' });
    expect(args.slice(0, 12)).toEqual([
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-ss',
      '0.000000',
      '-t',
      '5.375000',
      '-i',
      'k.mp4',
      '-ss',
      '5.375000',
    ]);
    const graph = args[args.indexOf('-filter_complex') + 1]!;
    expect(graph).toContain('[0:v]setpts=0.992186*(PTS-STARTPTS)');
    expect(graph).toContain('[3:v]setpts=0.991736*(PTS-STARTPTS)');
    // 5.333 + 6.292 + 3.375 + 2.688 s at 24 fps: 128 + 151 + 81 + 65 frames.
    for (const frames of [128, 151, 81, 65]) expect(graph).toContain(`trim=end_frame=${frames},`);
  });
});

describe('last shot length', () => {
  const cuts = [5.333, 11.625, 15.0];
  const detected = [5.375, 11.708333, 15.125];
  const split = (duration: number) =>
    splitAtCuts({ file: 'k.mp4', duration, target: 17.688, cuts, detected });

  it('pads by whatever the retimed segment is short of target, at least one second, so the frame cut is always exact', () => {
    // Last shot 2.4 s of output at 0.9917: 2.38 s for a 2.688 s target, 8 frames short.
    const pieces = split(15.125 + 2.4);
    const graph = buildFfmpegArgs({
      segments: pieces,
      width: 720,
      height: 1280,
      fps: 24,
      output: 'o.mp4',
    }).find((arg) => arg.includes('concat='))!;
    const last = graph.split(';')[3]!;
    expect(last).toContain('trim=end_frame=65,');
    const pad = Number(last.match(/tpad=stop_mode=clone:stop=(\d+)/)![1]);
    expect(pad).toBeGreaterThanOrEqual(24 + 8);
    // A plain retimed segment far shorter than its target gets the full gap, not one second.
    const short = buildFfmpegArgs({
      segments: [{ file: 'a.mp4', duration: 1, target: 4, ratio: 1 }],
      width: 720,
      height: 1280,
      fps: 24,
      output: 'o.mp4',
    }).find((arg) => arg.includes('concat='))!;
    expect(short).toContain('tpad=stop_mode=clone:stop=96,trim=end_frame=96,');
  });

  it('a last shot more than half a second short means the model dropped the end: throws', () => {
    expect(() => split(15.125 + 2.4)).not.toThrow();
    expect(() => split(15.125 + 1.0)).toThrow(/last shot/);
  });
});

describe('output check points', () => {
  it('accepts 1–10 [x, y] or [x, y, t] points (x, y in 0–1, t in 0–60 s), rejects anything else', () => {
    expect(parsePoints('[[0.48,0.5],[0.1,0.21,11.67]]')).toEqual([
      [0.48, 0.5],
      [0.1, 0.21, 11.67],
    ]);
    for (const bad of [
      '[]',
      '[[0.5]]',
      '[[0.5,1.2]]',
      '[[0.5,0.5,-1]]',
      '[[0.5,0.5,61]]',
      '[[0.5,0.5,1,2]]',
      '[["0.5",0.5]]',
      '{"x":1}',
      JSON.stringify(Array(11).fill([0.5, 0.5])),
    ]) {
      expect(() => parsePoints(bad)).toThrow();
    }
    expect(() => parsePoints('not json')).toThrow();
  });
});

// Ran against real ffmpeg on a composed 720×1280 clip with a tinted 25 fps 768-wide stand-in for the model output: 425 frames out,
// repaired frames exactly inside the ranges, poses lined up, audio kept. Here only the args.
describe('repair args', () => {
  const ranges: [number, number][] = [
    [0, 128],
    [360, 425],
  ];

  it('extract: one input per range trimmed by frame, joined, no audio; crop cuts the box in even pixels and scales it to full width', () => {
    const args = buildExtractArgs({
      input: 'in.mp4',
      frames: 425,
      ranges,
      width: 720,
      height: 1280,
      output: 'clip.mp4',
    });
    const graph = args[args.indexOf('-filter_complex') + 1]!;
    expect(args.filter((arg) => arg === 'in.mp4')).toHaveLength(2);
    expect(graph).toBe(
      '[0:v]trim=start_frame=0:end_frame=128,setpts=PTS-STARTPTS[c0];' +
        '[1:v]trim=start_frame=360:end_frame=425,setpts=PTS-STARTPTS[c1];[c0][c1]concat=n=2:v=1:a=0[v]',
    );
    expect(args).toContain('-an');
    const cropped = buildExtractArgs({
      input: 'in.mp4',
      frames: 425,
      ranges,
      crop: [0, 0, 0.444, 0.3875],
      width: 720,
      height: 1280,
      output: 'clip.mp4',
    });
    expect(cropped[cropped.indexOf('-filter_complex') + 1]).toContain(
      'concat=n=2:v=1:a=0,crop=320:496:0:0,scale=720:-2[v]',
    );
  });

  it('extract with audio: the same stretch of the soundtrack goes along, cut by time at the frame bounds', () => {
    const args = buildExtractArgs({
      input: 'in.mp4',
      frames: 425,
      ranges,
      width: 720,
      height: 1280,
      fps: 24,
      audio: true,
      output: 'clip.mp4',
    });
    const graph = args[args.indexOf('-filter_complex') + 1]!;
    expect(graph).toContain('[0:a]atrim=start=0.000000:end=5.333333,asetpts=PTS-STARTPTS[s0]');
    expect(graph).toContain('[1:a]atrim=start=15.000000:end=17.708333,asetpts=PTS-STARTPTS[s1]');
    expect(graph).toContain('[c0][s0][c1][s1]concat=n=2:v=1:a=1[j][a];[j]null[v]');
    expect(args).toEqual(expect.arrayContaining(['-map', '[v]', '-map', '[a]', '-c:a', 'aac']));
    expect(args).not.toContain('-an');
    const cropped = buildExtractArgs({
      input: 'in.mp4',
      frames: 425,
      ranges,
      crop: [0, 0, 0.444, 0.3875],
      width: 720,
      height: 1280,
      fps: 24,
      audio: true,
      output: 'clip.mp4',
    });
    expect(cropped[cropped.indexOf('-filter_complex') + 1]).toContain(
      'concat=n=2:v=1:a=1[j][a];[j]null,crop=320:496:0:0,scale=720:-2[v]',
    );
    expect(() =>
      buildExtractArgs({
        input: 'in.mp4',
        frames: 425,
        ranges,
        width: 720,
        height: 1280,
        audio: true,
        output: 'c.mp4',
      }),
    ).toThrow(/fps/);
  });

  it('patch: the clip is retimed to the ranges, split back in order between kept frames, audio copied from the video', () => {
    const args = buildPatchArgs({
      video: 'in.mp4',
      frames: 425,
      patch: 'out.mp4',
      patchDuration: 8.2,
      ranges,
      width: 720,
      height: 1280,
      fps: 24,
      output: 'song.mp4',
    });
    const graph = args[args.indexOf('-filter_complex') + 1]!;
    // 193 frames = 8.041667 s at 24 fps, from an 8.2 s clip.
    // A whole-frame clip covers the frame and is cut to it around the center (replace models render at their own aspect).
    expect(graph).toContain(
      '[1:v]setpts=0.980691*(PTS-STARTPTS),fps=24,scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,setsar=1,',
    );
    expect(graph).toContain('trim=start_frame=0:end_frame=128,setpts=PTS-STARTPTS[p1]');
    expect(graph).toContain('[2:v]trim=start_frame=128:end_frame=360,setpts=PTS-STARTPTS[b2]');
    expect(graph).toContain('trim=start_frame=128:end_frame=193,setpts=PTS-STARTPTS[p3]');
    // The last range ends at the last frame: no empty tail piece.
    expect(graph).toContain('[p1][b2][p3]concat=n=3:v=1:a=0,format=yuv420p[v]');
    expect(args).toEqual(expect.arrayContaining(['-map', '0:a?', '-c:a', 'copy']));
  });

  it('ranges are cut to the frames the video has: compose ends with the soundtrack and can drop the last frame', () => {
    // A composed 17.688 s cut measured 424 frames (shot lengths add up to 425); extract and patch must cut alike.
    const extract = buildExtractArgs({
      input: 'in.mp4',
      frames: 424,
      ranges,
      width: 720,
      height: 1280,
      output: 'clip.mp4',
    });
    expect(extract[extract.indexOf('-filter_complex') + 1]).toContain('trim=start_frame=360:end_frame=424');
    const patched = buildPatchArgs({ ...spec(), frames: 424 });
    const graph = patched[patched.indexOf('-filter_complex') + 1]!;
    // 192 frames now, so the retime and the last patch piece follow.
    expect(graph).toContain('setpts=0.975610*(PTS-STARTPTS)');
    expect(graph).toContain('trim=start_frame=128:end_frame=192');
    expect(
      clampRanges(
        [
          [0, 10],
          [500, 600],
        ],
        425,
      ),
    ).toEqual([[0, 10]]);
    expect(() => clampRanges([[500, 600]], 425)).toThrow(/past the video/);
  });

  it('patch with a box: overlaid on the kept frames, feathered only on edges inside the frame', () => {
    const graph = (crop: number[]) => {
      const args = buildPatchArgs({ ...spec(), crop });
      return args[args.indexOf('-filter_complex') + 1]!;
    };
    const corner = graph([0, 0, 0.444, 0.3875]);
    expect(corner).toContain('scale=320:496');
    expect(corner).toContain("a='255*min(1,min(min(48,(W-1-X)),min(48,(H-1-Y)))/48)'");
    expect(corner).toContain('[b2][p1]overlay=0:0[op1]');
    expect(graph([0.25, 0.25, 0.5, 0.5])).toContain("a='255*min(1,min(min(X,(W-1-X)),min(Y,(H-1-Y)))/48)'");
  });

  it('rejects bad ranges and boxes', () => {
    expect(
      checkRanges([
        [0, 10],
        [10, 20],
      ]),
    ).toEqual([
      [0, 10],
      [10, 20],
    ]);
    for (const bad of [
      [],
      [[5, 5]],
      [
        [10, 20],
        [5, 8],
      ],
      [[0, 1.5]],
      [[-1, 3]],
      'x',
      Array(11).fill([0, 1]),
    ])
      expect(() => checkRanges(bad)).toThrow();
    expect(cropPixels([0.9, 0.9, 0.2, 0.2], 720, 1280)).toEqual({ x: 648, y: 1152, w: 72, h: 128 });
    for (const bad of [[0, 0, 0, 0.5], [0, 0, 1.2, 0.5], [0, 0, 0.5], 'x'])
      expect(() => cropPixels(bad, 720, 1280)).toThrow();
  });

  function spec() {
    return {
      video: 'in.mp4',
      frames: 425,
      patch: 'out.mp4',
      patchDuration: 8.2,
      ranges,
      width: 720,
      height: 1280,
      fps: 24,
      output: 'song.mp4',
    };
  }
});

describe('repair planning', () => {
  const repair = {
    upstreamModel: 'm',
    prompt: () => '',
    parameters: {},
    maxCost: '0.1',
    rounds: 3,
    shots: [['front', 'edge'], ['solo'], ['front', 'edge']],
    crops: { edge: [0, 0, 0.4, 0.4] as const },
  };

  it('shot frames: final-cut shot times to frame ranges, adjacent shots merged', () => {
    expect(shotFrames([5.333, 11.625, 15], 17.688, 24, [0, 3])).toEqual([
      [0, 128],
      [360, 425],
    ]);
    expect(shotFrames([2, 4], 6, 24, [2, 1])).toEqual([[48, 144]]);
    // Compose rounds each shot on its own (24, 24, 23 frames), not the cut times (24, 49, 72).
    expect(shotFrames([1.02, 2.04], 3, 24, [2])).toEqual([[48, 71]]);
  });

  it('whole frame for the missed person alone first, the box after that; another person in the same shots gets their own pass', () => {
    const filled = ['front', 'edge', 'solo'];
    const first = nextRepairPass(repair, filled, ['edge'], []);
    expect(first).toEqual({ slots: ['edge'], shots: [0, 2] });
    expect(nextRepairPass(repair, filled, ['edge'], [first!])).toEqual({
      slots: ['edge'],
      shots: [0, 2],
      crop: [0, 0, 0.4, 0.4],
    });
    // edge's pass on these shots doesn't count as front's: front gets a whole-frame pass of its own.
    expect(nextRepairPass(repair, filled, ['front'], [first!])).toEqual({ slots: ['front'], shots: [0, 2] });
    // An unfilled slot keeps the original person and is never repaired.
    expect(nextRepairPass(repair, ['edge', 'solo'], ['front'], [])).toBeNull();
    // Unfilled people stay as the original and get no photo.
    expect(nextRepairPass(repair, ['edge', 'solo'], ['edge'], [])).toEqual({
      slots: ['edge'],
      shots: [0, 2],
    });
    expect(nextRepairPass(repair, filled, ['nobody'], [])).toBeNull();
  });
});
