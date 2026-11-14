/**
 * The `bodyGeo` jobs' failure and chaining paths (B01-3b): a computation that throws is recorded by
 * its class without stopping the run, a run past its time hands on to a fresh one, and the backfill
 * steps chain to the end. The geometry is made to throw through core's cell cover, the one call
 * every computation makes on its own box.
 */

import { ConvexError } from 'convex/values';
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { errorClassOf } from './bodyGeo';
import { markGeoStale } from './lib/bodyGeo';
import { rebuildBodyLibrary } from './lib/bodyLibrary';
import schema from './schema';

/** What the mocked cover does for a box west of a longitude: throw, or let five minutes pass. */
const hooks = vi.hoisted(() => ({
  throwWestOf: null as number | null,
  slowWestOf: null as number | null,
}));

vi.mock('@skating/core', async (importOriginal) => {
  const core = await importOriginal<typeof import('@skating/core')>();
  return {
    ...core,
    cellRangeCovering: (box: { minLng: number }, level: number) => {
      if (hooks.throwWestOf !== null && box.minLng < hooks.throwWestOf) {
        throw new TypeError('cover failed');
      }
      if (hooks.slowWestOf !== null && box.minLng < hooks.slowWestOf) {
        vi.setSystemTime(Date.now() + 5 * 60_000);
      }
      return core.cellRangeCovering(box as never, level);
    },
  };
});

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;
const NOW = Date.UTC(2027, 0, 15, 12);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  hooks.throwWestOf = null;
  hooks.slowWestOf = null;
});
afterEach(() => {
  vi.useRealTimers();
});

async function seedBody(t: T, name: string, lng: number): Promise<Id<'waterBodies'>> {
  return t.run(async (ctx) => {
    const r = 0.01;
    const id = await ctx.db.insert('waterBodies', {
      name,
      searchText: name,
      type: 'lakePond',
      source: 'osm',
      polygon: {
        type: 'Polygon',
        coordinates: [
          [
            [lng - r, 44 - r],
            [lng + r, 44 - r],
            [lng + r, 44 + r],
            [lng - r, 44 + r],
            [lng - r, 44 - r],
          ],
        ],
      },
      bbox: { minLng: lng - r, maxLng: lng + r, minLat: 44 - r, maxLat: 44 + r },
      centroid: { lat: 44, lng },
      states: ['VT'],
      dedupStatus: 'clean',
      createdAt: NOW,
    });
    await rebuildBodyLibrary(ctx, id);
    return id;
  });
}

const facts = (t: T, id: Id<'waterBodies'>) =>
  t.run((ctx) =>
    ctx.db
      .query('bodyGeoFacts')
      .withIndex('by_body', (q) => q.eq('waterBodyId', id))
      .first(),
  );

describe('errorClassOf', () => {
  test('a class only, never a message', () => {
    expect(errorClassOf(new ConvexError('a message'))).toBe('ConvexError');
    expect(errorClassOf(new RangeError('x'))).toBe('RangeError');
    const odd = new Error('x');
    odd.name = 'Not a class name!';
    expect(errorClassOf(odd)).toBe('Error');
    expect(errorClassOf('a string')).toBe('unknown');
  });
});

describe('computeDue', () => {
  test('a body whose computation throws is recorded by class; the rest are computed', async () => {
    const t = harness();
    const bad = await seedBody(t, 'Bad', -120);
    const good = await seedBody(t, 'Good', -72);
    await t.run((ctx) => markGeoStale(ctx, [bad, good]));
    hooks.throwWestOf = -100;
    // Tried once in the run, never again in it: one attempt, and the run ends.
    expect(await t.action(internal.bodyGeo.computeDue, {})).toMatchObject({
      computed: 1,
      failed: 1,
      done: true,
    });
    expect(await facts(t, bad)).toMatchObject({ attempts: 1, errorClass: 'TypeError' });
    expect((await facts(t, good))?.computedAt).toBe(NOW);
    // Two more runs park it; the daily retry tries it once and leaves it parked, re-stamped.
    await t.action(internal.bodyGeo.computeDue, {});
    await t.action(internal.bodyGeo.computeDue, {});
    expect(await facts(t, bad)).toMatchObject({ attempts: 3, parkedAt: NOW });
    expect(await t.action(internal.bodyGeo.computeDue, {})).toMatchObject({ failed: 0 });
    vi.setSystemTime(NOW + 86_400_000);
    expect(await t.action(internal.bodyGeo.computeDue, { parked: true })).toMatchObject({
      failed: 1,
      done: true,
    });
    expect(await facts(t, bad)).toMatchObject({
      attempts: 4,
      parkedAt: NOW + 86_400_000,
      retriedAt: NOW + 86_400_000,
    });
  });

  test('a run past its time hands on to a fresh run, which finishes', async () => {
    const t = harness();
    const ids = [await seedBody(t, 'Slow', -120), await seedBody(t, 'Other', -72)];
    await t.run((ctx) => markGeoStale(ctx, ids));
    hooks.slowWestOf = -100;
    expect(await t.action(internal.bodyGeo.computeAll, {})).toEqual({ started: true });
    await t.finishAllScheduledFunctions(() => {});
    for (const id of ids) expect((await facts(t, id))?.computedAt).toEqual(expect.any(Number));
  });
});

describe('seedAll', () => {
  test('pages the library to the end, chaining', async () => {
    const t = harness();
    // Past one page of 1,000 rows.
    for (let i = 0; i < 1_001; i++) await seedBody(t, `B${i}`, -72 + i * 0.001);
    expect(await t.mutation(internal.bodyGeo.seedAll, {})).toEqual({
      marked: 1_000,
      isDone: false,
    });
    await t.finishAllScheduledFunctions(() => {});
    const rows = await t.run((ctx) => ctx.db.query('bodyGeoFacts').collect());
    expect(rows).toHaveLength(1_001);
  });
});
