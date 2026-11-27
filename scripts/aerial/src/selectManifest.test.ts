import {
  NAIP_RULE_VERSION,
  type NaipCandidate,
  type NaipManifest,
  naipExclusionsHash,
  naipFoliageStrikesHash,
  naipWorkTileInputHash,
  selectNaipPicks,
  workTileKey,
  workTilesOf,
} from '@skating/core';
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import type { ThumbnailScore } from './score';
import {
  buildManifest,
  framesShowing,
  isPartial,
  type ManifestInput,
  manifestCounts,
} from './selectManifest';

let serial = 0;
function frame(key: string, acquired: string, gsd: number, state = 'VT'): NaipCandidate {
  return {
    itemId: `${state.toLowerCase()}_m_${key.slice(0, 7)}_${key.slice(7)}_18_${gsd === 0.3 ? '030' : '060'}_${acquired.replaceAll('-', '')}_${serial++}`,
    key,
    state: state as NaipCandidate['state'],
    acquired,
    gsd,
    year: Number(acquired.slice(0, 4)),
    bbox: [0, 0, 0, 0],
  };
}

const FULL: ThumbnailScore = { white: 0.001, valid: 1 };
const HALF: ThumbnailScore = { white: 0, valid: 0.4 };

// Two neighboring Vermont cells in one work tile, and one far off in its own.
const K1 = '4407236se';
const K2 = '4407236sw';
const K3 = '4307236se';
const a1 = frame(K1, '2025-07-01', 0.3);
const b1 = frame(K1, '2023-07-01', 0.6);
const a2 = frame(K2, '2025-07-01', 0.3);
const a3 = frame(K3, '2025-07-01', 0.3);
const b3 = frame(K3, '2021-07-01', 0.6, 'NY');

function input(
  over: Partial<ManifestInput> = {},
  cands: NaipCandidate[] = [a1, b1, a2, a3, b3],
): ManifestInput {
  return {
    campaign: 'naip-20261201',
    pilot: null,
    createdAt: '2026-12-01T12:00:00.000Z',
    catalog: {
      walkedOn: '2026-12-01',
      items: cands.length,
      perState: { VT: 4, NY: 1 },
      archivedAt: null,
    },
    selection: selectNaipPicks(cands, []),
    exclusions: [],
    foliageStrikes: [],
    scores: new Map([
      [a1.itemId, FULL],
      [a2.itemId, HALF],
      [a3.itemId, { white: 0.2, valid: 1 }],
    ]),
    narrowing: null,
    current: null,
    ...over,
  };
}

describe('framesShowing', () => {
  const pick = selectNaipPicks([a1, b1, frame(K1, '2021-07-01', 0.6)], [], []).picks[0] as never;

  test('a pick that covers its cell shows alone', () => {
    expect(framesShowing(pick, new Map([[a1.itemId, FULL]]))).toEqual({
      showing: [a1],
      pending: [],
    });
  });

  test('a partial pick shows its fallbacks down to the first that covers', () => {
    const p = pick as { stack: NaipCandidate[] };
    const scores = new Map<string, ThumbnailScore | null>([
      [a1.itemId, HALF],
      [b1.itemId, FULL],
    ]);
    expect(framesShowing(pick, scores).showing).toEqual([a1, b1]);
    expect(p.stack).toHaveLength(2);
  });

  test('asks for the next frame down while it is unknown; an unscored frame counts as partial', () => {
    expect(framesShowing(pick, new Map())).toEqual({ showing: [], pending: [a1] });
    expect(framesShowing(pick, new Map([[a1.itemId, null]]))).toEqual({
      showing: [a1],
      pending: [b1],
    });
  });

  test('isPartial', () => {
    expect([isPartial(FULL), isPartial(HALF), isPartial(null), isPartial(undefined)]).toEqual([
      false,
      true,
      true,
      true,
    ]);
  });
});

describe('buildManifest, from nothing', () => {
  const m = buildManifest(input());

  test('records every cell: pick, step, stack, partial, score and work tiles', () => {
    expect(m.cells).toEqual([
      {
        key: K3,
        states: ['NY', 'VT'],
        pick: a3.itemId,
        step: 'leafOn',
        stack: [b3.itemId],
        partial: false,
        cloudScore: 0.2,
        workTiles: workTilesOf(K3).map(workTileKey),
      },
      expect.objectContaining({
        key: K1,
        pick: a1.itemId,
        stack: [b1.itemId],
        partial: false,
        cloudScore: 0.001,
      }),
      expect.objectContaining({
        key: K2,
        pick: a2.itemId,
        stack: [],
        partial: true,
        cloudScore: 0,
      }),
    ]);
  });

  test('holds every frame a cell picks or stacks, by item id', () => {
    expect(Object.keys(m.frames).sort()).toEqual([a1, b1, a2, a3, b3].map((f) => f.itemId).sort());
    expect(m.frames[b3.itemId]).toEqual({
      acquired: '2021-07-01',
      gsd: 0.6,
      year: 2021,
      state: 'NY',
    });
  });

  test('cuts every work tile any cell touches, each hashed over its cells', () => {
    const tiles = new Set([K1, K2, K3].flatMap((k) => workTilesOf(k).map(workTileKey)));
    expect(m.workTiles.map((w) => w.key)).toEqual([...tiles].sort());
    for (const w of m.workTiles) {
      expect(w.retile).toBe(true);
      const cells = m.cells.filter((c) => c.workTiles.includes(w.key));
      expect(w.cells).toEqual(cells.map((c) => c.key).sort());
      expect(w.inputHash).toBe(naipWorkTileInputHash(w.key, cells, NAIP_RULE_VERSION));
    }
  });

  test('stamps the rule, the lists and the catalog it ran with', () => {
    expect(m).toMatchObject({
      version: 2,
      campaign: 'naip-20261201',
      pilot: null,
      ruleVersion: NAIP_RULE_VERSION,
      exclusionsHash: naipExclusionsHash([]),
      foliageStrikesHash: naipFoliageStrikesHash([]),
      offSeasonCells: [],
      basedOn: null,
      catalog: { walkedOn: '2026-12-01', items: 5 },
    });
    expect(m.archive).toBeUndefined();
  });

  test('counts', () => {
    expect(manifestCounts(m)).toEqual({
      cells: 3,
      frames: 5,
      workTiles: m.workTiles.length,
      workTilesCut: m.workTiles.length,
      pickedLeafOn: 3,
      pickedOffSeason: 0,
      offSeasonNoLeafOn: 0,
      offSeasonAllTurned: 0,
      partial: 1,
      unscored: 0,
      borderCells: 1,
    });
  });
});

describe('buildManifest, narrowed from nothing (the pilot)', () => {
  test('--cells: every cell recorded, only the work tiles the listed cells touch', () => {
    const m = buildManifest(input({ narrowing: { cells: [K3] }, pilot: 'p' }));
    expect(m.cells.map((c) => c.key)).toEqual([K3, K1, K2]);
    expect(m.workTiles.map((w) => w.key)).toEqual(workTilesOf(K3).map(workTileKey));
    expect(m.workTiles.every((w) => w.retile)).toBe(true);
  });

  test('--states: the cells a state lists', () => {
    const m = buildManifest(input({ narrowing: { states: ['NY'] } }));
    expect(m.workTiles.map((w) => w.key)).toEqual(workTilesOf(K3).map(workTileKey));
  });
});

describe('buildManifest, from the current build', () => {
  const published = (m: NaipManifest): NaipManifest => ({
    ...m,
    archive: { name: 'naip-summer-20261201.pmtiles', bytes: 1, sha256: 'x' },
  });
  const current = published(buildManifest(input()));
  const c1 = frame(K1, '2026-07-01', 0.3);
  const next = [a1, b1, c1, a2, a3, b3];

  test('nothing changed: every work tile copied', () => {
    const m = buildManifest(input({ current, campaign: 'naip-20270712' }));
    expect(m.workTiles.every((w) => !w.retile)).toBe(true);
    expect(m.basedOn).toEqual({
      archive: 'naip-summer-20261201.pmtiles',
      manifest: 'naip-summer-20261201-manifest.json',
    });
  });

  test("a new pick re-tiles exactly its cell's work tiles", () => {
    const m = buildManifest(input({ current, campaign: 'naip-20270712' }, next));
    const changed = new Set(workTilesOf(K1).map(workTileKey));
    for (const w of m.workTiles) expect(w.retile).toBe(changed.has(w.key));
    expect(m.cells.find((c) => c.key === K1)?.pick).toBe(c1.itemId);
  });

  test('narrowed away from the change: the current record stands and nothing is cut', () => {
    const m = buildManifest(
      input({ current, campaign: 'naip-20270712', narrowing: { cells: [K3] } }, next),
    );
    expect(m.cells.find((c) => c.key === K1)).toEqual(current.cells.find((c) => c.key === K1));
    expect(m.frames[c1.itemId]).toBeUndefined();
    expect(m.workTiles.every((w) => !w.retile)).toBe(true);
  });

  test('narrowed to the change: it is cut', () => {
    const m = buildManifest(
      input({ current, campaign: 'naip-20270712', narrowing: { states: ['VT'] } }, next),
    );
    expect(m.workTiles.filter((w) => w.retile).map((w) => w.key)).toEqual(
      workTilesOf(K1).map(workTileKey),
    );
  });

  test('a cell the catalog dropped leaves the build when considered, and stays when not', () => {
    const without = [a1, b1, a2];
    const all = buildManifest(input({ current, campaign: 'naip-20270712' }, without));
    expect(all.cells.map((c) => c.key)).not.toContain(K3);
    const narrowed = buildManifest(
      input({ current, campaign: 'naip-20270712', narrowing: { cells: [K1] } }, without),
    );
    expect(narrowed.cells.map((c) => c.key)).toContain(K3);
  });

  test('a new cell outside the narrowing stays out', () => {
    const before = published(buildManifest(input({}, [a1, b1, a2])));
    const m = buildManifest(
      input({ current: before, campaign: 'naip-20270712', narrowing: { cells: [K1] } }),
    );
    expect(m.cells.map((c) => c.key)).not.toContain(K3);
  });

  test('refuses a current build that was never published, or one missing a frame it names', () => {
    expect(() => buildManifest(input({ current: buildManifest(input()) }))).toThrow(
      /names no archive/,
    );
    const broken = { ...current, frames: {} };
    expect(() => buildManifest(input({ current: broken, narrowing: { cells: [K3] } }))).toThrow(
      /names frame .* but doesn't hold it/,
    );
  });

  test('refuses a current manifest of another format, outright', () => {
    // A rule-1 manifest (the pilot's) holds `offSeasonCells` as bare keys and no foliage hash: read
    // as this format, its off-season cells came back keyless and its kept cells were relabeled.
    const v1 = { ...current, version: 1, offSeasonCells: ['4407028ne'] } as unknown as NaipManifest;
    expect(() => buildManifest(input({ current: v1, campaign: 'naip-20270712' }))).toThrow(
      /--from-current: .* is a version-1 manifest; this select stage reads version 2/,
    );
  });

  test("refuses a narrowed build on another rule's manifest: its kept cells would be that rule's", () => {
    // As a rule-1 build's: its work tiles hashed under rule 1.
    const older = {
      ...current,
      ruleVersion: NAIP_RULE_VERSION - 1,
      workTiles: current.workTiles.map((w) => ({ ...w, inputHash: `rule-1 ${w.inputHash}` })),
    };
    expect(() =>
      buildManifest(
        input({ current: older, campaign: 'naip-20270712', narrowing: { cells: [K3] } }),
      ),
    ).toThrow(/built by rule \d+, not rule \d+: a narrowed build would keep its picks/);
    // Not narrowed, every cell is chosen afresh, and every work tile is cut (the hash holds the rule).
    const m = buildManifest(input({ current: older, campaign: 'naip-20270712' }));
    expect(m.ruleVersion).toBe(NAIP_RULE_VERSION);
    expect(m.workTiles.every((w) => w.retile)).toBe(true);
  });

  test('refuses a current manifest whose off-season cell has no why', () => {
    const offSeason = frame(K3, '2025-10-02', 0.3);
    const built = published(
      buildManifest(input({ selection: selectNaipPicks([offSeason], []) }, [offSeason])),
    );
    expect(built.offSeasonCells).toEqual([{ key: K3, why: 'noLeafOn' }]);
    expect(() =>
      buildManifest(
        input(
          {
            current: { ...built, offSeasonCells: [] },
            campaign: 'naip-20270712',
            narrowing: { cells: [K1] },
          },
          [a1, b1],
        ),
      ),
    ).toThrow(/off-season cell 4307236se has no why/);
  });

  test("refuses a production build on a pilot's manifest, and a pilot on production's", () => {
    const pilot = { ...current, campaign: 'naip-pilot-20261201', pilot: 'champlain' };
    expect(() => buildManifest(input({ current: pilot, campaign: 'naip-20270712' }))).toThrow(
      /is pilot champlain's; this build is production/,
    );
    expect(() =>
      buildManifest(input({ current, campaign: 'naip-pilot-20270712', pilot: 'champlain' })),
    ).toThrow(/is production's; this build is pilot champlain's/);
  });

  test("a changed cell changes exactly its work tiles' hashes (a property)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(K1, K2, K3),
        fc.integer({ min: 2026, max: 2030 }),
        (key, year) => {
          const newer = frame(key, `${year}-07-01`, 0.3);
          const m = buildManifest(
            input({ current, campaign: 'naip-20270712' }, [a1, b1, a2, a3, b3, newer]),
          );
          const touched = new Set(workTilesOf(key).map(workTileKey));
          const before = new Map(current.workTiles.map((w) => [w.key, w.inputHash]));
          for (const w of m.workTiles)
            expect(w.inputHash !== before.get(w.key)).toBe(touched.has(w.key));
        },
      ),
    );
  });
});
