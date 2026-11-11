import { getRouteApi } from '@tanstack/react-router';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { authClient } from '~/lib/auth';
import { track } from '~/lib/track';
import { m } from '~/paraglide/messages.js';

// Sign-in dialog: Google button (Google's own popup, no page navigation, stage photos stay) + email code.
// Open it anywhere with openSignIn(); pass then to continue after sign-in (e.g. resume generation). The /login page reuses SignInPanel.

const OPEN_EVENT = 'tinydesk:sign-in';
let pending: (() => void) | null = null;

/** source goes into the sign_in_open event to show which step sign-in blocked. */
export function openSignIn(then?: () => void, source = 'nav') {
  pending = then ?? null;
  track('sign_in_open', { source });
  window.dispatchEvent(new Event(OPEN_EVENT));
}

const root = getRouteApi('__root__');

type Gsi = {
  initialize(options: Record<string, unknown>): void;
  renderButton(container: HTMLElement, options: Record<string, unknown>): void;
  prompt(): void;
  cancel(): void;
};

// The Google script is initialized once per page: the One Tap prompt on load and the button in the dialog share one callback,
// otherwise a later initialize wipes the button rendered earlier. The idToken goes to better-auth's one-tap callback to create the session.
let gsiReady: Promise<Gsi> | null = null;
let afterGoogle: (ok: boolean) => void = () => undefined;

function googleIdentity(clientId: string): Promise<Gsi> {
  gsiReady ??= loadGsi().then((gsi) => {
    gsi.initialize({
      client_id: clientId,
      ux_mode: 'popup',
      cancel_on_tap_outside: true,
      itp_support: true,
      callback: async ({ credential }: { credential: string }) => {
        const auth = authClient(clientId);
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

/** Shows Google One Tap to signed-out visitors on arrival; a successful sign-in only refreshes the session, no navigation. */
export function promptGoogleOneTap(clientId: string) {
  void googleIdentity(clientId)
    .then((gsi) => gsi.prompt())
    .catch(() => undefined);
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

export function SignInDialog() {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onOpen = () => {
      setOpen(true);
      dialog.current?.showModal();
    };
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, []);

  function close() {
    dialog.current?.close();
  }

  function done() {
    const then = pending;
    pending = null;
    close();
    then?.();
  }

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: clicking the backdrop is a mouse shortcut; keyboard users close with native Esc.
    <dialog
      ref={dialog}
      className="sign-in-dialog"
      aria-labelledby="sign-in-title"
      onClose={() => setOpen(false)}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <button type="button" className="dialog-close" aria-label={m.common_close()} onClick={close}>
        ×
      </button>
      <h2 id="sign-in-title">{m.common_sign_in_dialog_title()}</h2>
      <p className="muted sign-in-note">{m.common_sign_in_dialog_note()}</p>
      {open && <SignInPanel onDone={done} />}
    </dialog>
  );
}

export function SignInPanel({ onDone }: { onDone: () => void }) {
  const config = root.useLoaderData();
  const auth = authClient(config.googleClientId);
  const google = useRef<HTMLDivElement>(null);
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    // Official Google button: opens Google's popup, no navigation. Dismiss One Tap first so both entry points never show at once.
    const clientId = config.googleClientId;
    const container = google.current;
    if (!clientId || !container) return;
    let cancelled = false;
    afterGoogle = (ok) => {
      if (ok) done.current();
      else setError(m.common_sign_in_google_failed());
    };
    void googleIdentity(clientId)
      .then((gsi) => {
        if (cancelled) return;
        gsi.cancel();
        gsi.renderButton(container, {
          type: 'standard',
          theme: 'filled_black',
          size: 'large',
          text: 'continue_with',
          shape: 'pill',
          width: 300,
          locale: 'en',
        });
      })
      .catch(() => setError(m.common_sign_in_google_unavailable()));
    return () => {
      cancelled = true;
      afterGoogle = () => undefined;
    };
  }, [config.googleClientId]);

  async function sendCode(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await auth.emailOtp.sendVerificationOtp({ email, type: 'sign-in' });
    setBusy(false);
    if (result.error) setError(result.error.message ?? m.common_sign_in_send_failed());
    else {
      track('sign_in_code_sent');
      setStep('code');
    }
  }

  async function verify(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await auth.signIn.emailOtp({ email, otp });
    setBusy(false);
    track(result.error ? 'sign_in_failed' : 'sign_in', { method: 'email' });
    if (result.error) setError(result.error.message ?? m.common_sign_in_invalid_code());
    else onDone();
  }

  return (
    <div className="sign-in">
      {config.googleClientId && (
        <>
          <div ref={google} className="google-button" />
          <p className="or mono">{m.common_sign_in_or_email()}</p>
        </>
      )}
      {step === 'email' ? (
        <form onSubmit={sendCode}>
          <label>
            {m.common_sign_in_email()}
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </label>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? m.common_sign_in_sending() : m.common_sign_in_send_code()}
          </button>
        </form>
      ) : (
        <form onSubmit={verify}>
          <p>{m.common_sign_in_code_sent({ email })}</p>
          <label>
            {m.common_sign_in_code()}
            <input
              inputMode="numeric"
              pattern="[0-9]{6}"
              value={otp}
              onChange={(e) => setOtp(e.target.value)}
              required
              autoComplete="one-time-code"
            />
          </label>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? m.common_sign_in_signing_in() : m.common_sign_in_submit()}
          </button>
          <button type="button" className="link-button" onClick={() => setStep('email')}>
            {m.common_sign_in_other_email()}
          </button>
        </form>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
