import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { downloadArchive } from './download';

test('preserves the published archive on abort and size mismatch, then restarts from byte zero', async () => {
  const previousPayload = 'previous archive';
  const nextPayload = 'replacement archive';
  const interruption = new AbortController();
  const requests: { range: string | undefined; userAgent: string | undefined }[] = [];
  const server = createServer((request, response) => {
    requests.push({ range: request.headers.range, userAgent: request.headers['user-agent'] });
    if (requests.length === 1) {
      // Send a real first chunk but never finish. The downloader aborts after receiving it.
      response.writeHead(200, { 'Content-Length': nextPayload.length });
      response.write(nextPayload.slice(0, 4));
      return;
    }
    if (requests.length === 2) {
      response.end('short');
      return;
    }
    response.writeHead(200, { 'Content-Length': nextPayload.length, ETag: '"fixture"' });
    response.end(nextPayload);
  });

  const directory = await mkdtemp(join(tmpdir(), 'archive-http-'));
  const destination = join(directory, 'archive.zip');
  try {
    await writeFile(destination, previousPayload);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture server has no TCP port');

    const options = {
      url: `http://127.0.0.1:${address.port}/archive.zip`,
      destination,
      userAgent: 'archive-http-fixture',
      expectedBytes: nextPayload.length,
    };
    let interruptedByteCount = 0;
    await expect(
      downloadArchive(
        {
          ...options,
          onBytes: (byteCount) => {
            if (byteCount === 4) {
              interruptedByteCount = byteCount;
              interruption.abort();
            }
          },
        },
        interruption.signal,
      ),
    ).rejects.toThrow();
    expect(interruptedByteCount).toBe(4);
    expect(await readFile(destination, 'utf8')).toBe(previousPayload);
    expect(await readdir(directory)).toEqual(['archive.zip']);

    await expect(downloadArchive(options)).rejects.toThrow(
      `download size mismatch: got 5 bytes, expected ${nextPayload.length}`,
    );
    expect(await readFile(destination, 'utf8')).toBe(previousPayload);
    expect(await readdir(directory)).toEqual(['archive.zip']);

    await expect(downloadArchive(options)).resolves.toEqual({
      bytes: nextPayload.length,
      sha256: createHash('sha256').update(nextPayload).digest('hex'),
      http: { lastModified: undefined, etag: '"fixture"', contentLength: nextPayload.length },
    });
    expect(await readFile(destination, 'utf8')).toBe(nextPayload);
    expect(await readdir(directory)).toEqual(['archive.zip']);
    expect(requests).toEqual([
      { range: undefined, userAgent: options.userAgent },
      { range: undefined, userAgent: options.userAgent },
      { range: undefined, userAgent: options.userAgent },
    ]);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    await rm(directory, { recursive: true, force: true });
  }
});
