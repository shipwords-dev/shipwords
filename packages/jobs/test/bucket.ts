// In-memory stand-in for the R2 bucket binding: the subset the engine uses (get with ranges, head, put), so tests run in Node.

interface StoredValue {
  bytes: Uint8Array;
  contentType?: string;
  uploaded: Date;
}

type PutValue = ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob | null;
type Range = { offset?: number; length?: number } | { suffix: number };

async function toBytes(value: PutValue): Promise<Uint8Array> {
  if (value === null) return new Uint8Array();
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  return new Uint8Array(await new Response(value).arrayBuffer());
}

function objectOf(key: string, stored: StoredValue, bytes = stored.bytes) {
  const httpMetadata = stored.contentType ? { contentType: stored.contentType } : {};
  return {
    key,
    size: stored.bytes.byteLength,
    httpEtag: `"${key.length}-${stored.bytes.byteLength}-${stored.uploaded.getTime()}"`,
    etag: `${key.length}-${stored.bytes.byteLength}`,
    uploaded: stored.uploaded,
    httpMetadata,
    writeHttpMetadata(headers: Headers) {
      if (stored.contentType) headers.set('content-type', stored.contentType);
    },
    get body() {
      return new Response(bytes.slice().buffer).body!;
    },
    arrayBuffer: async () => bytes.slice().buffer,
    bytes: async () => bytes.slice(),
    text: async () => new TextDecoder().decode(bytes),
    json: async () => JSON.parse(new TextDecoder().decode(bytes)),
  };
}

export function memoryBucket(): R2Bucket {
  const objects = new Map<string, StoredValue>();
  const bucket = {
    async head(key: string) {
      const stored = objects.get(key);
      return stored ? objectOf(key, stored) : null;
    },
    async get(key: string, options?: { range?: Range }) {
      const stored = objects.get(key);
      if (!stored) return null;
      const range = options?.range;
      if (!range) return objectOf(key, stored);
      const size = stored.bytes.byteLength;
      const start = 'suffix' in range ? Math.max(0, size - range.suffix) : (range.offset ?? 0);
      const end = 'suffix' in range ? size : range.length === undefined ? size : start + range.length;
      return objectOf(key, stored, stored.bytes.slice(start, end));
    },
    async put(key: string, value: PutValue, options?: { httpMetadata?: { contentType?: string } }) {
      const bytes = await toBytes(value);
      const stored = { bytes, contentType: options?.httpMetadata?.contentType, uploaded: new Date() };
      objects.set(key, stored);
      return objectOf(key, stored);
    },
    async delete(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
  };
  return bucket as unknown as R2Bucket;
}

/** Shared by everything in one test file, like the R2 binding was. */
export const bucket = memoryBucket();
