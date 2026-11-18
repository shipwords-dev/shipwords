import { describe, expect, it } from 'vitest';
import { httpComposer } from '../src/compose';
import { memoryStore } from '../src/store';

// The compose client talks plain HTTP to the compose service and reads its inputs from the object store.

describe('compose over HTTP', () => {
  it('posts the segments and track from the store, then fetches the silent copy by job ID', async () => {
    const store = memoryStore();
    await store.put('jobs/j1/0.mp4', 'seg0');
    await store.put('assets/track.mp3', 'track');
    const calls: { url: string; fields: Record<string, string> }[] = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const fields: Record<string, string> = {};
      if (init?.body instanceof FormData)
        for (const [name, value] of init.body.entries())
          fields[name] = typeof value === 'string' ? value : await value.text();
      calls.push({ url, fields });
      return new Response(url.endsWith('/silent.mp4') ? 'silent' : 'song');
    }) as typeof fetch;
    const composer = httpComposer('http://compose:8080/', store, fetcher);
    const result = await composer.compose({
      jobId: 'j1',
      segments: [{ key: 'jobs/j1/0.mp4', target: 6, fit: 'trim' }],
      audio: { key: 'assets/track.mp3', start: 0, duration: 6 },
      width: 1280,
      height: 720,
      fps: 24,
    });
    expect(new TextDecoder().decode(result.song)).toBe('song');
    expect(new TextDecoder().decode(result.silent)).toBe('silent');
    expect(calls.map((call) => call.url)).toEqual([
      'http://compose:8080/compose',
      'http://compose:8080/files/j1/silent.mp4',
    ]);
    expect(calls[0]!.fields).toMatchObject({ 'segment-0': 'seg0', audio: 'track' });
    expect(JSON.parse(calls[0]!.fields.manifest!)).toMatchObject({
      id: 'j1',
      segments: [{ target: 6, fit: 'trim' }],
    });
  });

  it('fails on a missing input or an error from the service', async () => {
    const store = memoryStore();
    const ok = (async () => new Response('x')) as unknown as typeof fetch;
    await expect(
      httpComposer('http://c', store, ok).extract({
        jobId: 'j',
        key: 'nope',
        ranges: [[0, 1]],
        width: 1,
        height: 1,
        fps: 1,
      }),
    ).rejects.toThrow(/missing: nope/);
    await store.put('v.mp4', 'v');
    const broken = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
    await expect(
      httpComposer('http://c', store, broken).extract({
        jobId: 'j',
        key: 'v.mp4',
        ranges: [[0, 1]],
        width: 1,
        height: 1,
        fps: 1,
      }),
    ).rejects.toThrow(/extract failed: 500 boom/);
  });
});
