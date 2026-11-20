// Type declarations for limit.mjs: the service runs the .mjs directly with Node, tests import it from TypeScript.
export class Busy extends Error {}
export const LANE_HEADER: 'x-compose-lane';
export interface Lane {
  readonly running: number;
  readonly waiting: number;
  run<T>(work: () => Promise<T>, gone?: (leave: () => void) => void): Promise<T>;
}
export function createLane(max: number, maxWaiting: number): Lane;
export function createLanes(env?: Record<string, string | undefined>): {
  background: Lane;
  interactive: Lane;
};
export function laneOf(
  headers: Record<string, string | string[] | undefined> | undefined,
): 'background' | 'interactive';
