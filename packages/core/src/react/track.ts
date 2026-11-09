// Rybbit custom events, headless. Each site lists its own funnel (event names) where it calls track().
// Simple clicks use the data-rybbit-event attribute and are collected by the Rybbit script; this only handles events that carry state.
// The script loads with defer: earlier events are queued and flushed once it loads. Local dev never loads it, so events stay queued.

type Props = Record<string, string | number | boolean>;
type Rybbit = { event(name: string, props?: Props): void; identify?(userId: string): void };

const queue: (() => void)[] = [];
let waiting = false;

function rybbit(): Rybbit | undefined {
  return (window as { rybbit?: Rybbit }).rybbit;
}

function flush() {
  const client = rybbit();
  if (!client) return false;
  for (const send of queue.splice(0)) send();
  return true;
}

function later(send: () => void) {
  queue.push(send);
  if (waiting || flush()) return;
  waiting = true;
  let tries = 0;
  const timer = setInterval(() => {
    if (flush() || ++tries > 30) {
      clearInterval(timer);
      waiting = false;
    }
  }, 500);
}

export function track(name: string, props?: Props) {
  if (typeof window === 'undefined') return;
  later(() => rybbit()?.event(name, props));
}

let identified: string | null = null;

/** After sign-in, links the visitor session to the user id (no email sent). */
export function identify(userId: string) {
  if (typeof window === 'undefined' || identified === userId) return;
  identified = userId;
  later(() => rybbit()?.identify?.(userId));
}
