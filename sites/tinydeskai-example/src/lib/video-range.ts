// 静态资源层不处理 Range（总是 200 整个文件），iPhone Safari 播放 <video> 要求服务器支持字节范围（206）。
// 视频路径交给 Worker（wrangler.jsonc 的 assets.run_worker_first），从静态资源取出整个文件后按 Range 切片。
// 样片都在 2 MB 以内，整块读进内存切片足够。

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
  // bytes=-N 是最后 N 个字节；bytes=N- 到文件末尾。
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
