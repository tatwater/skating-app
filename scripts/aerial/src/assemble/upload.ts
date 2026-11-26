/**
 * **The rclone boundary** — the one file `vitest.config.ts` excludes for the assembler: every
 * process that talks to R2. Nothing here decides anything; it moves bytes and reports exits.
 *
 * - `rcatSink` — `rclone rcat` over stdin: a streamed multipart upload in **128 MiB parts** (64 MiB ×
 *   the 10,000-part cap is ~625 GiB, too close to the high size estimate; 128 MiB allows ~1.2 TiB),
 *   with the upload concurrency held to 2 so rclone's part buffers stay ~256 MiB beside the
 *   assembler's own memory.
 * - `serveHttp` — `rclone serve http` over the bucket, read-only, on localhost: the `httpStore` the
 *   assembler range-reads shards and the current archive through (one process for every read; Go's
 *   `ServeContent` honors `Range`, and with the VFS cache off each read is a ranged GET to R2).
 * - `rcloneJson` / `rcloneRun` — `lsjson` and `deletefile` for cleanup.
 *
 * The remote's credentials are the rclone config the Machine's entrypoint writes from the app's
 * staged secrets (or the laptop's gitignored remote); nothing here reads or prints a value.
 */

import { spawn } from 'node:child_process';
import type { ByteSink } from './stores';

/** Where on R2: an rclone remote name, a bucket, and optionally the config file. */
export interface RcloneTarget {
  remote: string;
  bucket: string;
  config?: string;
}

const base = (t: RcloneTarget): string[] => [
  ...(t.config ? ['--config', t.config] : []),
  '--s3-no-check-bucket',
];

/** What a published object is served with. */
export interface UploadHeaders {
  contentType: string;
  contentEncoding?: 'gzip';
  cacheControl?: string;
}

/** A sink that streams into `rclone rcat <remote>:<bucket>/<key>`; `end` resolves on exit 0. */
export function rcatSink(target: RcloneTarget, key: string, headers: UploadHeaders): ByteSink {
  const args = [
    'rcat',
    ...base(target),
    '--s3-chunk-size',
    '128M',
    '--s3-upload-concurrency',
    '2',
    '--header-upload',
    `Content-Type: ${headers.contentType}`,
    ...(headers.contentEncoding
      ? ['--header-upload', `Content-Encoding: ${headers.contentEncoding}`]
      : []),
    ...(headers.cacheControl ? ['--header-upload', `Cache-Control: ${headers.cacheControl}`] : []),
    `${target.remote}:${target.bucket}/${key}`,
  ];
  const child = spawn('rclone', args, { stdio: ['pipe', 'inherit', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr = (stderr + String(d)).slice(-4000);
  });
  const exited = new Promise<void>((done, fail) => {
    child.on('error', fail);
    child.on('close', (code) =>
      code === 0 ? done() : fail(new Error(`rclone rcat ${key} exited ${code}: ${stderr.trim()}`)),
    );
  });
  exited.catch(() => {});
  let failure: Error | null = null;
  child.stdin.on('error', (e) => {
    failure = e;
  });
  // A write waiting on `drain` must not outlive rclone: if it exits first, the write fails with it.
  const died = exited.then(() => {
    throw new Error(`rclone rcat ${key} exited before the stream ended`);
  });
  died.catch(() => {});
  return {
    async write(chunk) {
      if (failure) throw failure;
      if (child.stdin.write(chunk)) return;
      await Promise.race([new Promise<void>((done) => child.stdin.once('drain', done)), died]);
    },
    async end() {
      child.stdin.end();
      await exited;
    },
  };
}

/** `rclone serve http` over the bucket on `127.0.0.1:<port>`, read-only; resolves once it answers. */
export async function serveHttp(
  target: RcloneTarget,
  port: number,
): Promise<{ baseUrl: string; stop: () => void }> {
  const child = spawn(
    'rclone',
    [
      'serve',
      'http',
      ...base(target),
      '--read-only',
      '--vfs-cache-mode',
      'off',
      '--addr',
      `127.0.0.1:${port}`,
      `${target.remote}:${target.bucket}`,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
  const baseUrl = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`rclone serve http exited ${child.exitCode}`);
    try {
      const res = await fetch(baseUrl, { method: 'HEAD' });
      await res.body?.cancel();
      return { baseUrl, stop: () => child.kill('SIGTERM') };
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  child.kill('SIGTERM');
  throw new Error('rclone serve http never answered');
}

/** Run rclone with `args` after the target's flags; resolves with stdout, rejects on a non-zero exit. */
export function rcloneRun(target: RcloneTarget, args: readonly string[]): Promise<string> {
  return new Promise((done, fail) => {
    const [verb, ...rest] = args;
    const child = spawn('rclone', [verb as string, ...base(target), ...rest], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => {
      out += String(d);
    });
    child.stderr.on('data', (d) => {
      err = (err + String(d)).slice(-4000);
    });
    child.on('error', fail);
    child.on('close', (code) =>
      code === 0 ? done(out) : fail(new Error(`rclone ${verb} exited ${code}: ${err.trim()}`)),
    );
  });
}

/** `rclone lsjson` of a prefix: names, sizes and modification times. */
export async function rcloneList(
  target: RcloneTarget,
  prefix: string,
): Promise<{ Path: string; Size: number; ModTime: string; IsDir: boolean }[]> {
  try {
    return JSON.parse(
      await rcloneRun(target, [
        'lsjson',
        '--recursive',
        `${target.remote}:${target.bucket}/${prefix}`,
      ]),
    );
  } catch (e) {
    // A prefix with nothing under it is "directory not found" to rclone: an empty listing.
    if (/directory not found/i.test((e as Error).message)) return [];
    throw e;
  }
}
