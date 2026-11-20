import { describe, expect, it } from 'vitest';
import { Busy, createLane, createLanes, laneOf } from '../compose/limit.mjs';

// The compose service's concurrency lanes: a stitch a visitor waits on must not queue behind the machine's background job steps.

function gate() {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('compose service lanes', () => {
  it('an interactive request runs at once while background work fills its lane and queue', async () => {
    const lanes = createLanes({ MAX_JOBS: '2', MAX_WAITING: '1', MAX_INTERACTIVE_JOBS: '1' });
    const hold = gate();
    const background = [0, 1, 2].map(() => lanes.background.run(() => hold.opened));
    await tick();
    expect(lanes.background.running).toBe(2);
    expect(lanes.background.waiting).toBe(1);
    // The background queue is full: one more is refused (503), so its step retries later.
    await expect(lanes.background.run(async () => 'late')).rejects.toBeInstanceOf(Busy);
    // The interactive lane is untouched by all of that.
    await expect(lanes.interactive.run(async () => 'stitched')).resolves.toBe('stitched');
    hold.open();
    await Promise.all(background);
    expect(lanes.background.running).toBe(0);
  });

  it('runs at most max at a time, the rest in arrival order; a caller that goes away leaves the queue', async () => {
    const lane = createLane(1, 5);
    const order: string[] = [];
    const hold = gate();
    const first = lane.run(async () => {
      await hold.opened;
      order.push('a');
    });
    let leave = () => {};
    const gone = lane.run(
      async () => order.push('gone'),
      (fn) => {
        leave = fn;
      },
    );
    const second = lane.run(async () => order.push('b'));
    await tick();
    expect(lane.waiting).toBe(2);
    leave();
    await expect(gone).rejects.toThrow(/went away/);
    hold.open();
    await Promise.all([first, second]);
    expect(order).toEqual(['a', 'b']);
  });

  it('reads its limits from the environment, with defaults', () => {
    const lanes = createLanes({});
    expect(laneOf({ 'x-compose-lane': 'interactive' })).toBe('interactive');
    expect(laneOf({ 'x-compose-lane': 'other' })).toBe('background');
    expect(laneOf({})).toBe('background');
    expect(lanes.background.running + lanes.interactive.running).toBe(0);
    // MAX_WAITING=0 means no queue at all: the second request is refused while the first runs.
    const strict = createLanes({ MAX_JOBS: '1', MAX_WAITING: '0' });
    const hold = gate();
    const running = strict.background.run(() => hold.opened);
    return expect(strict.background.run(async () => 1))
      .rejects.toBeInstanceOf(Busy)
      .then(() => {
        hold.open();
        return running;
      });
  });

  it('keeps the limits the service had before the lanes for every way a value can be set', async () => {
    /** How many requests a lane runs at once and how many it queues before it refuses one. */
    async function capacity(env: Record<string, string>, lane: 'background' | 'interactive' = 'background') {
      const target = createLanes(env)[lane];
      const hold = gate();
      const started: Promise<unknown>[] = [];
      for (let i = 0; i < 50; i++) {
        const run = target.run(() => hold.opened);
        run.catch(() => {});
        started.push(run);
      }
      await tick();
      const result = { running: target.running, waiting: target.waiting };
      hold.open();
      await Promise.allSettled(started);
      return result;
    }
    expect(await capacity({})).toEqual({ running: 2, waiting: 8 });
    // A slot count of 0, empty or not a number falls back to the default, as MAX_JOBS did.
    expect(await capacity({ MAX_JOBS: '0' })).toEqual({ running: 2, waiting: 8 });
    expect(await capacity({ MAX_JOBS: '' })).toEqual({ running: 2, waiting: 8 });
    expect(await capacity({ MAX_JOBS: 'x' })).toEqual({ running: 2, waiting: 8 });
    expect(await capacity({ MAX_JOBS: '-3' })).toEqual({ running: 1, waiting: 8 });
    expect(await capacity({ MAX_JOBS: '4' })).toEqual({ running: 4, waiting: 8 });
    // An explicit 0 or empty queue length means no queue, as MAX_WAITING did; a negative one too.
    expect(await capacity({ MAX_WAITING: '0' })).toEqual({ running: 2, waiting: 0 });
    expect(await capacity({ MAX_WAITING: '' })).toEqual({ running: 2, waiting: 0 });
    expect(await capacity({ MAX_WAITING: '-1' })).toEqual({ running: 2, waiting: 0 });
    // Not a number: bounded at the default rather than unbounded.
    expect(await capacity({ MAX_WAITING: 'x' })).toEqual({ running: 2, waiting: 8 });
    expect(await capacity({}, 'interactive')).toEqual({ running: 1, waiting: 4 });
    expect(
      await capacity({ MAX_INTERACTIVE_JOBS: '0', MAX_INTERACTIVE_WAITING: '0' }, 'interactive'),
    ).toEqual({
      running: 1,
      waiting: 0,
    });
  });
});
