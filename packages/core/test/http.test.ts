import { describe, expect, it } from 'vitest';
import { publicRequest } from '../src/http';

describe('publicRequest', () => {
  it("gives the site's own host APP_URL's origin, keeping method, headers, path and body", async () => {
    const proxied = new Request('http://example.com/api/jobs/?a=1', {
      method: 'POST',
      headers: { origin: 'https://example.com', 'content-type': 'application/json' },
      body: JSON.stringify({ x: 1 }),
      duplex: 'half',
    } as RequestInit);
    const seen = publicRequest(proxied, 'https://example.com');
    expect(seen.url).toBe('https://example.com/api/jobs/?a=1');
    expect(new URL(seen.url).origin).toBe(seen.headers.get('origin'));
    expect(seen.method).toBe('POST');
    expect(await seen.json()).toEqual({ x: 1 });
  });

  it('leaves other hosts, matching requests and a missing or broken APP_URL alone', () => {
    const www = new Request('http://www.example.com/x');
    expect(publicRequest(www, 'https://example.com')).toBe(www);
    const local = new Request('http://localhost:5141/x');
    expect(publicRequest(local, 'http://localhost:5141')).toBe(local);
    expect(publicRequest(local, undefined)).toBe(local);
    expect(publicRequest(local, 'not a url')).toBe(local);
    // A dev APP_URL on another port is taken as is: the host matches.
    expect(publicRequest(new Request('http://localhost:3000/x'), 'http://localhost:5141').url).toBe(
      'http://localhost:5141/x',
    );
  });
});
