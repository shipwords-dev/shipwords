export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  if (!headers.has('cache-control')) headers.set('cache-control', 'no-store');
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function errorResponse(
  status: number,
  code: string,
  message?: string,
  extra?: Record<string, unknown>,
) {
  return json({ error: { code, message: message ?? code, ...extra } }, { status });
}

export function clientIp(headers: Headers): string | null {
  return headers.get('cf-connecting-ip') ?? headers.get('x-real-ip') ?? null;
}

/** Groups IPv6 by /64 (a household or cloud VM usually gets a whole block); IPv4 is returned as-is. */
export function ipBucket(ip: string): string {
  if (!ip.includes(':')) return ip;
  const lower = ip.toLowerCase().split('%')[0] ?? '';
  // IPv4-mapped addresses (::ffff:1.2.3.4) are treated as IPv4.
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) return mapped[1];
  const [head = '', tail] = lower.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups =
    tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  const prefix = groups.slice(0, 4).map((group) => (Number.parseInt(group || '0', 16) || 0).toString(16));
  return `${prefix.join(':')}::/64`;
}

/**
 * Only accepts site-relative paths, so sign-in and checkout redirects can't be abused as open redirects.
 * Rejects //host, backslashes (browsers treat them as slashes) and control characters.
 */
export function safeRelativePath(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return fallback;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: blocking control characters is the point.
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return fallback;
  return value;
}

export function readCookie(headers: Headers, name: string): string | null {
  for (const part of (headers.get('cookie') ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

/**
 * The request as the visitor sent it. Behind the reverse proxy the server sees http://<host> even though the visitor used https (the
 * proxy and Cloudflare terminate TLS), so anything built from request.url (an Origin check, a redirect, an absolute link) would use the
 * wrong scheme. Requests for the site's own host get APP_URL's origin; other hosts (a www alias, localhost in dev) pass through.
 */
export function publicRequest(request: Request, appUrl: string | undefined): Request {
  if (!appUrl) return request;
  let site: URL;
  try {
    site = new URL(appUrl);
  } catch {
    return request;
  }
  const url = new URL(request.url);
  if (url.hostname !== site.hostname || (url.protocol === site.protocol && url.port === site.port))
    return request;
  url.protocol = site.protocol;
  url.port = site.port;
  const hasBody = request.body !== null && request.method !== 'GET' && request.method !== 'HEAD';
  return new Request(url, {
    method: request.method,
    headers: request.headers,
    signal: request.signal,
    redirect: request.redirect,
    ...(hasBody ? { body: request.body, duplex: 'half' } : {}),
  } as RequestInit);
}
