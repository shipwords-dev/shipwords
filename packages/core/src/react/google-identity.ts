import type { SiteAuthClient } from './auth-client';
import { track } from './track';

// Google sign-in without page navigation: the One Tap prompt and the official button (Google's own popup), headless.
// The Google script is initialized once per page: One Tap and the button share one callback, otherwise a second initialize wipes
// the earlier button. The idToken goes to better-auth's one-tap callback to create the session.

type Gsi = {
  initialize(options: Record<string, unknown>): void;
  renderButton(container: HTMLElement, options: Record<string, unknown>): void;
  prompt(): void;
  cancel(): void;
};

let gsiReady: Promise<Gsi> | null = null;
/** Result of the latest Google sign-in, for the button currently shown (One Tap only refreshes the session). */
let afterGoogle: (ok: boolean) => void = () => undefined;

function googleIdentity(auth: SiteAuthClient, clientId: string): Promise<Gsi> {
  gsiReady ??= loadGsi().then((gsi) => {
    gsi.initialize({
      client_id: clientId,
      ux_mode: 'popup',
      cancel_on_tap_outside: true,
      itp_support: true,
      callback: async ({ credential }: { credential: string }) => {
        const result = await auth.$fetch('/one-tap/callback', {
          method: 'POST',
          body: { idToken: credential },
        });
        if (!result.error) auth.$store.notify('$sessionSignal');
        track(result.error ? 'sign_in_failed' : 'sign_in', { method: 'google' });
        afterGoogle(!result.error);
      },
    });
    return gsi;
  });
  gsiReady.catch(() => {
    gsiReady = null;
  });
  return gsiReady;
}

function loadGsi(): Promise<Gsi> {
  const existing = (window as { google?: { accounts?: { id?: Gsi } } }).google?.accounts?.id;
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client?hl=en';
    script.async = true;
    script.onload = () => {
      const gsi = (window as { google?: { accounts?: { id?: Gsi } } }).google?.accounts?.id;
      if (gsi) resolve(gsi);
      else reject(new Error('Google Identity Services did not load'));
    };
    script.onerror = () => reject(new Error('Google Identity Services did not load'));
    document.head.appendChild(script);
  });
}

/** Shows Google One Tap to signed-out visitors; on success only the session refreshes, no navigation. */
export function promptGoogleOneTap(auth: SiteAuthClient, clientId: string) {
  void googleIdentity(auth, clientId)
    .then((gsi) => gsi.prompt())
    .catch(() => undefined);
}

/**
 * Renders the official Google button into `container`, dismissing One Tap first so both prompts never show at once.
 * `options` are Google's renderButton options (theme, size, text...). `onResult` gets each sign-in outcome from this button;
 * `onUnavailable` runs when Google's script can't load. Returns a cleanup for useEffect.
 */
export function renderGoogleButton(
  auth: SiteAuthClient,
  clientId: string,
  container: HTMLElement,
  options: Record<string, unknown>,
  handlers: { onResult: (ok: boolean) => void; onUnavailable: () => void },
): () => void {
  let cancelled = false;
  afterGoogle = handlers.onResult;
  void googleIdentity(auth, clientId)
    .then((gsi) => {
      if (cancelled) return;
      gsi.cancel();
      gsi.renderButton(container, options);
    })
    .catch(() => handlers.onUnavailable());
  return () => {
    cancelled = true;
    afterGoogle = () => undefined;
  };
}
