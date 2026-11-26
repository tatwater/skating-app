import { readFileSync } from 'node:fs';
import {
  NAIP_OFF_SEASON_CELLS,
  NAIP_STATES,
  type NaipCatalogItem,
  type NaipManifest,
  type NaipState,
  workTileKey,
  workTilesOf,
} from '@skating/core';
import { describe, expect, test, vi } from 'vitest';
import type { CatalogSnapshot } from './catalog';
import type { ScoreTarget, ThumbnailScore } from './score';
import type { CloudCandidates } from './scoreSheet';
import { pickTable, runSelect, type SelectDeps, SelectRefusal } from './selectStage';
import { parseStageArgs } from './stages';

const ITEMS: NaipCatalogItem[] = readFileSync(
  new URL('./selectFixture.jsonl', import.meta.url),
  'utf8',
)
  .split('\n')
  .filter((l) => l !== '')
  .map((l) => {
    const { scoutsPick: _, ...c } = JSON.parse(l) as NaipCatalogItem & { scoutsPick?: true };
    return { ...c, thumbnail: `https://blob.example/${c.itemId}.200.jpg` };
  });

const perState = Object.fromEntries(
  NAIP_STATES.map((s) => [s, ITEMS.filter((i) => i.state === s).length]),
) as Record<NaipState, number>;

const GLARE = 'ny_m_4007326_nw_18_060_20240702';
const PARTIAL_CELL = '4407020se'; // an October cell: its pick is partial here, so its stack is read

function deps(over: Partial<SelectDeps> = {}) {
  const scored: string[][] = [];
  const written: { manifest?: NaipManifest; sheet?: CloudCandidates } = {};
  const lines: string[] = [];
  const run = { start: vi.fn(), count: vi.fn(), flush: vi.fn(), succeed: vi.fn(), failed: vi.fn() };
  const snapshot: CatalogSnapshot = {
    walkedOn: '2026-11-25',
    perState,
    pages: {},
    items: ITEMS,
    walked: true,
  };
  const base: SelectDeps = {
    walk: async (onState) => {
      for (const s of NAIP_STATES) onState(s, perState[s]);
      return snapshot;
    },
    score: async (targets: readonly ScoreTarget[]) => {
      scored.push(targets.map((t) => t.itemId));
      return new Map<string, ThumbnailScore | null>(
        targets.map((t) => {
          if (t.itemId === GLARE) return [t.itemId, { white: 0.39, valid: 1 }];
          if (
            t.itemId.includes(`_${PARTIAL_CELL.slice(0, 7)}_${PARTIAL_CELL.slice(7)}_`) &&
            t.itemId.includes('20231002')
          ) {
            return [t.itemId, { white: 0, valid: 0.6 }];
          }
          if (t.itemId.includes('_4107102_se_')) return [t.itemId, null];
          return [t.itemId, { white: 0.001, valid: 1 }];
        }),
      );
    },
    readCurrent: async () => {
      throw new Error('not asked');
    },
    readCellList: () => '',
    writeManifest: (m) => {
      written.manifest = m;
      return '/scratch/manifest.json';
    },
    writeSheet: (c) => {
      written.sheet = c;
      return '/scratch/report/cloud/index.html';
    },
    log: (l) => lines.push(l),
    run,
    now: () => new Date('2026-11-25T12:00:00Z'),
    ...over,
  };
  return { deps: base, scored, written, lines, run };
}

const args = (...rest: string[]) => parseStageArgs(['naip-20261125', ...rest], 'select');

describe('runSelect', () => {
  test('walks, selects, scores what shows, writes the manifest and the sheet, and closes the run', async () => {
    const d = deps();
    const out = await runSelect(args(), d.deps);
    expect(out.manifestPath).toBe('/scratch/manifest.json');
    expect(out.sheetPath).toBe('/scratch/report/cloud/index.html');
    expect(d.written.manifest).toBe(out.manifest);
    expect(out.manifest.catalog).toEqual({
      walkedOn: '2026-11-25',
      items: ITEMS.length,
      perState,
      archivedAt: 'naip/inventory/2026-11-25/',
    });
    // Every pick scored first; then the partial October cell's next frame; then the replacement of
    // the one glare candidate.
    expect(d.scored[0]).toHaveLength(out.manifest.cells.length);
    expect(d.scored.length).toBeGreaterThanOrEqual(3);
    expect(out.candidates.picks.map((c) => c.pick.itemId)).toEqual([GLARE]);
    const glareCell = out.manifest.cells.find((c) => c.key === '4007326nw');
    expect(d.scored.at(-1)).toEqual([glareCell?.stack[0]]);
    expect(out.manifest.cells.find((c) => c.key === PARTIAL_CELL)?.partial).toBe(true);
    expect(out.counts).toMatchObject({ cloudCandidates: 1, pickedOffSeason: 6, noCandidate: 0 });
    expect(out.counts.unscored).toBeGreaterThan(0);
    expect(d.run.start).toHaveBeenCalledOnce();
    expect(d.run.flush).toHaveBeenCalledTimes(7);
    expect(d.run.count).toHaveBeenCalledWith(
      'droppedOutsideState',
      ITEMS.filter((i) => i.state === 'ME' && i.year === 2025).length,
    );
    expect(d.run.succeed).toHaveBeenCalledWith([
      expect.stringMatching(/^\d+ cells, \d+ of \d+ work tiles to cut$/),
      '1 picks over the cloud threshold, for review',
    ]);
    expect(d.lines[0]).toBe(`[select] NY: ${perState.NY} items`);
  });

  test('a frame with no thumbnail, or one the scorer leaves out, is unscored; a state not walked is not counted', async () => {
    const bare = ITEMS.map(({ thumbnail: _, ...c }) => c as NaipCatalogItem);
    const targets: ScoreTarget[] = [];
    const d = deps({
      run: null,
      walk: async () => ({
        walkedOn: '2026-11-25',
        perState: { NY: 1 },
        pages: {},
        items: bare,
        walked: false,
      }),
      score: async (t) => {
        targets.push(...t);
        return new Map();
      },
    });
    const out = await runSelect(args('--dry-run'), d.deps);
    expect(targets.every((t) => t.thumbnail === null)).toBe(true);
    expect(out.counts.unscored).toBe(out.manifest.cells.length);
    expect(out.manifest.cells.every((c) => c.partial)).toBe(true);
    expect(out.manifest.catalog.perState).toEqual({ NY: 1 });
  });

  test('a dry run writes no row and archives nothing', async () => {
    const d = deps({ run: null });
    const out = await runSelect(args('--dry-run'), d.deps);
    expect(out.manifest.catalog.archivedAt).toBeNull();
  });

  test('refuses the off-season step past the committed list, failing the run', async () => {
    const d = deps({ offSeasonCells: NAIP_OFF_SEASON_CELLS.slice(1) });
    await expect(runSelect(args(), d.deps)).rejects.toThrow(
      /reached cells beyond the committed six: 4407028ne/,
    );
    expect(d.run.failed).toHaveBeenCalledWith(expect.any(SelectRefusal));
    expect(d.written.manifest).toBeUndefined();
  });

  test('refuses an exclusion list that leaves a cell with nothing', async () => {
    const only = ITEMS.filter((i) => i.key === '4606741se' && i.gsd <= 0.6);
    const d = deps({
      exclusions: only.map((i) => ({
        itemId: i.itemId,
        reason: 'cloud',
        reviewedBy: 'founder',
        reviewedOn: '2026-11-26',
      })),
    });
    await expect(runSelect(args(), d.deps)).rejects.toThrow(
      /leaves 1 cells with no frame: 4606741se/,
    );
  });

  test("refuses when the rule's invariants fail", async () => {
    const d = deps({ check: () => ({ holes: [], noCandidate: [], violations: ['x: broken'] }) });
    await expect(runSelect(args(), d.deps)).rejects.toThrow(
      /invariants fail on 1 cells: x: broken/,
    );
  });

  test('--cells narrows the build; a key off the grid or one no frame covers is refused', async () => {
    const d = deps({ readCellList: () => '# pilot\n4407028ne\n' });
    const out = await runSelect(
      parseStageArgs(['naip-pilot-20261125', '--pilot', 'rumford', '--cells', 'c.txt'], 'select'),
      d.deps,
    );
    expect(out.manifest.pilot).toBe('rumford');
    expect(out.manifest.workTiles.map((w) => w.key)).toEqual(
      workTilesOf('4407028ne').map(workTileKey),
    );
    await expect(
      runSelect(args('--cells', 'c.txt'), deps({ readCellList: () => '4407099ne\n' }).deps),
    ).rejects.toThrow(/not quarter-quads: 4407099ne/);
    await expect(
      runSelect(args('--cells', 'c.txt'), deps({ readCellList: () => '4407001nw\n' }).deps),
    ).rejects.toThrow(/cells no frame covers: 4407001nw/);
  });

  test('--states narrows to the cells those states list', async () => {
    const out = await runSelect(args('--states', 'RI'), deps().deps);
    const riCells = out.manifest.cells.filter((c) => c.states.includes('RI'));
    const tiles = new Set(riCells.flatMap((c) => c.workTiles));
    expect(out.manifest.workTiles.map((w) => w.key).sort()).toEqual([...tiles].sort());
  });

  test('--from-current builds against the current manifest', async () => {
    const first = await runSelect(args(), deps().deps);
    const current = {
      ...first.manifest,
      archive: { name: 'naip-summer-20261125.pmtiles', bytes: 1, sha256: 'x' },
    };
    const readCurrent = vi.fn(async () => current);
    const out = await runSelect(
      parseStageArgs(['naip-20270712', '--from-current'], 'select'),
      deps({ readCurrent }).deps,
    );
    expect(readCurrent).toHaveBeenCalledOnce();
    expect(out.manifest.basedOn?.archive).toBe('naip-summer-20261125.pmtiles');
    expect(out.manifest.workTiles.every((w) => !w.retile)).toBe(true);
  });
});

describe('pickTable', () => {
  test("§2.1's table: picks by labeled state, year and resolution, October cells named", async () => {
    const { manifest } = await runSelect(args('--dry-run'), deps({ run: null }).deps);
    const table = pickTable(manifest);
    expect(table).toContain('ME 2023 0.3 m (off-season, 2023-10-02): 6');
    const labels = table.map((line) => line.slice(0, line.lastIndexOf(': ')));
    expect(labels).toEqual([...labels].sort());
    const total = table.reduce((n, line) => n + Number(line.split(': ').at(-1)), 0);
    expect(total).toBe(manifest.cells.length);
  });
});
