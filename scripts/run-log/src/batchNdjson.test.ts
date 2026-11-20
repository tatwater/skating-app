import { describe, expect, it } from 'vitest';
import { batchNdjson } from './batchNdjson';

describe('batchNdjson', () => {
  it('does not emit an empty batch', () => {
    expect(batchNdjson([])).toEqual([]);
  });

  it('splits after 150 records and preserves their order', () => {
    const lines = Array.from({ length: 151 }, (_, id) => JSON.stringify({ id }));
    expect(batchNdjson(lines)).toEqual([lines.slice(0, 150), lines.slice(150)]);
  });

  it('allows exactly 512 KiB and counts both UTF-8 bytes and newline separators', () => {
    // Each quoted value has 262,140 bytes of text, two quotes, and one newline.
    const line = `"${'é'.repeat(131_070)}"`;
    expect(batchNdjson([line, line, '0']).map((batch) => batch.length)).toEqual([3]);
    expect(batchNdjson([line, line, '{}']).map((batch) => batch.length)).toEqual([2, 1]);
  });

  it('puts an oversized line in its own batch without losing adjacent records', () => {
    const line = `"${'x'.repeat(512 * 1024)}"`;
    expect(batchNdjson([line, '{}', line, '[]'])).toEqual([[line], ['{}'], [line], ['[]']]);
  });
});
