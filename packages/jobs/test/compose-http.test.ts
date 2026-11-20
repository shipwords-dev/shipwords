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

  it('marks every call of a request-path composer as interactive, and leaves job steps in the background lane', async () => {
    const store = memoryStore();
    for (const key of [
      'jobs/j2/0.mp4',
      'jobs/j2/out.mp4',
      'jobs/j2/patch.mp4',
      'assets/orig.mp4',
      'assets/track.mp3',
    ])
      await store.put(key, key);
    await store.put('jobs/j2/photo.png', 'photo');
    const calls: { path: string; lane: string | null; type: string | null }[] = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      // Build the request the way fetch would: a multipart body must keep its own boundary next to the lane header.
      const request = new Request(url, init);
      calls.push({
        path: url.pathname,
        lane: request.headers.get('x-compose-lane'),
        type: request.headers.get('content-type'),
      });
      const json = (body: unknown) => Response.json(body);
      if (url.pathname === '/split-sheet') return json({ images: ['YQ==', 'Yg==', 'Yw==', 'ZA=='] });
      if (url.pathname === '/faces') return json({ similarity: [0.1] });
      if (url.pathname === '/likeness') return json({ similarity: [0.5] });
      return new Response(url.pathname.endsWith('/silent.mp4') ? 'silent' : 'video');
    }) as typeof fetch;
    const cut = {
      jobId: 'j2',
      key: 'jobs/j2/out.mp4',
      ranges: [[0, 24]] as [number, number][],
      width: 720,
      height: 1280,
      fps: 24,
    };
    async function everyCall(composer: ReturnType<typeof httpComposer>) {
      await composer.splitSheet!({ jobId: 'j2', image: new Uint8Array([1]).buffer });
      await composer.compose({
        jobId: 'j2',
        segments: [{ key: 'jobs/j2/0.mp4', target: 6, fit: 'trim' }],
        audio: { key: 'assets/track.mp3', start: 0, duration: 6 },
        width: 720,
        height: 1280,
        fps: 24,
      });
      await composer.faces({
        jobId: 'j2',
        key: 'jobs/j2/out.mp4',
        originalKey: 'assets/orig.mp4',
        seconds: 6,
        points: [[0.5, 0.5]],
      });
      await composer.likeness({
        jobId: 'j2',
        key: 'jobs/j2/out.mp4',
        people: [{ photo: { key: 'jobs/j2/photo.png' }, ranges: [[0, 1]] }],
      });
      await composer.extract(cut);
      await composer.patch({ ...cut, name: 'j2_p0', patchKey: 'jobs/j2/patch.mp4' });
    }
    const paths = [
      '/split-sheet',
      '/compose',
      '/files/j2/silent.mp4',
      '/faces',
      '/likeness',
      '/extract',
      '/patch',
      '/files/j2_p0/silent.mp4',
    ];
    await everyCall(httpComposer('http://c', store, fetcher, { lane: 'interactive' }));
    expect(calls.map((c) => c.path)).toEqual(paths);
    expect(calls.every((c) => c.lane === 'interactive')).toBe(true);
    for (const call of calls.filter((c) => c.path.startsWith('/files/') === false))
      expect(call.type, call.path).toMatch(/^multipart\/form-data; boundary=/);
    calls.length = 0;
    await everyCall(httpComposer('http://c', store, fetcher));
    expect(calls.map((c) => c.path)).toEqual(paths);
    expect(calls.every((c) => c.lane === null)).toBe(true);
  });
});
