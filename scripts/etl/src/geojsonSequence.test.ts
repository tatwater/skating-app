import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readGeoJsonSequence } from './geojsonSequence';

it('streams plain and RFC 8142 records in order, reporting malformed JSON without stopping', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'geojson-sequence-'));
  const file = join(dir, 'sample.geojsonseq');
  const rs = String.fromCharCode(0x1e);
  try {
    writeFileSync(file, `  {"id":1}\r\n \r\n${rs}{"id":2}\n${rs}\n{oops}\n{"id":3}`);

    const records = [];
    for await (const record of readGeoJsonSequence<{ id: number }>(file)) records.push(record);

    expect(records).toEqual([
      { ok: true, feature: { id: 1 } },
      { ok: true, feature: { id: 2 } },
      { ok: false },
      { ok: true, feature: { id: 3 } },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('propagates a file read failure rather than treating it as a bad record or empty input', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'geojson-sequence-'));
  try {
    const records = readGeoJsonSequence(join(dir, 'missing.geojsonseq'));
    await expect(records.next()).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
