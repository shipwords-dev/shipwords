import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { AwsClient } from 'aws4fetch';

// Object storage for uploads, outputs and intermediate files. Three implementations: S3 (used against Cloudflare R2, so existing
// keys, lifecycle rules and free egress stay), a local directory (development) and memory (tests). The engine only needs these
// three calls; anything provider-specific stays behind them.

export interface StoredObject {
  key: string;
  size: number;
  /** An HTTP ETag value, quotes included. */
  etag: string;
  contentType?: string;
  uploaded: Date;
}

export interface ObjectBody extends StoredObject {
  /** The bytes, or only the requested range. Read the body once: as a stream, or with arrayBuffer() or text(). */
  readonly body: ReadableStream<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

export type PutBody = ReadableStream<Uint8Array> | ArrayBuffer | ArrayBufferView | string | Blob;

export interface ByteRange {
  offset: number;
  length: number;
}

export interface ObjectStore {
  head(key: string): Promise<StoredObject | null>;
  get(key: string, options?: { range?: ByteRange }): Promise<ObjectBody | null>;
  put(key: string, body: PutBody, options?: { contentType?: string }): Promise<void>;
}

/** Whole bytes of a put body. Bodies are buffered: S3 needs the length up front, and outputs are at most tens of MB. */
export async function bytesOf(body: PutBody): Promise<Uint8Array> {
  if (typeof body === 'string') return new TextEncoder().encode(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body.slice(0));
  if (ArrayBuffer.isView(body))
    return new Uint8Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
  return new Uint8Array(await new Response(body).arrayBuffer());
}

function bodyOf(object: StoredObject, read: () => ReadableStream<Uint8Array>): ObjectBody {
  return {
    ...object,
    get body() {
      return read();
    },
    arrayBuffer: () => new Response(read()).arrayBuffer(),
    text: () => new Response(read()).text(),
  };
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new Response(bytes.slice().buffer).body!;
}

function etagOf(size: number, time: number): string {
  return `"${size.toString(16)}-${time.toString(16)}"`;
}

// ---- memory ----

/** Everything in memory; for tests. */
export function memoryStore(): ObjectStore {
  const objects = new Map<
    string,
    { bytes: Uint8Array; contentType?: string; uploaded: Date; etag: string }
  >();
  const meta = (key: string) => {
    const stored = objects.get(key);
    if (!stored) return null;
    const { bytes, contentType, uploaded, etag } = stored;
    return {
      stored,
      object: { key, size: bytes.byteLength, etag, uploaded, ...(contentType ? { contentType } : {}) },
    };
  };
  let version = 0;
  return {
    async head(key) {
      return meta(key)?.object ?? null;
    },
    async get(key, options) {
      const found = meta(key);
      if (!found) return null;
      const range = options?.range;
      const bytes = range
        ? found.stored.bytes.subarray(range.offset, range.offset + range.length)
        : found.stored.bytes;
      return bodyOf(found.object, () => streamOf(bytes));
    },
    async put(key, body, options) {
      const bytes = await bytesOf(body);
      objects.set(key, {
        bytes,
        uploaded: new Date(),
        etag: etagOf(bytes.byteLength, ++version),
        ...(options?.contentType ? { contentType: options.contentType } : {}),
      });
    },
  };
}

// ---- local directory ----

/** Files under a directory, with a small JSON sidecar for the content type; for local development. */
export function fileStore(root: string): ObjectStore {
  const base = resolve(root);
  const pathOf = (key: string) => {
    const path = resolve(base, ...key.split('/'));
    if (!path.startsWith(base + sep)) throw new Error(`key outside the store: ${key}`);
    return path;
  };
  async function meta(key: string): Promise<StoredObject | null> {
    const path = pathOf(key);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) return null;
    const sidecar = await readFile(`${path}.meta.json`, 'utf8').catch(() => null);
    const contentType = sidecar ? (JSON.parse(sidecar) as { contentType?: string }).contentType : undefined;
    return {
      key,
      size: info.size,
      etag: etagOf(info.size, Math.floor(info.mtimeMs)),
      uploaded: info.mtime,
      ...(contentType ? { contentType } : {}),
    };
  }
  return {
    head: meta,
    async get(key, options) {
      const object = await meta(key);
      if (!object) return null;
      const path = pathOf(key);
      const range = options?.range;
      return bodyOf(object, () => {
        const stream = range
          ? createReadStream(path, { start: range.offset, end: range.offset + range.length - 1 })
          : createReadStream(path);
        return Readable.toWeb(stream) as ReadableStream<Uint8Array>;
      });
    },
    async put(key, body, options) {
      const path = pathOf(key);
      await mkdir(dirname(path), { recursive: true });
      // Write then rename, so a reader never sees half a file.
      const temp = `${path}.${crypto.randomUUID()}.part`;
      await writeFile(temp, await bytesOf(body));
      await writeFile(`${path}.meta.json`, JSON.stringify({ contentType: options?.contentType }));
      await rename(temp, path);
    },
  };
}

// ---- S3 (Cloudflare R2) ----

export interface S3Config {
  /** e.g. https://<account>.r2.cloudflarestorage.com */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** R2 takes "auto". */
  region?: string;
}

/** An S3-compatible bucket, path-style URLs. */
export function s3Store(config: S3Config, fetcher: typeof fetch = fetch): ObjectStore {
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: 's3',
    region: config.region ?? 'auto',
  });
  const urlOf = (key: string) =>
    `${config.endpoint.replace(/\/$/, '')}/${encodeURIComponent(config.bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`;
  async function send(key: string, init: RequestInit): Promise<Response> {
    const signed = await client.sign(urlOf(key), init);
    return fetcher(signed);
  }
  const objectOf = (key: string, response: Response, size: number): StoredObject => {
    const contentType = response.headers.get('content-type') ?? undefined;
    const modified = response.headers.get('last-modified');
    return {
      key,
      size,
      etag: response.headers.get('etag') ?? '""',
      uploaded: modified ? new Date(modified) : new Date(0),
      ...(contentType ? { contentType } : {}),
    };
  };
  return {
    async head(key) {
      const response = await send(key, { method: 'HEAD' });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`storage head ${key} failed: ${response.status}`);
      return objectOf(key, response, Number(response.headers.get('content-length') ?? '0'));
    },
    async get(key, options) {
      const range = options?.range;
      const response = await send(key, {
        method: 'GET',
        ...(range ? { headers: { range: `bytes=${range.offset}-${range.offset + range.length - 1}` } } : {}),
      });
      if (response.status === 404) return null;
      if (!response.ok)
        throw new Error(`storage get ${key} failed: ${response.status} ${await response.text()}`);
      // The size of the whole object: Content-Range's total on a ranged read, Content-Length otherwise.
      const total = response.headers.get('content-range')?.split('/')[1];
      const size = Number(total ?? response.headers.get('content-length') ?? '0');
      // Streamed, not buffered: videos served through /files would otherwise sit in memory for every request.
      if (!response.body) throw new Error(`storage get ${key} returned no body`);
      const stream = response.body;
      return bodyOf(objectOf(key, response, size), () => stream);
    },
    async put(key, body, options) {
      const bytes = await bytesOf(body);
      const response = await send(key, {
        method: 'PUT',
        body: bytes.slice().buffer,
        headers: {
          'content-length': String(bytes.byteLength),
          ...(options?.contentType ? { 'content-type': options.contentType } : {}),
        },
      });
      if (!response.ok)
        throw new Error(`storage put ${key} failed: ${response.status} ${await response.text()}`);
    },
  };
}

export interface StoreEnv {
  S3_ENDPOINT?: string;
  S3_BUCKET?: string;
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;
  S3_REGION?: string;
  /** Local development without a bucket: files under this directory. */
  STORAGE_DIR?: string;
}

/** The store a site's environment configures: S3 when S3_* are set, else a local directory. */
export function storeFromEnv(env: StoreEnv): ObjectStore {
  const { S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY } = env;
  if (S3_ENDPOINT && S3_BUCKET && S3_ACCESS_KEY_ID && S3_SECRET_ACCESS_KEY)
    return s3Store({
      endpoint: S3_ENDPOINT,
      bucket: S3_BUCKET,
      accessKeyId: S3_ACCESS_KEY_ID,
      secretAccessKey: S3_SECRET_ACCESS_KEY,
      ...(env.S3_REGION ? { region: env.S3_REGION } : {}),
    });
  if (env.STORAGE_DIR) return fileStore(env.STORAGE_DIR);
  throw new Error(
    'no object storage configured: set S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY (or STORAGE_DIR)',
  );
}
