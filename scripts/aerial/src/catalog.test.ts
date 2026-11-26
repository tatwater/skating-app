import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { readSnapshot, walkCatalog } from './catalog';

const dirs: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), 'aerial-catalog-'));
  dirs.push(d);
  return join(d, 'inventory');
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** One item per state, labeled with that state, on a cell inside it. */
const CELL: Record<string, string> = {
  ny: '4307501ne',
  vt: '4407236se',
  nh: '4407136se',
  me: '4407028ne',
  ma: '4207239sw',
  ct: '4107201ne',
  ri: '4107152ne',
};
function stateCatalog() {
  return vi.fn(async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}') as { query: { 'naip:state': { eq: string } } };
    const st = body.query['naip:state'].eq;
    const key = CELL[st] as string;
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        features: [
          {
            id: `${st}_m_${key.slice(0, 7)}_${key.slice(7)}_18_030_20230701`,
            bbox: [0, 0, 1, 1],
            properties: {
              datetime: '2023-07-01T16:00:00Z',
              gsd: 0.3,
              'naip:year': '2023',
              'naip:state': st,
            },
            assets: {},
          },
        ],
        links: [],
      }),
    };
  });
}

describe('walkCatalog', () => {
  test('walks the seven states, keeps each as gzipped JSONL, and records the walk last', async () => {
    const inventoryDir = scratch();
    const fetchFn = stateCatalog();
    const seen: string[] = [];
    const snap = await walkCatalog({
      fetchFn,
      inventoryDir,
      now: () => new Date('2026-11-25T23:30:00Z'),
      onState: (s, n, p) => seen.push(`${s}:${n}:${p}`),
    });
    expect(snap.walked).toBe(true);
    expect(snap.walkedOn).toBe('2026-11-25');
    expect(snap.items).toHaveLength(7);
    expect(seen).toEqual(['NY:1:1', 'VT:1:1', 'NH:1:1', 'ME:1:1', 'MA:1:1', 'CT:1:1', 'RI:1:1']);
    const vt = gunzipSync(readFileSync(join(inventoryDir, 'vt.jsonl.gz'))).toString('utf8');
    expect(JSON.parse(vt.trim()).itemId).toBe('vt_m_4407236_se_18_030_20230701');
    expect(JSON.parse(readFileSync(join(inventoryDir, 'walk.json'), 'utf8'))).toEqual({
      walkedOn: '2026-11-25',
      perState: { NY: 1, VT: 1, NH: 1, ME: 1, MA: 1, CT: 1, RI: 1 },
      pages: { NY: 1, VT: 1, NH: 1, ME: 1, MA: 1, CT: 1, RI: 1 },
    });
  });

  test("a re-run reads the campaign's snapshot instead of walking again", async () => {
    const inventoryDir = scratch();
    await walkCatalog({ fetchFn: stateCatalog(), inventoryDir });
    const again = stateCatalog();
    const seen: string[] = [];
    const snap = await walkCatalog({ fetchFn: again, inventoryDir, onState: (s) => seen.push(s) });
    expect(again).not.toHaveBeenCalled();
    expect(snap.walked).toBe(false);
    expect(snap.items).toHaveLength(7);
    expect(seen).toHaveLength(7);
    expect(readSnapshot(inventoryDir)?.items).toEqual(snap.items);
  });

  test('a walk that died midway (no walk.json) is walked again, not read half', async () => {
    const inventoryDir = scratch();
    const failing = stateCatalog();
    failing.mockImplementationOnce(async () => ({
      ok: false,
      status: 400,
      statusText: 'Bad',
      json: async () => ({}),
    }));
    await expect(walkCatalog({ fetchFn: failing, inventoryDir })).rejects.toThrow(/400/);
    expect(readSnapshot(inventoryDir)).toBeNull();
    const snap = await walkCatalog({ fetchFn: stateCatalog(), inventoryDir });
    expect(snap.walked).toBe(true);
  });

  test('a snapshot whose file disagrees with its record is refused', async () => {
    const inventoryDir = scratch();
    await walkCatalog({ fetchFn: stateCatalog(), inventoryDir });
    const record = JSON.parse(readFileSync(join(inventoryDir, 'walk.json'), 'utf8'));
    record.perState.RI = 2;
    writeFileSync(join(inventoryDir, 'walk.json'), JSON.stringify(record));
    expect(() => readSnapshot(inventoryDir)).toThrow(/RI file holds 1 items, but walk.json says 2/);
  });

  test('an empty state is kept as an empty file', async () => {
    const inventoryDir = scratch();
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ features: [], links: [] }),
    }));
    const snap = await walkCatalog({ fetchFn, inventoryDir });
    expect(snap.items).toEqual([]);
    expect(readSnapshot(inventoryDir)?.perState.NY).toBe(0);
  });
});
