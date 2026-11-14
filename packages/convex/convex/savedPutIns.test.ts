/**
 * The saved-put-in rule made exact (B01-3b): one function for the rollover and the Standing tab, two
 * bounded index reads, and an undecidable body kept. The fixture names every shape of stored rows and
 * counts the ones the old rule answered differently.
 */

import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { describe, expect, test } from 'vitest';
import type { Id } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import { isSuppressed } from './lib/putInSuppression';
import { SAVED_PUT_IN_HIDDEN_READ, SAVED_PUT_IN_VISIBLE_READ, savedPutInsOf } from './lib/standing';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const NOW = Date.now();
const square: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [-72.01, 43.99],
      [-71.99, 43.99],
      [-71.99, 44.01],
      [-72.01, 44.01],
      [-72.01, 43.99],
    ],
  ],
};

/** The rule before B01-3b: 25 rows of any status, `true` when they filled. */
async function oldRule(ctx: QueryCtx, waterBodyId: Id<'waterBodies'>): Promise<boolean> {
  const rows = await ctx.db
    .query('putIns')
    .withIndex('by_water_body', (q) => q.eq('waterBodyId', waterBodyId))
    .take(25);
  if (rows.length === 25) return true;
  const hidden = rows.filter((r) => r.status === 'hidden');
  return rows.some((r) => r.status === 'visible' && !isSuppressed(r.coord, hidden));
}

/** A launch `i` × 400 m east of the body's middle (well outside one another's hide radius). */
const at = (i: number) => ({ lat: 44, lng: -72 + i * 0.005 });

/** Each shape: its visible and hidden coordinates, and the exact answer. */
const SHAPES: Record<
  string,
  {
    visible: { lat: number; lng: number }[];
    hidden: { lat: number; lng: number }[];
    keeps: boolean;
    capped: boolean;
    saved: number;
  }
> = {
  none: { visible: [], hidden: [], keeps: false, capped: false, saved: 0 },
  oneLaunch: { visible: [at(0)], hidden: [], keeps: true, capped: false, saved: 1 },
  oneSuppressed: { visible: [at(0)], hidden: [at(0)], keeps: false, capped: false, saved: 0 },
  // Affected: the old read filled with hides and answered "a launch".
  manyHidesNoLaunch: {
    visible: [],
    hidden: Array.from({ length: 25 }, (_, i) => at(i)),
    keeps: false,
    capped: false,
    saved: 0,
  },
  // Affected: 24 launches at one hidden coordinate fill the old read.
  manyLaunchesAllHidden: {
    visible: Array.from({ length: 24 }, () => at(0)),
    hidden: [at(0)],
    keeps: false,
    capped: false,
    saved: 0,
  },
  // Undecidable: every launch read is suppressed, and more are unread — kept.
  launchesPastTheRead: {
    visible: Array.from({ length: SAVED_PUT_IN_VISIBLE_READ + 5 }, () => at(0)),
    hidden: [at(0)],
    keeps: true,
    capped: true,
    saved: 0,
  },
  // Undecidable: more hides than the read, any unread one might suppress the launch — kept.
  hidesPastTheRead: {
    visible: [at(-10)],
    hidden: Array.from({ length: SAVED_PUT_IN_HIDDEN_READ + 1 }, (_, i) => at(i)),
    keeps: true,
    capped: true,
    saved: 1,
  },
  launchBesideHides: {
    visible: [at(-10)],
    hidden: Array.from({ length: 24 }, (_, i) => at(i)),
    keeps: true,
    capped: false,
    saved: 1,
  },
  someSuppressed: {
    visible: [at(0), at(1), at(2)],
    hidden: [at(1)],
    keeps: true,
    capped: false,
    saved: 2,
  },
};

describe('savedPutInsOf', () => {
  test('every shape answered exactly, an undecidable one kept — and two shapes the old rule kept wrongly', async () => {
    const t = convexTest(schema, modules);
    const results = await t.run(async (ctx) => {
      const out: Record<string, { now: Awaited<ReturnType<typeof savedPutInsOf>>; old: boolean }> =
        {};
      for (const [name, shape] of Object.entries(SHAPES)) {
        const waterBodyId = await ctx.db.insert('waterBodies', {
          name,
          searchText: name,
          type: 'lakePond',
          source: 'osm',
          polygon: square,
          bbox: { minLat: 43.99, minLng: -72.01, maxLat: 44.01, maxLng: -71.99 },
          centroid: { lat: 44, lng: -72 },
          dedupStatus: 'clean',
          createdAt: NOW,
        });
        for (const [coords, status] of [
          [shape.visible, 'visible'],
          [shape.hidden, 'hidden'],
        ] as const) {
          for (const coord of coords) {
            await ctx.db.insert('putIns', {
              waterBodyId,
              coord,
              source: status === 'visible' ? 'osm' : 'derived',
              status,
              createdAt: NOW,
            });
          }
        }
        out[name] = {
          now: await savedPutInsOf(ctx, waterBodyId),
          old: await oldRule(ctx, waterBodyId),
        };
      }
      return out;
    });
    for (const [name, shape] of Object.entries(SHAPES)) {
      expect({ name, ...results[name]?.now }).toEqual({
        name,
        saved: shape.saved,
        capped: shape.capped,
        keeps: shape.keeps,
      });
    }
    const affected = Object.entries(results)
      .filter(([, r]) => r.old !== r.now.keeps)
      .map(([name]) => name);
    // The old rule answered "a launch" for both; neither has one. No shape moves the other way.
    expect(affected.sort()).toEqual(['manyHidesNoLaunch', 'manyLaunchesAllHidden']);
    // Both affected shapes move toward dormant, and only because they have no launch.
    for (const name of affected)
      expect(results[name]).toMatchObject({ old: true, now: { keeps: false, saved: 0 } });
  });
});
