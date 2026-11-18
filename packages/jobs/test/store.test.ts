import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fileStore, memoryStore, type ObjectStore, s3Store, storeFromEnv } from '../src/store';

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});
async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'shipwords-store-'));
  dirs.push(dir);
  return dir;
}

async function roundTrip(store: ObjectStore) {
  expect(await store.head('jobs/a/0.png')).toBeNull();
  expect(await store.get('jobs/a/0.png')).toBeNull();
  await store.put('jobs/a/0.png', new Uint8Array([1, 2, 3, 4, 5]), { contentType: 'image/png' });
  const head = await store.head('jobs/a/0.png');
  expect(head).toMatchObject({ key: 'jobs/a/0.png', size: 5, contentType: 'image/png' });
  expect(head!.etag).toMatch(/^".+"$/);
  const whole = await store.get('jobs/a/0.png');
  expect([...new Uint8Array(await whole!.arrayBuffer())]).toEqual([1, 2, 3, 4, 5]);
  const part = await store.get('jobs/a/0.png', { range: { offset: 1, length: 3 } });
  expect(part!.size).toBe(5);
  expect([...new Uint8Array(await new Response(part!.body).arrayBuffer())]).toEqual([2, 3, 4]);
  // Streams and text bodies are stored too, and a put replaces the object.
  await store.put('jobs/a/0.png', new Response('hello').body!, { contentType: 'text/plain' });
  expect(await (await store.get('jobs/a/0.png'))!.text()).toBe('hello');
  expect((await store.head('jobs/a/0.png'))!.contentType).toBe('text/plain');
}

describe('object stores', () => {
  it('memory: put, head, get, ranges, replace', async () => {
    await roundTrip(memoryStore());
  });

  it('local directory: the same, without leftover temp files, and no keys outside the root', async () => {
    const dir = await tempDir();
    const store = fileStore(dir);
    await roundTrip(store);
    const files = await readdir(join(dir, 'jobs', 'a'));
    expect(files.some((name) => name.endsWith('.part'))).toBe(false);
    await expect(store.put('../escape.txt', 'x')).rejects.toThrow(/outside the store/);
  });

  it('S3: signed path-style requests, sizes from headers, 404 as missing', async () => {
    const requests: { method: string; url: string; headers: Headers }[] = [];
    const objects = new Map<string, { bytes: Uint8Array; type: string }>();
    const fetcher = (async (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(input);
      requests.push({ method: request.method, url: request.url, headers: new Headers(request.headers) });
      const key = decodeURIComponent(new URL(request.url).pathname.replace(/^\/bucket\//, ''));
      if (request.method === 'PUT') {
        objects.set(key, {
          bytes: new Uint8Array(await request.arrayBuffer()),
          type: request.headers.get('content-type') ?? '',
        });
        return new Response(null, { status: 200 });
      }
      const stored = objects.get(key);
      if (!stored) return new Response('NoSuchKey', { status: 404 });
      const headers = {
        etag: '"abc"',
        'content-type': stored.type,
        'last-modified': new Date(0).toUTCString(),
      };
      if (request.method === 'HEAD')
        return new Response(null, {
          headers: { ...headers, 'content-length': String(stored.bytes.byteLength) },
        });
      const range = request.headers.get('range')?.match(/bytes=(\d+)-(\d+)/);
      if (range) {
        const [start, end] = [Number(range[1]), Number(range[2])];
        return new Response(stored.bytes.slice(start, end + 1).buffer, {
          status: 206,
          headers: { ...headers, 'content-range': `bytes ${start}-${end}/${stored.bytes.byteLength}` },
        });
      }
      return new Response(stored.bytes.slice().buffer, { headers });
    }) as typeof fetch;
    const store = s3Store(
      {
        endpoint: 'https://acc.r2.example/',
        bucket: 'bucket',
        accessKeyId: 'AKID',
        secretAccessKey: 'secret',
      },
      fetcher,
    );
    expect(await store.head('jobs/x/0.mp4')).toBeNull();
    await store.put('jobs/x/0.mp4', new Uint8Array([9, 8, 7, 6]), { contentType: 'video/mp4' });
    const put = requests.find((request) => request.method === 'PUT')!;
    expect(put.url).toBe('https://acc.r2.example/bucket/jobs/x/0.mp4');
    expect(put.headers.get('authorization')).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/auto\/s3\/aws4_request/,
    );
    expect(put.headers.get('x-amz-date')).toMatch(/^\d{8}T\d{6}Z$/);
    expect(put.headers.get('content-type')).toBe('video/mp4');
    expect(await store.head('jobs/x/0.mp4')).toMatchObject({
      size: 4,
      etag: '"abc"',
      contentType: 'video/mp4',
    });
    const part = await store.get('jobs/x/0.mp4', { range: { offset: 1, length: 2 } });
    expect(part!.size).toBe(4);
    expect([...new Uint8Array(await part!.arrayBuffer())]).toEqual([8, 7]);
    expect(requests.at(-1)!.headers.get('range')).toBe('bytes=1-2');
  });

  it('S3: a failed request throws instead of looking like a missing object', async () => {
    const store = s3Store(
      { endpoint: 'https://acc.r2.example', bucket: 'b', accessKeyId: 'a', secretAccessKey: 's' },
      (async () => new Response('denied', { status: 403 })) as unknown as typeof fetch,
    );
    await expect(store.head('k')).rejects.toThrow(/403/);
    await expect(store.get('k')).rejects.toThrow(/403/);
    await expect(store.put('k', 'x')).rejects.toThrow(/403/);
  });

  it('picks S3 when configured, else a local directory, else refuses', async () => {
    expect(() => storeFromEnv({})).toThrow(/no object storage/);
    const dir = await tempDir();
    await storeFromEnv({ STORAGE_DIR: dir }).put('a.txt', 'x');
    expect(await readdir(dir)).toContain('a.txt');
    const s3 = storeFromEnv({
      S3_ENDPOINT: 'https://acc.r2.example',
      S3_BUCKET: 'b',
      S3_ACCESS_KEY_ID: 'a',
      S3_SECRET_ACCESS_KEY: 's',
      STORAGE_DIR: dir,
    });
    expect(s3).not.toBeNull();
  });
});
