import { spawn } from 'node:child_process';
import process from 'node:process';
import { inflateSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';
import { seedPng } from './png';
import type { Call } from './seed';
import { FULL_PX, postFile, THUMB_PX, uploader, uploadRefusal } from './upload';

describe('seedPng', () => {
  test('a valid PNG of the size asked, one color drawn from its seed', () => {
    const png = seedPng('ph-1:full', 4);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR');
    expect(png.readUInt32BE(16)).toBe(4);
    expect(png.readUInt32BE(20)).toBe(4);
    const idatLength = png.readUInt32BE(33);
    expect(png.subarray(37, 41).toString('ascii')).toBe('IDAT');
    const pixels = inflateSync(png.subarray(41, 41 + idatLength));
    expect(pixels).toHaveLength(4 * (1 + 4 * 3));
    expect(png.subarray(-8, -4).toString('ascii')).toBe('IEND');
    // Distinct files per step and slot.
    expect(seedPng('ph-1:thumb', 4).equals(png)).toBe(false);
    expect(seedPng('ph-1:full', 4).equals(png)).toBe(true);
  });
});

describe('uploadRefusal', () => {
  test('only the dev deployment’s own host', () => {
    expect(
      uploadRefusal(
        'https://happy-cat-123.convex.cloud/api/storage/upload?token=x',
        'happy-cat-123',
      ),
    ).toBeNull();
    expect(
      uploadRefusal('https://other-dog-9.convex.cloud/api/storage/upload', 'happy-cat-123'),
    ).toBe('The upload address is not this deployment’s; nothing was sent.');
    expect(uploadRefusal('https://happy-cat-123.convex.cloud/x', null)).toBe(
      'Photos are uploaded to a dev deployment only.',
    );
    expect(uploadRefusal('not a url', 'happy-cat-123')).toBe(
      'The upload address could not be read; nothing was sent.',
    );
  });
});

describe('uploader', () => {
  const URL_SECRET = 'https://happy-cat-123.convex.cloud/api/storage/upload?token=secret-token';
  test('two addresses as the step’s person, two POSTs, two ids — the address in neither answer', () => {
    const asked: unknown[] = [];
    const call: Call = <T>(fn: string, args: unknown, runAs?: unknown): T => {
      asked.push({ fn, args, runAs });
      return URL_SECRET as T;
    };
    const posts: { url: string; size: number }[] = [];
    const up = uploader(call, 'happy-cat-123', (url, bytes) => {
      posts.push({ url, size: bytes.length });
      return `id-${posts.length}`;
    });
    const runAs = { as: 'seed_inbox_gus', via: 'seed-inbox' };
    const ids = up({ key: 'ph-1', label: 'p', as: 'gus', fn: 'photos:create', args: {} }, runAs);
    expect(ids).toEqual({ storageId: 'id-1', thumbStorageId: 'id-2' });
    expect(JSON.stringify(ids)).not.toContain('token');
    expect(asked).toEqual([
      { fn: 'photos:generateUploadUrl', args: {}, runAs },
      { fn: 'photos:generateUploadUrl', args: {}, runAs },
    ]);
    expect(posts.map((p) => p.url)).toEqual([URL_SECRET, URL_SECRET]);
    expect(posts[0]?.size).toBe(seedPng('ph-1:full', FULL_PX).length);
    expect(posts[1]?.size).toBe(seedPng('ph-1:thumb', THUMB_PX).length);
  });

  test('an address off the deployment: nothing is posted', () => {
    const call: Call = <T>(): T => 'https://elsewhere.convex.cloud/api/storage/upload' as T;
    let posted = false;
    const up = uploader(call, 'happy-cat-123', () => {
      posted = true;
      return 'x';
    });
    expect(() =>
      up({ key: 'ph-1', label: 'p', as: 'gus', fn: 'photos:create', args: {} }, undefined),
    ).toThrow('not this deployment’s');
    expect(posted).toBe(false);
  });
});

/** A local server in its own process (the POST is synchronous): answers each POST with `body`. */
async function server(body: string, status = 200) {
  const child = spawn(process.execPath, [
    '-e',
    `const s = require('node:http').createServer((req, res) => {
       let n = 0; req.on('data', (c) => { n += c.length; });
       req.on('end', () => { res.writeHead(${status}, { 'content-type': 'application/json' }); res.end(${JSON.stringify(body)}.replace('N', String(n)) + ''); });
     });
     s.listen(0, '127.0.0.1', () => process.stdout.write(String(s.address().port) + '\\n'));`,
  ]);
  const port = await new Promise<number>((resolve) =>
    child.stdout.once('data', (c: Buffer) => resolve(Number(c.toString().trim()))),
  );
  return {
    url: `http://127.0.0.1:${port}/api/storage/upload?token=secret-token`,
    stop: () => child.kill(),
  };
}

describe('postFile', () => {
  test('the bytes POSTed, the stored id answered', async () => {
    const s = await server('{"storageId":"kg-N"}');
    try {
      expect(postFile(s.url, Buffer.from('12345'))).toBe('kg-5');
    } finally {
      s.stop();
    }
  });

  test('an answer without a stored id, or a refusal, is an error without the address', async () => {
    const s = await server('{"nope":true}');
    const refused = await server('denied', 403);
    try {
      expect(() => postFile(s.url, Buffer.from('x'))).toThrow(
        'The photo upload answered no stored id.',
      );
      let message = '';
      try {
        postFile(refused.url, Buffer.from('x'));
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toBe('The photo upload failed: upload answered 403');
    } finally {
      s.stop();
      refused.stop();
    }
  });

  test('a POST that fails says so, without the address', () => {
    // Port 9 (discard) on localhost refuses: the child's fetch fails, its exit is non-zero.
    const url = 'http://127.0.0.1:9/api/storage/upload?token=secret-token';
    let message = '';
    try {
      postFile(url, Buffer.from('x'));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/^The photo upload failed: upload failed: /);
    expect(message).not.toContain('secret-token');
  });
});
