// Type declarations for compose.mjs: the container runs the .mjs directly with Node, tests import it from TypeScript.
export interface Segment {
  file: string;
  duration: number;
  target: number;
  fit?: 'stretch' | 'trim';
  start?: number;
  ratio?: number;
}
export interface Audio {
  file: string;
  start: number;
  duration: number;
}
export function buildFfmpegArgs(spec: {
  segments: Segment[];
  audio?: Audio | null;
  width: number;
  height: number;
  fps: number;
  output: string;
}): string[];
export function buildSilentArgs(input: string, output: string): string[];
export function parsePoints(text: string): ([number, number] | [number, number, number])[];
export function buildCutArgs(file: string): string[];
export function checkRanges(ranges: unknown): [number, number][];
export function cropPixels(
  box: unknown,
  width: number,
  height: number,
): { x: number; y: number; w: number; h: number };
export function clampRanges(ranges: [number, number][], frames: number): [number, number][];
export function buildExtractArgs(spec: {
  input: string;
  frames: number;
  ranges: [number, number][];
  crop?: readonly number[];
  width: number;
  height: number;
  fps?: number;
  audio?: boolean;
  output: string;
}): string[];
export function buildPatchArgs(spec: {
  video: string;
  frames: number;
  patch: string;
  patchDuration: number;
  ranges: [number, number][];
  crop?: readonly number[];
  width: number;
  height: number;
  fps: number;
  output: string;
}): string[];
export function parseCutTimes(stderr: string): number[];
export function matchCuts(
  expected: readonly number[],
  detected: readonly number[],
  tolerance?: number,
  shift?: number,
): number[] | null;
export function splitAtCuts(input: {
  file: string;
  duration: number;
  target: number;
  cuts: readonly number[];
  detected: readonly number[];
}): Required<Pick<Segment, 'file' | 'start' | 'duration' | 'target' | 'ratio'>>[];
