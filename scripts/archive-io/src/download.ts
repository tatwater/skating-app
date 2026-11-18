import { createHash } from 'node:crypto';
import { createWriteStream, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { pipeline } from 'node:stream/promises';
import { Effect } from 'effect';

interface DownloadOptions {
  url: string;
  destination: string;
  userAgent: string;
  expectedBytes?: number;
  onBytes?: (bytes: number) => void;
  fetchImpl?: typeof fetch;
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

async function transfer(
  { url, userAgent, expectedBytes, onBytes, fetchImpl = fetch }: DownloadOptions,
  path: string,
  signal: AbortSignal,
) {
  const response = await fetchImpl(url, { headers: { 'User-Agent': userAgent }, signal });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`download failed (${response.status} ${response.statusText})`);
  }
  const lengthHeader = response.headers.get('content-length');
  const contentLength = lengthHeader !== null ? Number(lengthHeader) : undefined;
  const length =
    contentLength !== undefined && Number.isSafeInteger(contentLength) && contentLength >= 0
      ? contentLength
      : undefined;
  const encoding = response.headers.get('content-encoding');
  // fetch decodes compressed HTTP responses; their wire length isn't the saved length.
  const size = expectedBytes ?? (encoding && encoding !== 'identity' ? undefined : length);
  const hash = createHash('sha256');
  let bytes = 0;
  const out = createWriteStream(path);
  const closed = new Promise<void>((resolve) => out.once('close', resolve));
  try {
    await pipeline(
      response.body,
      async function* (chunks: AsyncIterable<Uint8Array>) {
        for await (const chunk of chunks) {
          bytes += chunk.byteLength;
          hash.update(chunk);
          onBytes?.(bytes);
          yield chunk;
        }
      },
      out,
      { signal },
    );
  } finally {
    // A body can fail before the filesystem finishes opening the writer. Wait for close before
    // the scope removes staging so that a late open cannot race with cleanup.
    out.destroy();
    await closed;
  }
  if (size !== undefined && bytes !== size) {
    throw new Error(`download size mismatch: got ${bytes} bytes, expected ${size}`);
  }
  return {
    bytes,
    sha256: hash.digest('hex'),
    http: {
      lastModified: response.headers.get('last-modified') ?? undefined,
      etag: response.headers.get('etag') ?? undefined,
      contentLength: length,
    },
  };
}

/** Stage beside the destination so a verified transfer can replace it with a single rename. */
export function downloadArchive(options: DownloadOptions, signal?: AbortSignal) {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const dir = yield* Effect.acquireRelease(
        Effect.try({
          try: () => mkdtempSync(join(dirname(options.destination), '.download-')),
          catch: asError,
        }),
        (path) => Effect.sync(() => rmSync(path, { recursive: true, force: true })),
      );
      const path = join(dir, 'payload');
      const file = yield* Effect.callback<Awaited<ReturnType<typeof transfer>>, Error>(
        (resume, transferSignal) => {
          const done = transfer(options, path, transferSignal).then(
            (result) => resume(Effect.succeed(result)),
            (cause) => resume(Effect.fail(asError(cause))),
          );
          // Interruption aborts fetch and pipeline, then joins them before the scope removes staging.
          return Effect.promise(() => done);
        },
      );
      yield* Effect.try({
        try: () => renameSync(path, options.destination),
        catch: asError,
      });
      return file;
    }),
  );
  return Effect.runPromise(program, { signal });
}

export class ArchiveTransferInterrupted extends Error {
  readonly exitCode: number;

  constructor(signal: NodeJS.Signals) {
    super(`download interrupted by ${signal}`);
    this.exitCode = signal === 'SIGINT' ? 130 : 143;
  }
}

/** CLI-only signal handling; do not change how other steps in the command handle signals. */
export async function downloadArchiveForCli(options: DownloadOptions) {
  const controller = new AbortController();
  const stop = (signal: NodeJS.Signals) => controller.abort(new ArchiveTransferInterrupted(signal));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    return await downloadArchive(options, controller.signal);
  } catch (error) {
    throw controller.signal.reason ?? error;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}
