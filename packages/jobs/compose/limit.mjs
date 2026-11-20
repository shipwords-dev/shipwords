// Concurrency lanes of the compose service (server.mjs). ffmpeg and the face checks are CPU-heavy, so each lane runs a few at a time and
// lets a bounded number wait, their bodies unread until their turn; beyond that a request is refused (Busy, answered 503) so the caller
// retries later instead of piling up connections.
//
// Two lanes, so work someone is waiting on in a browser never queues behind background jobs:
// - background (default): job steps (swap checks, likeness, repair cut and patch, the final stitch). Their steps retry and their jobs
//   take minutes anyway.
// - interactive: a stitch inside a web request (a site that composes while the visitor waits), asked for with the header
//   `x-compose-lane: interactive`. It has slots of its own that background work never takes, so its wait is bounded by other interactive
//   requests only, not by every site's background work on the machine.

export class Busy extends Error {}

export const LANE_HEADER = 'x-compose-lane';

/** A lane: at most max running, at most maxWaiting queued in arrival order. */
export function createLane(max, maxWaiting) {
  let running = 0;
  const waiting = [];
  return {
    get running() {
      return running;
    },
    get waiting() {
      return waiting.length;
    },
    /**
     * Run work in this lane. gone: called with a callback that fires if the caller goes away while queued (it then leaves the queue
     * and the promise rejects).
     */
    async run(work, gone = () => {}) {
      if (running >= max) {
        if (waiting.length >= maxWaiting) throw new Busy('busy');
        await new Promise((resolve, reject) => {
          const entry = { resolve, reject };
          waiting.push(entry);
          gone(() => {
            const index = waiting.indexOf(entry);
            if (index >= 0) {
              waiting.splice(index, 1);
              reject(new Error('caller went away'));
            }
          });
        });
      }
      running++;
      try {
        return await work();
      } finally {
        running--;
        waiting.shift()?.resolve();
      }
    },
  };
}

/** The service's lanes from its environment: MAX_JOBS / MAX_WAITING (background), MAX_INTERACTIVE_JOBS / MAX_INTERACTIVE_WAITING. */
export function createLanes(env = process.env) {
  const count = (value, fallback, min) => {
    const n = value === undefined || value === '' ? Number.NaN : Math.floor(Number(value));
    return Number.isFinite(n) ? Math.max(min, n) : fallback;
  };
  return {
    background: createLane(count(env.MAX_JOBS, 2, 1), count(env.MAX_WAITING, 8, 0)),
    interactive: createLane(count(env.MAX_INTERACTIVE_JOBS, 1, 1), count(env.MAX_INTERACTIVE_WAITING, 4, 0)),
  };
}

/** The lane a request asked for; anything but "interactive" is background. */
export function laneOf(headers) {
  return headers?.[LANE_HEADER] === 'interactive' ? 'interactive' : 'background';
}
