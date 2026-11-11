import { ApiError } from '@shipwords/core/react/account';
import { uploadReference } from '@shipwords/jobs/react';
import { useEffect, useRef, useState } from 'react';
import { renderSVG } from 'uqr';
import { track } from '~/lib/track';
import { m } from '~/paraglide/messages.js';

// Upload photos from a phone by QR code (server side in handoff.server.ts).
// Desktop: a line under the stage ("Photos on your phone? Scan to upload") opens a QR code; photos from the phone fill empty slots in order, and one scan covers the session.
// After one successful phone upload the preference is remembered (localStorage) and the QR opens directly next time; "Use computer instead" switches back. Hidden on phones and tablets (coarse pointer).

const HANDOFF_KEY = 'tinydesk:handoff';
const VIA_KEY = 'tinydesk:upload-via';
const POLL_MS = 2000;

type Handoff = { token: string; expiresAt: number; consumed: number };

function readJson<T>(storage: () => Storage, key: string): T | null {
  try {
    return JSON.parse(storage().getItem(key) ?? 'null') as T | null;
  } catch {
    return null;
  }
}

function writeJson(storage: () => Storage, key: string, value: unknown) {
  try {
    if (value === null) storage().removeItem(key);
    else storage().setItem(key, JSON.stringify(value));
  } catch {}
}

const session = () => sessionStorage;
const local = () => localStorage;

/**
 * place: puts new phone photos on the stage and returns how many it placed (fewer when the stage is full; the rest wait for a free slot).
 */
export function PhoneHandoff({ place }: { place: (paths: string[]) => number }) {
  const [available, setAvailable] = useState(false);
  const [handoff, setHandoff] = useState<Handoff | null>(null);
  const [expired, setExpired] = useState(false);
  const [waiting, setWaiting] = useState(0);
  const [failed, setFailed] = useState(false);
  const placeRef = useRef(place);
  placeRef.current = place;

  function save(next: Handoff | null) {
    writeJson(session, HANDOFF_KEY, next);
    setHandoff(next);
  }

  async function open(source: 'click' | 'auto' | 'refresh') {
    track('phone_handoff_open', { source });
    setFailed(false);
    try {
      const response = await fetch('/api/handoff', { method: 'POST' });
      if (!response.ok) throw new Error(String(response.status));
      const data = (await response.json()) as { token: string; expiresAt: number };
      // Clear the expired flag only once the new code arrives: clearing first would let polling query the old code, get 404 and mark the panel expired again.
      save({ ...data, consumed: 0 });
      setExpired(false);
      setWaiting(0);
    } catch {
      setFailed(true);
    }
  }

  function close() {
    writeJson(local, VIA_KEY, 'computer');
    save(null);
    setExpired(false);
    setWaiting(0);
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: read the last pairing code and preference once on mount.
  useEffect(() => {
    if (!window.matchMedia('(pointer: fine)').matches) return;
    setAvailable(true);
    const saved = readJson<Handoff>(session, HANDOFF_KEY);
    if (saved && saved.expiresAt > Date.now()) setHandoff(saved);
    else if (readJson<string>(local, VIA_KEY) === 'phone') void open('auto');
  }, []);

  // Restart polling only when the pairing code changes; consumed advances inside the poll.
  const handoffRef = useRef(handoff);
  handoffRef.current = handoff;
  const token = handoff?.token;
  useEffect(() => {
    if (!token || expired) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function tick() {
      if (document.visibilityState === 'visible') {
        try {
          const response = await fetch(`/api/handoff/${token}`);
          if (stopped) return;
          if (response.status === 404) {
            setExpired(true);
            return;
          }
          const data = (await response.json()) as { paths: string[] };
          const current = handoffRef.current;
          if (stopped || !current || current.token !== token) return;
          const fresh = data.paths.slice(current.consumed);
          const placed = fresh.length ? placeRef.current(fresh) : 0;
          if (placed) {
            writeJson(local, VIA_KEY, 'phone');
            const next = { ...current, consumed: current.consumed + placed };
            handoffRef.current = next;
            writeJson(session, HANDOFF_KEY, next);
            setHandoff(next);
          }
          setWaiting(fresh.length - placed);
        } catch {}
      }
      if (!stopped) timer = setTimeout(tick, POLL_MS);
    }
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [token, expired]);

  if (!available) return null;

  if (!handoff) {
    return (
      <p className="handoff-entry">
        <button type="button" className="link-button" onClick={() => void open('click')}>
          {m.common_handoff_open()}
        </button>
        {failed && <span className="error"> {m.common_handoff_failed()}</span>}
      </p>
    );
  }

  const url = `${window.location.origin}/phone/${handoff.token}`;
  const qr = `data:image/svg+xml;utf8,${encodeURIComponent(
    renderSVG(url, { border: 2, whiteColor: '#efe7da', blackColor: '#0f0c0a' }),
  )}`;

  return (
    <div className="handoff">
      {expired ? (
        <div className="handoff-qr handoff-qr-expired">
          <button type="button" className="preset" onClick={() => void open('refresh')}>
            {m.common_handoff_refresh()}
          </button>
        </div>
      ) : (
        <img className="handoff-qr" src={qr} alt={m.common_handoff_qr_alt()} width={132} height={132} />
      )}
      <div className="handoff-text">
        <p className="handoff-title">{expired ? m.common_handoff_expired() : m.common_handoff_title()}</p>
        <p className="muted">{m.common_handoff_body()}</p>
        <p className="mono handoff-status">
          {waiting > 0
            ? m.common_handoff_full()
            : handoff.consumed > 0
              ? m.common_handoff_received({ count: handoff.consumed })
              : m.common_handoff_waiting()}
        </p>
        <button type="button" className="link-button" onClick={close}>
          {m.common_handoff_close()}
        </button>
      </div>
    </div>
  );
}

type Sent = { id: number; preview: string; status: 'sending' | 'sent' | 'failed' };

const MAX_SIDE = 2048;

/**
 * Phone originals often exceed the upload limit (10 MB), and Android may give HEIC: shrink to a JPEG with a 2048 long edge first; face swap needs no more.
 * Formats the browser cannot decode upload as is and the server reports the error.
 */
async function shrink(file: File): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    return blob ?? file;
  } catch {
    return file;
  }
}

/** Phone upload page (/phone/<code>): pick a few photos, upload each and register it under the pairing code. */
export function PhoneUploadPage({ token }: { token: string }) {
  const [sent, setSent] = useState<Sent[]>([]);
  const [expired, setExpired] = useState(false);
  const [tooSmall, setTooSmall] = useState(false);
  const nextId = useRef(0);

  useEffect(() => {
    fetch(`/api/handoff/${token}`)
      .then((response) => setExpired(response.status === 404))
      .catch(() => undefined);
  }, [token]);

  function update(id: number, status: Sent['status']) {
    setSent((list) => list.map((item) => (item.id === id ? { ...item, status } : item)));
  }

  async function onPick(files: FileList | null) {
    if (!files?.length) return;
    const batch = [...files].map((file) => ({ file, id: nextId.current++ }));
    setSent((list) => [
      ...list,
      ...batch.map(({ file, id }) => ({
        id,
        preview: URL.createObjectURL(file),
        status: 'sending' as const,
      })),
    ]);
    // Upload one at a time: desktop fills slots in registration order, which must match the user's selection.
    for (const { file, id } of batch) {
      try {
        const blob = await shrink(file);
        const path = await uploadReference(new File([blob], file.name, { type: blob.type || file.type }));
        const response = await fetch(`/api/handoff/${token}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path }),
        });
        if (response.status === 404) {
          // Pairing code expired: stop uploading the rest so they do not use up the day's upload quota.
          setExpired(true);
          return;
        }
        update(id, response.ok ? 'sent' : 'failed');
      } catch (e) {
        // The server stops photos whose short side is too small (no face to swap, upstream money wasted); mark it red with its own message.
        if (e instanceof ApiError && e.code === 'image_too_small') {
          setTooSmall(true);
          track('photo_too_small', { via: 'phone' });
        }
        update(id, 'failed');
      }
    }
  }

  const done = sent.filter((item) => item.status === 'sent').length;
  const sending = sent.some((item) => item.status === 'sending');

  return (
    <section className="phone-upload">
      <h1>{m.common_phone_title()}</h1>
      {expired ? (
        <p className="notice">{m.common_phone_expired()}</p>
      ) : (
        <>
          <p className="muted">{m.common_phone_body()}</p>
          <label className={`button primary phone-pick${sending ? ' phone-pick-busy' : ''}`}>
            {sending ? m.common_phone_sending() : done ? m.common_phone_more() : m.common_phone_pick()}
            <input
              type="file"
              accept="image/*"
              multiple
              className="sr-only"
              disabled={sending}
              onChange={(e) => {
                void onPick(e.target.files);
                e.target.value = '';
              }}
            />
          </label>
          {done > 0 && <p className="mono phone-done">{m.common_phone_sent({ count: done })}</p>}
          {sent.some((item) => item.status === 'failed') && (
            <p className="error">{tooSmall ? m.common_tool_photo_too_small() : m.common_phone_failed()}</p>
          )}
          {sent.length > 0 && (
            <ul className="phone-sent">
              {sent.map((item) => (
                <li key={item.id} className={`phone-thumb phone-thumb-${item.status}`}>
                  <img src={item.preview} alt="" />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
