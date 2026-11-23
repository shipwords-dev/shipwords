import { memoryStore } from '@shipwords/jobs/store';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createHandoffApi } from '../src/site/handoff.server';
import { handoffs } from '../src/site/schema';
import { db } from './db';

const store = memoryStore();
let clock = 1_800_000_000_000;
const api = createHandoffApi(
  () => db,
  () => store,
  () => clock,
);

const add = (token: string, path: unknown) =>
  api.add(
    new Request('http://localhost/api/handoff/x', { method: 'POST', body: JSON.stringify({ path }) }),
    token,
  );
const paths = async (token: string) => {
  const response = await api.read(token);
  return response.ok ? ((await response.json()) as { paths: string[] }).paths : response.status;
};

async function open() {
  const response = await api.create();
  expect(response.status).toBe(201);
  return ((await response.json()) as { token: string; expiresAt: number }).token;
}

describe('phone handoff', () => {
  it('lists uploads in the order the phone sent them, once each', async () => {
    const token = await open();
    expect(await paths(token)).toEqual([]);
    for (const name of ['up_b1.jpg', 'up_a1.png']) await store.put(`uploads/${name}`, 'x');
    expect((await add(token, '/files/uploads/up_b1.jpg')).status).toBe(201);
    clock += 1;
    expect((await add(token, '/files/uploads/up_a1.png')).status).toBe(201);
    expect((await add(token, '/files/uploads/up_b1.jpg')).status).toBe(201);
    expect(await paths(token)).toEqual(['/files/uploads/up_b1.jpg', '/files/uploads/up_a1.png']);
  });

  it('refuses paths that are not uploads of this site, and unknown or malformed tokens', async () => {
    const token = await open();
    expect((await add(token, '/files/uploads/up_missing.jpg')).status).toBe(400);
    expect((await add(token, 'https://evil.example/up_x.jpg')).status).toBe(400);
    expect((await add(token, '/files/jobs/job_x/0.mp4')).status).toBe(400);
    expect((await add(token, 42)).status).toBe(400);
    expect(await paths('0'.repeat(32))).toBe(404);
    expect(await paths("x' or 1=1")).toBe(404);
  });

  it('expires after 30 minutes, and an expired code takes no more photos', async () => {
    const token = await open();
    await store.put('uploads/up_late.jpg', 'x');
    clock += 30 * 60 * 1000;
    expect(await paths(token)).toBe(404);
    expect((await add(token, '/files/uploads/up_late.jpg')).status).toBe(404);
    // A code just past its time stays in the table (a phone may be adding to it right now); a day later, opening a new code deletes it.
    await open();
    const rows = async () => (await db.select().from(handoffs).where(eq(handoffs.token, token))).length;
    expect(await rows()).toBe(1);
    clock += 24 * 60 * 60 * 1000;
    await open();
    expect(await rows()).toBe(0);
  });

  it('holds at most 20 photos', async () => {
    const token = await open();
    for (let i = 0; i < 21; i++) await store.put(`uploads/up_n${i}.jpg`, 'x');
    for (let i = 0; i < 20; i++) expect((await add(token, `/files/uploads/up_n${i}.jpg`)).status).toBe(201);
    expect((await add(token, '/files/uploads/up_n20.jpg')).status).toBe(429);
    expect(await paths(token)).toHaveLength(20);
  });
});
