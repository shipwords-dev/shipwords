import type { Db } from '@shipwords/core/db/client';
import type { ObjectStore } from '@shipwords/jobs/store';
import { and, asc, count, eq, gt, lt } from 'drizzle-orm';
import { handoffItems, handoffs } from './schema';

// Relay for uploading photos from a phone by QR code: desktop opens a pairing code, the phone uploads via /api/uploads as usual and
// registers the path under the code; desktop polls and fills empty slots. Codes and registered paths live in this site's database
// (handoffs, handoff_items); the photos themselves stay under uploads/ in storage as usual.

const TTL_MS = 30 * 60 * 1000;
const CLEANUP_AFTER_MS = 24 * 60 * 60 * 1000;
const MAX_ITEMS = 20;
const TOKEN = /^[a-f0-9]{32}$/;
const UPLOAD_PATH = /^\/files\/uploads\/(up_[a-z0-9]+\.(?:png|jpg|webp))$/;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
const fail = (status: number, code: string) => json({ error: { code, message: code } }, status);

export function createHandoffApi(db: () => Db, store: () => ObjectStore, now = () => Date.now()) {
  /** Expiry time of a live pairing code; null if it expired or does not exist. */
  async function expiresAt(token: string): Promise<number | null> {
    if (!TOKEN.test(token)) return null;
    const [row] = await db()
      .select({ createdAt: handoffs.createdAt })
      .from(handoffs)
      .where(and(eq(handoffs.token, token), gt(handoffs.createdAt, now() - TTL_MS)));
    return row ? row.createdAt + TTL_MS : null;
  }

  async function items(token: string): Promise<string[]> {
    const rows = await db()
      .select({ path: handoffItems.path })
      .from(handoffItems)
      .where(eq(handoffItems.token, token))
      .orderBy(asc(handoffItems.createdAt), asc(handoffItems.path))
      .limit(MAX_ITEMS);
    return rows.map((row) => row.path);
  }

  return {
    /**
     * POST /api/handoff: desktop opens a pairing code. Also deletes codes older than a day: only long-expired ones, so a phone
     * registering into a code that just expired doesn't lose the parent row and hit a foreign-key 500.
     */
    async create(): Promise<Response> {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      const token = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
      const created = now();
      await db()
        .delete(handoffs)
        .where(lt(handoffs.createdAt, created - CLEANUP_AFTER_MS));
      await db().insert(handoffs).values({ token, createdAt: created });
      return json({ token, expiresAt: created + TTL_MS }, 201);
    },

    /** GET /api/handoff/<code>: photo paths sent from the phone, in registration order. */
    async read(token: string): Promise<Response> {
      const expires = await expiresAt(token);
      if (!expires) return fail(404, 'handoff_expired');
      return json({ paths: await items(token), expiresAt: expires });
    },

    /** POST /api/handoff/<code> {path}: phone registers a photo it just uploaded; registering the same one twice counts once. */
    async add(request: Request, token: string): Promise<Response> {
      if (!(await expiresAt(token))) return fail(404, 'handoff_expired');
      const body = (await request.json().catch(() => null)) as { path?: unknown } | null;
      const name = typeof body?.path === 'string' ? UPLOAD_PATH.exec(body.path)?.[1] : undefined;
      if (!name || !(await store().head(`uploads/${name}`))) return fail(400, 'invalid_path');
      const [row] = await db().select({ n: count() }).from(handoffItems).where(eq(handoffItems.token, token));
      if ((row?.n ?? 0) >= MAX_ITEMS) return fail(429, 'handoff_full');
      await db()
        .insert(handoffItems)
        .values({ token, path: `/files/uploads/${name}`, createdAt: now() })
        .onConflictDoNothing();
      return json({ ok: true }, 201);
    },
  };
}
