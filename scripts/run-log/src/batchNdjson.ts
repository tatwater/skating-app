import { Buffer } from 'node:buffer';

// The count bounds work per mutation. The input byte budget leaves room for the surrounding
// inline JSON and environment in `convex run`'s argv; it isn't a serialized payload size check.
const MAX_BATCH_COUNT = 150;
const MAX_BATCH_BYTES = 512 * 1024;

/**
 * Batch NDJSON lines for a canonical import, in input order. Count UTF-8 bytes plus one
 * newline per record. An oversized line goes in a batch on its own rather than being dropped.
 */
export function batchNdjson(lines: readonly string[]): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line) + 1;
    if (
      current.length > 0 &&
      (current.length >= MAX_BATCH_COUNT || size + lineBytes > MAX_BATCH_BYTES)
    ) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(line);
    size += lineBytes;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
