/**
 * **Every body's short list of names is its live landmarks and bays, after any history** (B01-3u).
 * For any sequence of landmark writes (a moderator's create, edit, removal and restore, a catalog
 * load, an undo), bay writes (create, rename, delist, restore — each retiring the landmarks a bay
 * names), a corpus spelling filed, and a body merge, each body's `bodyNameLists` row equals the
 * lists its live rows make, read here from the raw tables. And History's answer to a landmark edit's
 * undo from that list never offers what the whole rule (where one landmark is in view) refuses: a
 * duplicate is said word for word; a bay that answers to a name sends the reader to the landmark.
 *
 * Pinned histories, pinned seeds plus one random seed, logged. The backfill builds the same rows.
 */
import { convexTest } from 'convex-test';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { undoStates } from './lib/undo';
import { UNDO_BAY_NAME_ON_LANDMARK } from './lib/undoHandlersBody';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const T0 = Date.UTC(2026, 10, 19, 12);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

const NOTIF_PREFS = {
  activityDetected: true,
  bountyRequest: true,
  hazardConfirmation: true,
  bountyAnswered: true,
  reportRated: true,
  reportCommented: true,
  contentFlagResolved: true,
  favoriteReport: true,
  nearbyReportDigest: false,
  greatReportNearby: false,
};

function ring(minLng: number, minLat: number, maxLng: number, maxLat: number) {
  return [
    [minLng, minLat],
    [maxLng, minLat],
    [maxLng, maxLat],
    [minLng, maxLat],
    [minLng, minLat],
  ];
}
const LAKE = { type: 'Polygon' as const, coordinates: [ring(-73.5, 44.0, -72.5, 45.0)] };
/** Bay slots, and landmark points in and far from them. */
const BAY = (k: number) => ring(-73.4 + 0.2 * k, 44.1, -73.3 + 0.2 * k, 44.2);
const POINTS = [
  { lat: 44.15, lng: -73.35 },
  { lat: 44.15, lng: -73.15 },
  { lat: 44.9, lng: -73.4 },
  { lat: 44.9, lng: -73.39995 },
];
const NAMES = ['Mud Bay', 'Long Point', 'Apple Island', 'The Gut'];

async function world() {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    await ctx.db.insert('profiles', {
      clerkUserId: 'matt',
      displayName: 'matt',
      username: 'matt',
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: NOTIF_PREFS,
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role: 'admin' as const,
      status: 'active' as const,
      createdAt: T0,
    });
  });
  const body = (name: string) =>
    t.run((ctx) =>
      ctx.db.insert('waterBodies', {
        name,
        searchText: name,
        type: 'lakePond' as const,
        source: 'osm' as const,
        polygon: LAKE,
        bbox: { minLat: 44.0, minLng: -73.5, maxLat: 45.0, maxLng: -72.5 },
        centroid: { lat: 44.5, lng: -73.0 },
        surfaceAreaSqM: 8.7e9,
        dedupStatus: 'clean' as const,
        createdAt: T0,
      }),
    );
  const bodies = [await body('Lake Champlain'), await body('Champlain (dup)')];
  return { t, bodies, mod: t.withIdentity({ subject: 'matt' }), merged: false };
}
type W = Awaited<ReturnType<typeof world>>;

type Op =
  | { op: 'create'; b: number; name: number; alias: number | null; point: number }
  | { op: 'edit'; i: number; name: number; alias: number | null; point: number | null }
  | { op: 'remove' | 'restore'; i: number }
  | { op: 'bay'; b: number; name: number; slot: number }
  | { op: 'renameBay'; i: number; name: number }
  | { op: 'delistBay' | 'restoreBay'; i: number }
  | { op: 'load'; b: number; name: number; point: number }
  | { op: 'undo' }
  | { op: 'merge' };

const nameArb = fc.nat(NAMES.length - 1);
const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      op: fc.constant('create' as const),
      b: fc.nat(1),
      name: nameArb,
      alias: fc.option(nameArb, { nil: null }),
      point: fc.nat(POINTS.length - 1),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      op: fc.constant('edit' as const),
      i: fc.nat(9),
      name: nameArb,
      alias: fc.option(nameArb, { nil: null }),
      point: fc.option(fc.nat(POINTS.length - 1), { nil: null }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      op: fc.constantFrom('remove' as const, 'restore' as const),
      i: fc.nat(9),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      op: fc.constant('bay' as const),
      b: fc.nat(1),
      name: nameArb,
      slot: fc.nat(2),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({ op: fc.constant('renameBay' as const), i: fc.nat(5), name: nameArb }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      op: fc.constantFrom('delistBay' as const, 'restoreBay' as const),
      i: fc.nat(5),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      op: fc.constant('load' as const),
      b: fc.nat(1),
      name: nameArb,
      point: fc.nat(POINTS.length - 1),
    }),
  },
  { weight: 2, arbitrary: fc.constant<Op>({ op: 'undo' }) },
  { weight: 1, arbitrary: fc.constant<Op>({ op: 'merge' }) },
);

/** A query's view of a test's context: the undo engine reads as History does, never as a write. */
function asQuery(ctx: MutationCtx): QueryCtx {
  const db = {
    get: ctx.db.get.bind(ctx.db),
    query: ctx.db.query.bind(ctx.db),
    normalizeId: ctx.db.normalizeId.bind(ctx.db),
    system: ctx.db.system,
  };
  return { ...ctx, db } as unknown as QueryCtx;
}

async function attempt(p: Promise<unknown>): Promise<void> {
  try {
    await p;
  } catch {
    // Refused (a clash, a cap, nothing to do): the history goes on.
  }
}

const nth = async <T extends 'bodyLandmarks' | 'waterBodySubAreas'>(w: W, table: T, i: number) =>
  w.t.run(async (ctx) => {
    const rows = await ctx.db.query(table).collect();
    return rows.length === 0 ? null : (rows[i % rows.length] as Doc<T>);
  });

async function step(w: W, op: Op): Promise<void> {
  vi.advanceTimersByTime(1_000);
  switch (op.op) {
    case 'create':
      await attempt(
        w.mod.mutation(api.landmarks.create, {
          waterBodyId: w.bodies[op.b] as Id<'waterBodies'>,
          name: NAMES[op.name] as string,
          kind: op.point < 2 ? 'other' : 'point',
          point: POINTS[op.point] as { lat: number; lng: number },
          ...(op.alias !== null ? { aliases: [NAMES[op.alias] as string] } : {}),
        }),
      );
      break;
    case 'edit': {
      const row = await nth(w, 'bodyLandmarks', op.i);
      if (row)
        await attempt(
          w.mod.mutation(api.landmarks.update, {
            landmarkId: row._id,
            name: NAMES[op.name] as string,
            aliases: op.alias !== null ? [NAMES[op.alias] as string] : [],
            ...(op.point !== null ? { point: POINTS[op.point] } : {}),
          }),
        );
      break;
    }
    case 'remove':
    case 'restore': {
      const row = await nth(w, 'bodyLandmarks', op.i);
      if (row)
        await attempt(
          w.mod.mutation(op.op === 'remove' ? api.landmarks.remove : api.landmarks.restore, {
            landmarkId: row._id,
          }),
        );
      break;
    }
    case 'bay':
      await attempt(
        w.mod.mutation(api.subAreas.create, {
          waterBodyId: w.bodies[op.b] as Id<'waterBodies'>,
          name: NAMES[op.name] as string,
          polygon: { type: 'Polygon', coordinates: [BAY(op.slot)] },
        }),
      );
      break;
    case 'renameBay': {
      const bay = await nth(w, 'waterBodySubAreas', op.i);
      if (bay)
        await attempt(
          w.mod.mutation(api.subAreas.rename, { subAreaId: bay._id, name: NAMES[op.name] }),
        );
      break;
    }
    case 'delistBay':
    case 'restoreBay': {
      const bay = await nth(w, 'waterBodySubAreas', op.i);
      if (bay)
        await attempt(
          w.mod.mutation(op.op === 'delistBay' ? api.subAreas.remove : api.subAreas.restore, {
            subAreaId: bay._id,
          }),
        );
      break;
    }
    case 'load':
      await attempt(
        w.t.mutation(internal.landmarks.importBatch, {
          bodies: [
            {
              waterBodyId: w.bodies[op.b] as Id<'waterBodies'>,
              landmarks: [
                {
                  name: NAMES[op.name] as string,
                  kind: 'island',
                  point: POINTS[op.point] as { lat: number; lng: number },
                  source: 'osm',
                  externalIds: [`osm:node/${op.name}${op.point}`],
                  aliases: [],
                },
              ],
            },
          ],
          dryRun: false,
        }),
      );
      break;
    case 'undo': {
      const newest = await w.t.run((ctx) =>
        ctx.db
          .query('moderationActions')
          .order('desc')
          .collect()
          .then((rows) =>
            rows.find(
              (r) => r.targetType === 'bodyLandmark' || r.targetType === 'waterBodySubArea',
            ),
          ),
      );
      if (newest) await attempt(w.mod.mutation(api.undo.run, { actionId: newest._id }));
      break;
    }
    case 'merge':
      if (!w.merged) {
        await attempt(
          w.mod.mutation(api.waterBodies.merge, {
            survivorId: w.bodies[0] as Id<'waterBodies'>,
            loserId: w.bodies[1] as Id<'waterBodies'>,
          }),
        );
        w.merged = true;
      }
      break;
  }
  await w.t.finishAllScheduledFunctions(vi.runAllTimers);
}

/** Each body's row is the lists its live rows make, from the raw tables. */
async function rowsHold(w: W) {
  await w.t.run(async (ctx) => {
    for (const waterBodyId of w.bodies) {
      const landmarks = (await ctx.db.query('bodyLandmarks').collect()).filter(
        (r) => r.waterBodyId === waterBodyId && r.removedAt === undefined,
      );
      const bays = (await ctx.db.query('waterBodySubAreas').collect()).filter(
        (b) => b.waterBodyId === waterBodyId && b.removedAt === undefined,
      );
      const row = await ctx.db
        .query('bodyNameLists')
        .withIndex('by_body', (q) => q.eq('waterBodyId', waterBodyId))
        .first();
      const byId = <E extends { id: string }>(list: E[]) =>
        [...list].sort((a, b) => a.id.localeCompare(b.id));
      const want = {
        capped: false,
        landmarks: byId(
          landmarks.map((r) => ({
            id: r._id as string,
            kind: r.kind,
            point: { lat: r.point.lat, lng: r.point.lng },
            names: [r.name, ...r.aliases],
          })),
        ),
        bays: byId(
          bays.map((b) => ({ id: b._id as string, names: [b.name, ...(b.aliases ?? [])] })),
        ),
      };
      if (row === null) {
        // Never written: nothing a writer touched is on this body.
        expect(want.landmarks.length + want.bays.length, 'a body with names has its row').toBe(0);
        continue;
      }
      expect({
        capped: row.capped,
        landmarks: byId(row.landmarks as { id: string }[]),
        bays: byId(row.bays as { id: string }[]),
      }).toEqual(want);
    }
  });
}

/** History's list answer for every landmark edit, against the answer where one landmark is in view. */
async function answersAgree(w: W) {
  await w.t.run(async (ctx) => {
    const viewer = (await ctx.db.query('profiles').first()) as Doc<'profiles'>;
    const edits = (await ctx.db.query('moderationActions').collect()).filter(
      (r) => r.action === 'edit_landmark',
    );
    if (edits.length === 0) return;
    const list = await undoStates(asQuery(ctx), viewer, edits, 'list');
    for (const [i, row] of edits.entries()) {
      const [one] = await undoStates(asQuery(ctx), viewer, [row], 'one');
      const l = list[i];
      if (l?.state === 'available') {
        expect(one, 'a list never offers what the landmark refuses').toMatchObject({
          state: 'available',
        });
      } else if (l?.state === 'unavailable' && l.why !== UNDO_BAY_NAME_ON_LANDMARK) {
        expect(one, 'one rule, one answer').toEqual(l);
      }
    }
  });
}

async function history(ops: Op[]): Promise<void> {
  vi.setSystemTime(T0);
  const w = await world();
  for (const op of ops) {
    await step(w, op);
    await rowsHold(w);
  }
  await answersAgree(w);
  // The backfill over rows the writers kept writes nothing.
  const pass = await w.t.mutation(internal.landmarks.backfillBodyNames, { chain: false });
  const bays = await w.t.mutation(internal.landmarks.backfillBodyNames, {
    phase: 'bays',
    chain: false,
  });
  expect(pass.wrote + bays.wrote, 'the backfill finds nothing to write').toBe(0);
}

const PINNED: Op[][] = [
  // A landmark, then a bay of the same name over it: the landmark retires, the bay joins.
  [
    { op: 'create', b: 0, name: 0, alias: null, point: 0 },
    { op: 'bay', b: 0, name: 0, slot: 0 },
    { op: 'undo' },
  ],
  // An edit, then its undo with another landmark in the way: the list says the clash.
  [
    { op: 'create', b: 0, name: 1, alias: null, point: 2 },
    { op: 'edit', i: 0, name: 2, alias: null, point: null },
    { op: 'create', b: 0, name: 1, alias: null, point: 3 },
  ],
  // An edit whose old name a bay now answers to: the list sends the reader to the landmark.
  [
    { op: 'create', b: 0, name: 3, alias: null, point: 2 },
    { op: 'edit', i: 0, name: 1, alias: null, point: null },
    { op: 'bay', b: 0, name: 3, slot: 2 },
  ],
  // A bay renamed to a landmark's name: the landmark retires, off the list with it.
  [
    { op: 'create', b: 0, name: 3, alias: null, point: 0 },
    { op: 'bay', b: 0, name: 1, slot: 0 },
    { op: 'renameBay', i: 0, name: 3 },
  ],
  // Both bodies named, then merged; a catalog load and a delisted bay restored.
  [
    { op: 'create', b: 1, name: 2, alias: 1, point: 3 },
    { op: 'bay', b: 1, name: 0, slot: 1 },
    { op: 'load', b: 0, name: 3, point: 2 },
    { op: 'merge' },
    { op: 'delistBay', i: 0 },
    { op: 'restoreBay', i: 0 },
    { op: 'renameBay', i: 0, name: 1 },
  ],
];

describe('a body’s short list of names over any history (B01-3u)', () => {
  test.each(PINNED.map((ops, i): [number, Op[]] => [i, ops]))('pinned history %i', (_, ops) =>
    history(ops),
  );
  test.each([3, 20261119, Math.floor(Math.random() * 2 ** 31)])('seed %i', async (seed) => {
    console.log(`bodyNameRows seed ${seed}`);
    await fc.assert(fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 9 }), history), {
      seed,
      numRuns: 4,
    });
  });
});

describe('the list on History', () => {
  test('pinned: an undo blocked by a duplicate is said from the list; by a bay, sent to the landmark', async () => {
    const w = await world();
    for (const op of PINNED[1] as Op[]) await step(w, op);
    const states = await w.t.run(async (ctx) => {
      const viewer = (await ctx.db.query('profiles').first()) as Doc<'profiles'>;
      const edits = (await ctx.db.query('moderationActions').collect()).filter(
        (r) => r.action === 'edit_landmark',
      );
      return undoStates(asQuery(ctx), viewer, edits, 'list');
    });
    expect(states).toEqual([
      {
        state: 'unavailable',
        why: '"Long Point" is already a landmark here, so this undo can’t bring the old name back.',
      },
    ]);
    const w2 = await world();
    for (const op of PINNED[2] as Op[]) await step(w2, op);
    const bayStates = await w2.t.run(async (ctx) => {
      const viewer = (await ctx.db.query('profiles').first()) as Doc<'profiles'>;
      const edits = (await ctx.db.query('moderationActions').collect()).filter(
        (r) => r.action === 'edit_landmark',
      );
      return undoStates(asQuery(ctx), viewer, edits, 'list');
    });
    expect(bayStates).toEqual([{ state: 'unavailable', why: UNDO_BAY_NAME_ON_LANDMARK }]);
  });

  test('a body whose list isn’t built yet answers as before: the spellings only', async () => {
    const w = await world();
    for (const op of PINNED[1] as Op[]) await step(w, op);
    await w.t.run(async (ctx) => {
      for (const row of await ctx.db.query('bodyNameLists').collect()) await ctx.db.delete(row._id);
    });
    const states = await w.t.run(async (ctx) => {
      const viewer = (await ctx.db.query('profiles').first()) as Doc<'profiles'>;
      const edits = (await ctx.db.query('moderationActions').collect()).filter(
        (r) => r.action === 'edit_landmark',
      );
      return undoStates(asQuery(ctx), viewer, edits, 'list');
    });
    expect(states[0]).toMatchObject({ state: 'available' });
  });

  test('the backfill builds every named body’s row, a few bodies a pass', async () => {
    const w = await world();
    for (const op of PINNED[4] as Op[]) await step(w, op);
    const before = await w.t.run((ctx) => ctx.db.query('bodyNameLists').collect());
    await w.t.run(async (ctx) => {
      for (const row of before) await ctx.db.delete(row._id);
    });
    await w.t.mutation(internal.landmarks.backfillBodyNames, {});
    await w.t.finishAllScheduledFunctions(vi.runAllTimers);
    const after = await w.t.run((ctx) => ctx.db.query('bodyNameLists').collect());
    // A body left with no names (the merge's loser) keeps an empty row the backfill never visits.
    const strip = (rows: Doc<'bodyNameLists'>[]) =>
      rows
        .filter((r) => r.landmarks.length + r.bays.length > 0)
        .map(({ waterBodyId, capped, landmarks, bays }) => ({
          waterBodyId,
          capped,
          landmarks,
          bays,
        }))
        .sort((a, b) => a.waterBodyId.localeCompare(b.waterBodyId));
    expect(strip(after)).toEqual(strip(before));
    await rowsHold(w);
  });
});
