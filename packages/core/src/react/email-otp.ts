import { type FormEvent, useState } from 'react';
import type { SiteAuthClient } from './auth-client';
import { track } from './track';

// Email code sign-in as a headless hook: enter email → send code → enter code. The site renders the forms and its own copy.

export function useEmailOtp(
  auth: SiteAuthClient,
  options: {
    onSignedIn: () => void;
    /** Shown when the provider gives no message of its own. */
    messages: { sendFailed: () => string; invalidCode: () => string };
  },
) {
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sendCode(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await auth.emailOtp.sendVerificationOtp({ email, type: 'sign-in' });
    setBusy(false);
    if (result.error) setError(result.error.message ?? options.messages.sendFailed());
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
    if (result.error) setError(result.error.message ?? options.messages.invalidCode());
    else options.onSignedIn();
  }

  return {
    email,
    setEmail,
    otp,
    setOtp,
    step,
    /** Back to the email step to use another address. */
    changeEmail: () => setStep('email'),
    busy,
    error,
    setError,
    sendCode,
    verify,
  };
}
