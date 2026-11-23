/**
 * **A small, valid PNG made in code** — the seed's photos: a solid square whose color is drawn from
 * the step's key, so each photo and its thumbnail are distinct files. No real photo, nothing fetched.
 */

import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

/** A `size`×`size` PNG of one color, its color from `seed` (an RGB triple from its hash). */
export function seedPng(seed: string, size: number): Buffer {
  const [r, g, b] = createHash('sha256').update(seed).digest();
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // color type: truecolor
  // compression, filter and interlace stay 0
  const row = Buffer.alloc(1 + size * 3);
  for (let x = 0; x < size; x++) row.set([r ?? 0, g ?? 0, b ?? 0], 1 + x * 3);
  const pixels = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
