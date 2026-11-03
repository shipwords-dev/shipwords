// Serve an R2 object with HTTP byte ranges. iPhone Safari refuses to play <video> from a server that
// answers a Range request with 200 + whole file, so every endpoint that streams a stored video must go
// through here. R2 reads only the requested slice; nothing is buffered in the Worker.

export type ByteRange = { offset: number; length: number };

/** Parse a single-range `Range` header against a known size. null: no usable range (serve the whole object). */
export function parseRange(header: string | null, size: number): ByteRange | 'unsatisfiable' | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header ?? '');
  if (!match || (!match[1] && !match[2])) return null;
  // bytes=-N is the last N bytes; bytes=N- runs to the end.
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (size === 0 || start >= size || start > end) return 'unsatisfiable';
  return { offset: start, length: end - start + 1 };
}

/**
 * Respond with the object at `key`, honoring HEAD and `Range`. `headers` are added to every response
 * (content type, cache control, disposition); Accept-Ranges, Content-Length and Content-Range are set here.
 * Returns null when the object does not exist.
 */
export async function r2Response(
  bucket: R2Bucket,
  key: string,
  request: Request,
  headers: HeadersInit = {},
): Promise<Response | null> {
  const head = await bucket.head(key);
  if (!head) return null;
  const out = new Headers(headers);
  out.set('Accept-Ranges', 'bytes');
  out.set('ETag', head.httpEtag);
  const range = parseRange(request.headers.get('Range'), head.size);
  if (range === 'unsatisfiable') {
    out.set('Content-Range', `bytes */${head.size}`);
    return new Response(null, { status: 416, headers: out });
  }
  const wantBody = request.method !== 'HEAD';
  if (!range) {
    out.set('Content-Length', String(head.size));
    if (!wantBody) return new Response(null, { status: 200, headers: out });
    const object = await bucket.get(key);
    return object ? new Response(object.body, { status: 200, headers: out }) : null;
  }
  out.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`);
  out.set('Content-Length', String(range.length));
  if (!wantBody) return new Response(null, { status: 206, headers: out });
  const object = await bucket.get(key, { range });
  return object ? new Response(object.body, { status: 206, headers: out }) : null;
}
