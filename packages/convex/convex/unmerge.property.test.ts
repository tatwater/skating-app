/**
 * **The unmerge, as a property** (B01-5d): over random small corpora — the survivor, the drawing and a
 * partner as fixed rectangles, a random set of the kinds of row a merge moves on them (a favorite of
 * both bodies, a twin landmark and a clashing bay among them), and a random number of extra reports —
 * a merge, optionally an edit between the merge and the unmerge, then the unmerge:
 *
 * - with no edit, or one that touches nothing the merge recorded, the state equals the state before
 *   (the round trip's census, the same exclusions; an unrelated row stays as the edit left it);
 * - with an edit to a row the merge recorded, that row is left as the edit left it, and the unmerge
 *   says so — exactly that row, counted and named — while every other row is back as before.
 *
 * The merge is the real one (`unmerge.test.ts`' `mergeV2`: S4a's merge, which writes the `version: 2`
 * change set itself). Runs: `UNMERGE_PROPERTY_RUNS` a seed (default 4), over `UNMERGE_PROPERTY_SEEDS` seeds
 * (default 1) — the build ran it at 20 seeds of 100.
 */

import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import type { Id } from './_generated/dataModel';
import { queueLibraryRefresh } from './lib/bodyLibrary';
import { recomputeBodySummary } from './lib/bodySummary';
import { scheduleRestamp } from './subAreas';
import type { LeftKind } from './unmerge';
import {
  census,
  KINDS,
  type Kind,
  leftOf,
  mergeV2,
  settle,
  unmerge,
  type World,
  world,
} from './unmerge.test';

const RUNS = Number(process.env.UNMERGE_PROPERTY_RUNS ?? 4);
const SEEDS = Number(process.env.UNMERGE_PROPERTY_SEEDS ?? 1);

/** An edit between the merge and the unmerge: what it needs, what it does, what it leaves. */
interface Edit {
  needs: Kind | null;
  /**
   * Makes the edit; returns the row it changed and, if it changed a field the merge wrote, that row's
   * kind (it is left). An edit only to fields the merge didn't write names them in `keeps`: the row
   * goes back, and stands as before but for exactly those fields, as the edit wrote them (D291).
   */
  apply: (w: World) => Promise<{
    table: string;
    id: string;
    left: LeftKind | null;
    keeps?: Record<string, unknown>;
  }>;
}

const EDITS: Record<string, Edit> = {
  moveReport: {
    needs: 'content',
    apply: async (w) => {
      const id = w.rows.reports?.[0] as Id<'reports'>;
      await w.t.run((ctx) => ctx.db.patch(id, { waterBodyId: w.elsewhere }));
      return { table: 'reports', id, left: 'reports' };
    },
  },
  // A name the merge never writes (it moves a bay, or delists a clashing copy): the bay goes back to
  // the drawing with its new name, and nothing is left.
  renameBay: {
    needs: 'loserBays',
    apply: async (w) => {
      const id = w.rows.loserBays?.[0] as Id<'waterBodySubAreas'>;
      const keeps = { name: 'Renamed Cove', updatedAt: Date.now() + 1_000 };
      await w.t.run((ctx) => ctx.db.patch(id, keeps));
      return { table: 'waterBodySubAreas', id, left: null, keeps };
    },
  },
  declineAsk: {
    needs: 'asks',
    apply: async (w) => {
      const id = w.rows.requests?.[0] as Id<'waterBodyRequests'>;
      await w.t.run((ctx) =>
        ctx.db.patch(id, { status: 'declined', decidedAt: Date.now() + 1_000 }),
      );
      return { table: 'waterBodyRequests', id, left: 'waterBodyRequests' };
    },
  },
  reflagPartner: {
    needs: 'partners',
    apply: async (w) => {
      await w.t.run((ctx) =>
        ctx.db.patch(w.partner, { duplicateCandidateIds: [w.elsewhere, w.survivor] }),
      );
      return { table: 'waterBodies', id: w.partner, left: 'partners' };
    },
  },
  unrelatedReport: {
    needs: null,
    apply: async (w) => {
      const id = await w.t.run((ctx) =>
        ctx.db.insert('reports', {
          authorId: w.skater.id,
          waterBodyId: w.survivor,
          point: { lat: 0.5, lng: 0.2 },
          skateEndTime: Date.now(),
          reportTime: Date.now(),
          source: 'native',
          iceTypes: [],
          surfaceTags: [],
          photoIds: [],
          moderationStatus: 'visible',
          hazardIdsCreated: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
      );
      return { table: 'reports', id, left: null };
    },
  },
};

/**
 * The rows themselves, by table — what an edit's comparison reads (derived facts follow the edit, so
 * they're compared only when nothing was edited). A body is compared on what the merge and the
 * unmerge write to it, not its recomputed summary.
 */
const PRIMARY = [
  'reports',
  'hazards',
  'bounties',
  'bodyFeatures',
  'putIns',
  'waterBodyFavorites',
  'waterBodyRequests',
  'corpusPlaceNames',
  'contentFlags',
  'waterBodySubAreas',
  'bodyLandmarks',
  'gpsActivities',
  'waterBodies',
] as const;
const BODY_FIELDS = [
  '_id',
  'name',
  'dedupStatus',
  'duplicateCandidateIds',
  'mergedIntoId',
  'reviewStatus',
  'moderatorTownKeys',
  'moderatorAliases',
  'referenceLinks',
  'searchText',
];

/**
 * A row's bay stamps (`subAreaId`, `subAreaIds`, `leftSubArea`, and the names the feed card carries,
 * `subAreaName`, `subAreaNames`): derived by the restamp from the bays the body holds, so a bay left
 * on the survivor, or renamed, takes the stamps of the rows inside it with it — the edit's
 * consequence, not a row the unmerge failed to put back. Left out of the before/after comparison, and
 * held instead by {@link stampsNameTheirBays}: whatever they are, they name the bays as they stand.
 */
const STAMPS = new Set(['subAreaId', 'subAreaIds', 'leftSubArea', 'subAreaName', 'subAreaNames']);

/** Every stamped row's names are its bays' names as they stand (a rename's stamps followed it). */
function stampsNameTheirBays(all: Record<string, unknown[]>): string[] {
  const names = new Map(
    (all.waterBodySubAreas ?? []).map((b) => {
      const bay = b as { _id: string; name: string };
      return [bay._id, bay.name];
    }),
  );
  const holes: string[] = [];
  for (const [table, rows] of Object.entries(all)) {
    for (const r of rows) {
      const row = r as {
        _id?: string;
        subAreaId?: string;
        subAreaName?: string;
        subAreaIds?: string[];
        subAreaNames?: string[];
      };
      if (row.subAreaId !== undefined && 'subAreaName' in row) {
        if (row.subAreaName !== names.get(row.subAreaId)) holes.push(`${table} ${row._id}: label`);
      }
      if (row.subAreaIds !== undefined && row.subAreaNames !== undefined) {
        const want = row.subAreaIds.map((id) => names.get(id));
        if (JSON.stringify(row.subAreaNames) !== JSON.stringify(want))
          holes.push(`${table} ${row._id}: members`);
      }
    }
  }
  return holes;
}

function primaryOf(all: Record<string, unknown[]>, except: ReadonlySet<string>) {
  const out: Record<string, unknown[]> = {};
  const unstamped = (r: unknown) =>
    Object.fromEntries(
      Object.entries(r as Record<string, unknown>).filter(([k]) => !STAMPS.has(k)),
    );
  for (const table of PRIMARY) {
    out[table] = (all[table] ?? [])
      .filter((r) => !except.has((r as { _id?: string })._id ?? ''))
      .map(unstamped)
      .map((r) =>
        table === 'waterBodies'
          ? Object.fromEntries(
              Object.entries(r as Record<string, unknown>).filter(([k]) => BODY_FIELDS.includes(k)),
            )
          : r,
      );
  }
  return out;
}

const scenario = fc.record({
  kinds: fc.subarray([...KINDS], { minLength: 1 }),
  extraReports: fc.integer({ min: 0, max: 3 }),
  edit: fc.option(fc.constantFrom(...Object.keys(EDITS)), { nil: null }),
});

async function check(s: typeof scenario extends fc.Arbitrary<infer S> ? S : never): Promise<void> {
  const edit = s.edit !== null ? EDITS[s.edit] : undefined;
  // An edit needs its kind of row: add it to the corpus, so every drawn edit runs.
  const kinds = edit?.needs && !s.kinds.includes(edit.needs) ? [...s.kinds, edit.needs] : s.kinds;
  const w = await world(kinds);
  if (s.extraReports > 0) {
    await w.t.run(async (ctx) => {
      for (let i = 0; i < s.extraReports; i++) {
        await ctx.db.insert('reports', {
          authorId: w.skater.id,
          waterBodyId: w.loser,
          point: { lat: 0.4, lng: 0.6 + i * 0.05 },
          skateEndTime: Date.now() - i,
          reportTime: Date.now(),
          source: 'native',
          iceTypes: [],
          surfaceTags: [],
          photoIds: [],
          moderationStatus: 'visible',
          hazardIdsCreated: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
      // Their facts kept by the paths that keep them, as a report's own write would.
      await recomputeBodySummary(ctx, w.loser);
      await queueLibraryRefresh(ctx, [w.loser]);
      await scheduleRestamp(ctx, w.loser);
    });
    await settle(w.t);
  }
  const before = await census(w.t);
  const mergeId = await mergeV2(w);
  const edited = edit ? await edit.apply(w) : null;
  if (edited) await settle(w.t);
  await unmerge(w, mergeId);
  const after = await census(w.t);
  const left = await leftOf(w.t, w.loser);
  if (!edited) {
    expect(left.count).toBe(0);
    expect(after).toEqual(before);
    return;
  }
  // Every other row is back as it stood.
  const except = new Set([edited.id]);
  expect(primaryOf(after, except)).toEqual(primaryOf(before, except));
  expect(stampsNameTheirBays(after)).toEqual([]);
  if (edited.keeps) {
    // Back, as before but for exactly what the edit wrote.
    const rowOf = (all: Record<string, unknown[]>) =>
      primaryOf({ [edited.table]: all[edited.table] ?? [] }, new Set())[edited.table]?.find(
        (r) => (r as { _id: string })._id === edited.id,
      );
    // (The census reads no timestamps, so a kept `updatedAt` is asked of the row itself below.)
    const was = rowOf(before) as Record<string, unknown>;
    const kept = Object.fromEntries(Object.entries(edited.keeps).filter(([k]) => k in was));
    expect(rowOf(after)).toEqual({ ...was, ...kept });
    const row = await w.t.run((ctx) =>
      ctx.db.get(ctx.db.normalizeId(edited.table as 'waterBodySubAreas', edited.id) as never),
    );
    expect(row).toMatchObject(edited.keeps);
  }
  if (edited.left === null) {
    expect(left.count).toBe(0);
  } else {
    // Exactly the edited row is left, counted and named.
    expect(left.byKind).toEqual({ [edited.left]: 1 });
    expect(left.rows).toEqual([{ kind: edited.left, id: edited.id }]);
  }
}

describe('a merge, an optional edit, the unmerge: the state comes back, or the edit is said left', () => {
  for (let seed = 0; seed < SEEDS; seed++) {
    test(`seed ${seed}`, async () => {
      await fc.assert(fc.asyncProperty(scenario, check), {
        numRuns: RUNS,
        seed: 0x5eed + seed,
        endOnFailure: true,
      });
    }, 120_000);
  }
});

/**
 * Pinned from the hot run (every seed at 50×, shrunk): a drawing's bay renamed between the merge and
 * the unmerge, with a report inside it. The rename is a field the merge never wrote, so the bay goes
 * back to the drawing under its new name and nothing is left — and the report's bay stamps name it
 * as renamed, since the restamp derives them from the bay.
 */
test('pinned: a bay renamed between the merge and the unmerge goes back renamed, its stamps with it', () =>
  check({ kinds: ['favoritesBoth', 'landmarks'], extraReports: 1, edit: 'renameBay' }));
