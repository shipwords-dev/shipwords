import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseRange, r2Response } from '../src/r2-range';

describe('parseRange', () => {
  it('serves the whole object without a usable range', () => {
    expect(parseRange(null, 100)).toBeNull();
    expect(parseRange('bytes=-', 100)).toBeNull();
    expect(parseRange('items=0-1', 100)).toBeNull();
  });
  it('handles open, closed and suffix ranges', () => {
    expect(parseRange('bytes=0-1', 100)).toEqual({ offset: 0, length: 2 });
    expect(parseRange('bytes=90-', 100)).toEqual({ offset: 90, length: 10 });
    expect(parseRange('bytes=-10', 100)).toEqual({ offset: 90, length: 10 });
    expect(parseRange('bytes=0-500', 100)).toEqual({ offset: 0, length: 100 });
  });
  it('rejects ranges past the end', () => {
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=5-2', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=0-1', 0)).toBe('unsatisfiable');
  });
});

describe('r2Response', () => {
  const key = 'test/range.bin';
  const body = new Uint8Array(Array.from({ length: 50 }, (_, i) => i));
  beforeAll(async () => {
    await env.OUTPUTS.put(key, body, { httpMetadata: { contentType: 'video/mp4' } });
  });

  it('returns 206 with the requested slice', async () => {
    const response = await r2Response(
      env.OUTPUTS,
      key,
      new Request('https://x/', { headers: { Range: 'bytes=10-19' } }),
    );
    expect(response?.status).toBe(206);
    expect(response?.headers.get('Content-Range')).toBe('bytes 10-19/50');
    expect(response?.headers.get('Content-Length')).toBe('10');
    expect(response?.headers.get('Accept-Ranges')).toBe('bytes');
    expect([...new Uint8Array(await response!.arrayBuffer())]).toEqual([
      10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
    ]);
  });
  it('returns the whole object and extra headers without a range', async () => {
    const response = await r2Response(env.OUTPUTS, key, new Request('https://x/'), {
      'Content-Type': 'video/mp4',
    });
    expect(response?.status).toBe(200);
    expect(response?.headers.get('Content-Length')).toBe('50');
    expect(response?.headers.get('Content-Type')).toBe('video/mp4');
    expect((await response!.arrayBuffer()).byteLength).toBe(50);
  });
  it('answers HEAD without a body and 416 past the end', async () => {
    const head = await r2Response(env.OUTPUTS, key, new Request('https://x/', { method: 'HEAD' }));
    expect(head?.status).toBe(200);
    expect(head?.body).toBeNull();
    const bad = await r2Response(
      env.OUTPUTS,
      key,
      new Request('https://x/', { headers: { Range: 'bytes=50-' } }),
    );
    expect(bad?.status).toBe(416);
    expect(bad?.headers.get('Content-Range')).toBe('bytes */50');
    expect(await r2Response(env.OUTPUTS, 'test/missing', new Request('https://x/'))).toBeNull();
  });
});
