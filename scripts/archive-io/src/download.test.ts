import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ArchiveTransferInterrupted, downloadArchive, downloadArchiveForCli } from './download';

const url = 'https://source.example.test/archive.zip';
const userAgent = 'archive-test';
let dir: string;
let destination: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'archive-io-'));
  destination = join(dir, 'archive.zip');
  await writeFile(destination, 'previous');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function assertPublished(text: string) {
  expect(await readdir(dir)).toEqual(['archive.zip']);
  expect(await readFile(destination, 'utf8')).toBe(text);
}

test('streams, counts, and hashes the payload before replacing the archive', async () => {
  const onBytes = vi.fn();
  const fetchImpl = vi.fn<typeof fetch>(
    async () =>
      new Response('new bytes', {
        headers: { 'Content-Length': '9', ETag: 'source', 'Last-Modified': 'yesterday' },
      }),
  );
  expect(await downloadArchive({ url, destination, userAgent, fetchImpl, onBytes })).toEqual({
    bytes: 9,
    sha256: createHash('sha256').update('new bytes').digest('hex'),
    http: { contentLength: 9, etag: 'source', lastModified: 'yesterday' },
  });
  expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
    url,
    expect.objectContaining({ headers: { 'User-Agent': userAgent } }),
  );
  expect(onBytes).toHaveBeenLastCalledWith(9);
  await assertPublished('new bytes');
});

test.each([
  { expectedBytes: 10, headers: { 'Content-Length': '3' } },
  { expectedBytes: undefined, headers: { 'Content-Length': '10' } },
])('rejects a short read without replacing the last good file (%j)', async (input) => {
  await expect(
    downloadArchive({
      url,
      destination,
      userAgent,
      ...(input.expectedBytes === undefined ? {} : { expectedBytes: input.expectedBytes }),
      fetchImpl: async () => new Response('bad', { headers: input.headers }),
    }),
  ).rejects.toThrow('got 3 bytes, expected 10');
  await assertPublished('previous');
});

test('does not use encoded wire length to validate the decoded file', async () => {
  const fetchImpl = async () =>
    new Response('decoded bytes', {
      headers: { 'Content-Length': '42', 'Content-Encoding': 'gzip' },
    });
  const file = await downloadArchive({ url, destination, userAgent, fetchImpl });
  expect(file).toMatchObject({ bytes: 13, http: { contentLength: 42 } });
  await assertPublished('decoded bytes');
});

test('does not retry HTTP failures or broken streams', async () => {
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response('busy', { status: 503 }))
    .mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          pull: (stream) => stream.error(new Error('source went away')),
        }),
      ),
    );
  await expect(downloadArchive({ url, destination, userAgent, fetchImpl })).rejects.toThrow('503');
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  await expect(downloadArchive({ url, destination, userAgent, fetchImpl })).rejects.toThrow(
    'source went away',
  );
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  await assertPublished('previous');
});

test('aborts the active body and removes staging before rejecting', async () => {
  const controller = new AbortController();
  const cancel = vi.fn();
  const fetchImpl = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start: (stream) => stream.enqueue(new TextEncoder().encode('prefix')),
        cancel,
      }),
    );
  const download = downloadArchive(
    { url, destination, userAgent, fetchImpl, onBytes: () => controller.abort() },
    controller.signal,
  );
  await expect(download).rejects.toThrow();
  expect(cancel).toHaveBeenCalledTimes(1);
  await assertPublished('previous');
});

test.each([
  ['SIGINT', 130],
  ['SIGTERM', 143],
] as const)('reports %s to the CLI and removes both signal handlers', async (signal, exitCode) => {
  const original = process.listenerCount(signal);
  const fetchImpl: typeof fetch = (_url, init) =>
    new Promise((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      queueMicrotask(() => process.emit(signal, signal));
    });
  const download = downloadArchiveForCli({ url, destination, userAgent, fetchImpl });
  await expect(download).rejects.toThrow(ArchiveTransferInterrupted);
  await expect(download).rejects.toMatchObject({ exitCode });
  expect(process.listenerCount(signal)).toBe(original);
  await assertPublished('previous');
});

test('leaves the previous file intact if publication fails', async () => {
  const fetchImpl = async () => new Response('new');
  await expect(
    downloadArchive({
      url,
      destination: join(dir, 'missing', 'archive.zip'),
      userAgent,
      fetchImpl,
    }),
  ).rejects.toThrow('ENOENT');
  await expect(downloadArchive({ url, destination: dir, userAgent, fetchImpl })).rejects.toThrow();
  await assertPublished('previous');
});

test('passes through an ordinary CLI download failure and removes its signal handlers', async () => {
  const interruptListeners = process.listenerCount('SIGINT');
  const terminateListeners = process.listenerCount('SIGTERM');
  const fetchImpl: typeof fetch = async () => {
    throw 'fixture source unavailable';
  };

  await expect(downloadArchiveForCli({ url, destination, userAgent, fetchImpl })).rejects.toThrow(
    'fixture source unavailable',
  );
  expect(process.listenerCount('SIGINT')).toBe(interruptListeners);
  expect(process.listenerCount('SIGTERM')).toBe(terminateListeners);
  await assertPublished('previous');
});
