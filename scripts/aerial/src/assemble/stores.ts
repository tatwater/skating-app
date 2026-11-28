/**
 * **Where the assembler and verify read objects from, and where the archive is written to.**
 *
 * Reads go through one small interface, `ObjectStore`, with two implementations:
 *
 * - `httpStore(base)` — HTTP `GET`/`HEAD` with `Range`. On a Machine the base is `rclone serve http`
 *   over the private bucket on localhost (one process, any number of range reads, no SDK and no
 *   per-read spawn); on the laptop, verify uses it over the bucket's **public** URL, the way the web
 *   reads the archive.
 * - `fileStore(root)` — a directory, for the tests and the local proofs.
 *
 * Writes go to a `ByteSink`: a file here, `rclone rcat` on a Machine (`upload.ts`, the excluded
 * process boundary). `hashingSink` wraps either and takes the SHA-256 and the length as the bytes
 * pass (§2.4 step 4: a multipart ETag is not a checksum).
 */

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

export interface ObjectStore {
  /** A short name for messages. */
  readonly name: string;
  /** The whole object, or `null` when there is none. */
  get(key: string): Promise<Uint8Array | null>;
  /** Exactly `length` bytes from `offset`; throws when the object is shorter. */
  range(key: string, offset: number, length: number): Promise<Uint8Array>;
  /** The same bytes as `range`, as they arrive. */
  rangeStream(key: string, offset: number, length: number): AsyncIterable<Uint8Array>;
  /** Up to `length` bytes from `offset`: fewer at the end of the object (the PMTiles first read). */
  rangeUpTo(key: string, offset: number, length: number): Promise<Uint8Array>;
  exists(key: string): Promise<boolean>;
  /** The object's length, or `null` when there is none. */
  size(key: string): Promise<number | null>;
}

// ── A directory ────────────────────────────────────────────────────────────────────────────────

export function fileStore(root: string): ObjectStore {
  const base = resolve(root);
  const path = (key: string): string => {
    const p = resolve(base, key);
    if (p !== base && !p.startsWith(base + sep)) throw new Error(`key ${key} escapes the store`);
    return p;
  };
  const readAt = async (key: string, offset: number, length: number): Promise<Uint8Array> => {
    const handle = await open(path(key), 'r');
    try {
      const buf = new Uint8Array(length);
      let got = 0;
      while (got < length) {
        const { bytesRead } = await handle.read(buf, got, length - got, offset + got);
        if (bytesRead === 0) break;
        got += bytesRead;
      }
      return got === length ? buf : buf.subarray(0, got);
    } finally {
      await handle.close();
    }
  };
  return {
    name: `file:${base}`,
    async get(key) {
      try {
        const size = (await stat(path(key))).size;
        return await readAt(key, 0, size);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw e;
      }
    },
    async range(key, offset, length) {
      const bytes = await readAt(key, offset, length);
      if (bytes.length !== length) {
        throw new Error(`${key}: ${length} bytes at ${offset}, the object ends ${bytes.length} in`);
      }
      return bytes;
    },
    async *rangeStream(key, offset, length) {
      if (length === 0) return;
      let got = 0;
      for await (const chunk of createReadStream(path(key), {
        start: offset,
        end: offset + length - 1,
        highWaterMark: 1 << 20,
      })) {
        got += (chunk as Buffer).length;
        yield new Uint8Array(chunk as Buffer);
      }
      if (got !== length) throw new Error(`${key}: ${length} bytes at ${offset}, got ${got}`);
    },
    rangeUpTo: readAt,
    async exists(key) {
      return (await this.size(key)) !== null;
    },
    async size(key) {
      try {
        return (await stat(path(key))).size;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw e;
      }
    },
  };
}

// ── HTTP ─────────────────────────────────────────────────────────────────────────────────────────

/** `fetch`, injectable. */
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** A failed request worth repeating: a 5xx or a 429 (a network error is fetch's `TypeError`). */
class TransientHttpError extends Error {
  override name = 'TransientHttpError';
}

/** Attempts per request, a transient failure apart: waits of 1, 4 and 16 s. */
export const HTTP_ATTEMPTS = 4;

export interface HttpStoreOptions {
  attempts?: number;
  /** Injectable, so the tests never wait. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Objects under `base` over HTTP. Keys are appended to the base path-escaped per segment, so a key
 * never becomes a query or another host. Range reads insist on `206` (a `200` would be the whole
 * object: a server that ignores `Range` is refused, not downloaded).
 *
 * **A transient failure is retried** (a network error, a 5xx, a 429: {@link HTTP_ATTEMPTS} tries),
 * never a 404, another 4xx or a short read. The pilot's assembly made ~270 requests; the region's
 * makes ~17,600 (1,764 work tiles' done records and indexes, their top tiles, ~12,300 runs), and
 * verify thousands more, so one blip that would have failed a 1.5-hour assembly is now waited out. A
 * stream that fails after its first bytes still fails (its bytes are already written).
 */
export function httpStore(
  base: string,
  fetchImpl: Fetch = fetch,
  options: HttpStoreOptions = {},
): ObjectStore {
  const root = base.endsWith('/') ? base : `${base}/`;
  const attempts = options.attempts ?? HTTP_ATTEMPTS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const url = (key: string): string => root + key.split('/').map(encodeURIComponent).join('/');
  const retrying = async <T>(op: () => Promise<T>): Promise<T> => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await op();
      } catch (e) {
        const transient = e instanceof TransientHttpError || e instanceof TypeError;
        if (!transient || attempt >= attempts) throw e;
        await sleep(1000 * 4 ** (attempt - 1));
      }
    }
  };
  const failed = async (res: Response, what: string): Promise<never> => {
    await res.body?.cancel();
    const message = `${what} answered ${res.status}`;
    throw res.status >= 500 || res.status === 429
      ? new TransientHttpError(message)
      : new Error(message);
  };
  const ranged = async (key: string, offset: number, length: number): Promise<Response> => {
    const res = await fetchImpl(url(key), {
      headers: { range: `bytes=${offset}-${offset + length - 1}` },
    });
    if (res.status !== 206) {
      if (res.status >= 500 || res.status === 429) await failed(res, `${key}: range`);
      await res.body?.cancel();
      throw new Error(`${key}: range ${offset}+${length} answered ${res.status}, not 206`);
    }
    return res;
  };
  return {
    name: root,
    get: (key) =>
      retrying(async () => {
        const res = await fetchImpl(url(key));
        if (res.status === 404) {
          await res.body?.cancel();
          return null;
        }
        if (!res.ok) await failed(res, `${key}: GET`);
        return new Uint8Array(await res.arrayBuffer());
      }),
    range: (key, offset, length) =>
      retrying(async () => {
        const bytes = new Uint8Array(await (await ranged(key, offset, length)).arrayBuffer());
        if (bytes.length !== length) {
          throw new Error(`${key}: ${length} bytes at ${offset}, got ${bytes.length}`);
        }
        return bytes;
      }),
    async *rangeStream(key, offset, length) {
      if (length === 0) return;
      const res = await retrying(() => ranged(key, offset, length));
      if (res.body === null) throw new Error(`${key}: range answered with no body`);
      let got = 0;
      for await (const chunk of res.body) {
        got += chunk.length;
        yield chunk;
      }
      if (got !== length) throw new Error(`${key}: ${length} bytes at ${offset}, got ${got}`);
    },
    rangeUpTo: (key, offset, length) =>
      retrying(async () => new Uint8Array(await (await ranged(key, offset, length)).arrayBuffer())),
    async exists(key) {
      return (await this.size(key)) !== null;
    },
    size: (key) =>
      retrying(async () => {
        const res = await fetchImpl(url(key), { method: 'HEAD' });
        await res.body?.cancel();
        if (res.status === 404) return null;
        if (!res.ok) await failed(res, `${key}: HEAD`);
        const header = res.headers.get('content-length');
        const length = header === null ? Number.NaN : Number(header);
        if (!Number.isSafeInteger(length)) throw new Error(`${key}: HEAD gave no content-length`);
        return length;
      }),
  };
}

// ── Sinks ────────────────────────────────────────────────────────────────────────────────────────

/** Where bytes are written, in order, with backpressure. */
export interface ByteSink {
  write(chunk: Uint8Array): Promise<void>;
  /** Flush and close; resolves once the bytes are durably wherever the sink puts them. */
  end(): Promise<void>;
}

/** A local file, created with its directory. */
export async function fileSink(path: string): Promise<ByteSink> {
  await mkdir(dirname(path), { recursive: true });
  const stream = createWriteStream(path);
  let failed: Error | null = null;
  stream.on('error', (e) => {
    failed = e;
  });
  return {
    write(chunk) {
      if (failed) return Promise.reject(failed);
      return new Promise((done, fail) => {
        stream.write(chunk, (e) => (e ? fail(e) : done()));
      });
    },
    end() {
      if (failed) return Promise.reject(failed);
      return new Promise((done, fail) => {
        stream.once('error', fail);
        stream.end(() => done());
      });
    },
  };
}

/** Uploads as files under `root`, keyed like the bucket (the tests' and the local proofs' `upload`). */
export function fileUploads(root: string): (key: string) => ByteSink {
  return (key) => {
    const opened = fileSink(join(resolve(root), key));
    return {
      async write(chunk) {
        await (await opened).write(chunk);
      },
      async end() {
        await (await opened).end();
      },
    };
  };
}

/** A sink that hashes and counts what passes through to `inner`. */
export interface HashingSink extends ByteSink {
  readonly bytes: number;
  /** Hex SHA-256 of everything written; only after `end`. */
  sha256(): string;
}

export function hashingSink(inner: ByteSink): HashingSink {
  const hash = createHash('sha256');
  let bytes = 0;
  let digest: string | null = null;
  return {
    get bytes() {
      return bytes;
    },
    async write(chunk) {
      hash.update(chunk);
      bytes += chunk.length;
      await inner.write(chunk);
    },
    async end() {
      await inner.end();
      digest = hash.digest('hex');
    },
    sha256() {
      if (digest === null) throw new Error('the sink has not ended');
      return digest;
    },
  };
}

/** Hex SHA-256 of some bytes. */
export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A memory sink, for the tests and the small published objects. */
export function memorySink(): ByteSink & { bytes(): Uint8Array } {
  const parts: Uint8Array[] = [];
  return {
    async write(chunk) {
      parts.push(chunk.slice());
    },
    async end() {},
    bytes() {
      // A copy, never a view into Buffer's shared pool: callers take `.buffer`.
      return new Uint8Array(Buffer.concat(parts));
    },
  };
}
