// Static assets ignore Range (always 200 with the whole file), but iPhone Safari needs byte ranges (206) to play <video>.
// Video paths go to the Worker (assets.run_worker_first in wrangler.jsonc), which fetches the whole file from static assets and slices it by Range.
// Sample videos are all under 2 MB, so reading the whole file into memory to slice is fine.

export const VIDEO_PATH = /^\/media\/[^/]+\.mp4$/;

export async function serveVideo(request: Request, assets: Fetcher): Promise<Response> {
  const file = await assets.fetch(new Request(request.url, { method: 'GET' }));
  if (!file.ok) return file;
  const headers = new Headers(file.headers);
  headers.set('Accept-Ranges', 'bytes');
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('Range') ?? '');
  if (!range || (!range[1] && !range[2])) {
    return new Response(request.method === 'HEAD' ? null : file.body, { status: 200, headers });
  }
  const body = await file.arrayBuffer();
  const size = body.byteLength;
  // bytes=-N is the last N bytes; bytes=N- runs to the end of the file.
  const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
  const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
  if (start >= size || start > end) {
    headers.set('Content-Range', `bytes */${size}`);
    headers.delete('Content-Length');
    return new Response(null, { status: 416, headers });
  }
  headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  headers.set('Content-Length', String(end - start + 1));
  return new Response(request.method === 'HEAD' ? null : body.slice(start, end + 1), {
    status: 206,
    headers,
  });
}
