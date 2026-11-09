import { useEmailOtp } from '@shipwords/core/react/email-otp';
import { renderGoogleButton } from '@shipwords/core/react/google-identity';
import { track } from '@shipwords/core/react/track';
import { getRouteApi } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { authClient } from '~/lib/auth';
import { m } from '~/paraglide/messages.js';

// Sign-in dialog: Google button (Google's own popup, no page navigation, generator input is kept) plus email code.
// Open it from anywhere with openSignIn(); a then callback runs after sign-in (e.g. resume generating). /login is the no-JS fallback and reuses SignInPanel.

const OPEN_EVENT = 'site:sign-in';
let pending: (() => void) | null = null;

/** source goes into the sign_in_open event to show which step asked for sign-in. */
export function openSignIn(then?: () => void, source = 'nav') {
  pending = then ?? null;
  track('sign_in_open', { source });
  window.dispatchEvent(new Event(OPEN_EVENT));
}

const root = getRouteApi('__root__');

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
    // biome-ignore lint/a11y/useKeyWithClickEvents: clicking the backdrop is a mouse shortcut; keyboards close with native Esc.
    <dialog
      ref={dialog}
      className="dialog sign-in-dialog"
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
      <p className="muted">{m.common_sign_in_dialog_note()}</p>
      {open && <SignInPanel onDone={done} />}
    </dialog>
  );
}

export function SignInPanel({ onDone }: { onDone: () => void }) {
  const config = root.useLoaderData();
  const auth = authClient(config.googleClientId);
  const google = useRef<HTMLDivElement>(null);
  const otp = useEmailOtp(auth, {
    onSignedIn: onDone,
    messages: { sendFailed: m.common_sign_in_send_failed, invalidCode: m.common_sign_in_invalid_code },
  });
  const { setError } = otp;
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    // Official Google button: opens Google's popup without navigating. Dismiss One Tap first so both prompts never show at once.
    const clientId = config.googleClientId;
    const container = google.current;
    if (!clientId || !container) return;
    return renderGoogleButton(
      auth,
      clientId,
      container,
      {
        type: 'standard',
        theme: 'outline',
        size: 'large',
        text: 'continue_with',
        shape: 'pill',
        width: 300,
        locale: 'en',
      },
      {
        onResult: (ok) => {
          if (ok) done.current();
          else setError(m.common_sign_in_google_failed());
        },
        onUnavailable: () => setError(m.common_sign_in_google_unavailable()),
      },
    );
  }, [auth, config.googleClientId, setError]);

  return (
    <div className="sign-in">
      {config.googleClientId && (
        <>
          <div ref={google} className="google-button" />
          <p className="or mono">{m.common_sign_in_or_email()}</p>
        </>
      )}
      {otp.step === 'email' ? (
        <form onSubmit={otp.sendCode}>
          <label>
            {m.common_sign_in_email()}
            <input
              type="email"
              value={otp.email}
              onChange={(e) => otp.setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </label>
          <button type="submit" className="primary" disabled={otp.busy}>
            {otp.busy ? m.common_sign_in_sending() : m.common_sign_in_send_code()}
          </button>
        </form>
      ) : (
        <form onSubmit={otp.verify}>
          <p>{m.common_sign_in_code_sent({ email: otp.email })}</p>
          <label>
            {m.common_sign_in_code()}
            <input
              inputMode="numeric"
              pattern="[0-9]{6}"
              value={otp.otp}
              onChange={(e) => otp.setOtp(e.target.value)}
              required
              autoComplete="one-time-code"
            />
          </label>
          <button type="submit" className="primary" disabled={otp.busy}>
            {otp.busy ? m.common_sign_in_signing_in() : m.common_sign_in_submit()}
          </button>
          <button type="button" className="link-button" onClick={otp.changeEmail}>
            {m.common_sign_in_other_email()}
          </button>
        </form>
      )}
      {otp.error && <p className="error">{otp.error}</p>}
    </div>
  );
}
