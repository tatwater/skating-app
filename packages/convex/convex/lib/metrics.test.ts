/**
 * `metricSnapshots` write helpers (Phase 7b). The invariants worth pinning are the ones the whole
 * analytics surface rests on: a counter bump is **additive** (so concurrent event sites can't clobber
 * each other), a rollup write is **idempotent** (so the daily cron and the backfill can re-run over
 * the same day and land on the same number), and neither ever throws on a bad key — analytics hangs
 * off user-facing paths and must never be the reason a bounty create fails.
 */
import geospatial from '@convex-dev/geospatial/test';
import { metricDay } from '@skating/core';
import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import schema from '../schema';
import { bumpMetricCounter, bumpMetricMetaCounter, writeMetricSnapshot } from './metrics';

const modules = import.meta.glob('../**/*.*s');

function harness() {
  const t = convexTest(schema, modules);
  geospatial.register(t);
  geospatial.register(t, 'adminAreasGeo');
  return t;
}

const rows = (t: ReturnType<typeof harness>, metric: string) =>
  t.run((ctx) =>
    ctx.db
      .query('metricSnapshots')
      .withIndex('by_metric_date', (q) => q.eq('metric', metric))
      .collect(),
  );

describe('bumpMetricCounter', () => {
  test('creates the day row on the first bump and accumulates after', async () => {
    const t = harness();
    await t.run(async (ctx) => {
      await bumpMetricCounter(ctx, 'contradiction_detected');
      await bumpMetricCounter(ctx, 'contradiction_detected', 3);
    });
    const found = await rows(t, 'contradiction_detected');
    expect(found).toHaveLength(1);
    expect(found[0]?.scalar).toBe(4);
    expect(found[0]?.date).toBe(metricDay(Date.now()));
  });

  test('keeps separate UTC days in separate rows', async () => {
    const t = harness();
    const day = 24 * 60 * 60 * 1000;
    const now = Date.now();
    await t.run(async (ctx) => {
      await bumpMetricCounter(ctx, 'report_rejected_future_skate', 1, now);
      await bumpMetricCounter(ctx, 'report_rejected_future_skate', 1, now - day);
    });
    const found = await rows(t, 'report_rejected_future_skate');
    expect(found).toHaveLength(2);
    expect(new Set(found.map((r) => r.date))).toEqual(
      new Set([metricDay(now), metricDay(now - day)]),
    );
  });

  test('a zero delta writes nothing — an unmeasured day must read as a generated zero, not a row', async () => {
    const t = harness();
    await t.run((ctx) => bumpMetricCounter(ctx, 'report_rejected_future_skate', 0));
    expect(await rows(t, 'report_rejected_future_skate')).toHaveLength(0);
  });

  test('drops an unknown key instead of throwing on the caller’s hot path', async () => {
    const t = harness();
    await expect(
      t.run((ctx) => bumpMetricCounter(ctx, 'not_a_metric' as 'report_rejected_future_skate')),
    ).resolves.not.toThrow();
    expect(await rows(t, 'not_a_metric')).toHaveLength(0);
  });
});

describe('bumpMetricMetaCounter', () => {
  test('accumulates per key without disturbing its siblings', async () => {
    const t = harness();
    await t.run(async (ctx) => {
      await bumpMetricMetaCounter(ctx, 'flag_dispositions', 'spam:actioned');
      await bumpMetricMetaCounter(ctx, 'flag_dispositions', 'spam:actioned');
      await bumpMetricMetaCounter(ctx, 'flag_dispositions', 'spam:dismissed', 5);
    });
    const found = await rows(t, 'flag_dispositions');
    expect(found).toHaveLength(1);
    expect(found[0]?.meta).toEqual({ 'spam:actioned': 2, 'spam:dismissed': 5 });
  });
});

describe('writeMetricSnapshot', () => {
  test('is idempotent for a day — a re-run overwrites rather than doubling', async () => {
    const t = harness();
    const date = '2026-01-15';
    await t.run(async (ctx) => {
      await writeMetricSnapshot(ctx, 'reports_created', date, { scalar: 7 });
      await writeMetricSnapshot(ctx, 'reports_created', date, { scalar: 7 });
    });
    const found = await rows(t, 'reports_created');
    expect(found).toHaveLength(1);
    expect(found[0]?.scalar).toBe(7);
  });

  test('replaces the row, so a payload the rollup no longer produces cannot linger', async () => {
    const t = harness();
    const date = '2026-01-15';
    await t.run(async (ctx) => {
      await writeMetricSnapshot(ctx, 'bounty_outcomes', date, { meta: { open: 2 }, scalar: 2 });
      await writeMetricSnapshot(ctx, 'bounty_outcomes', date, { meta: { open: 1 } });
    });
    const found = await rows(t, 'bounty_outcomes');
    expect(found[0]?.meta).toEqual({ open: 1 });
    expect(found[0]?.scalar).toBeUndefined();
  });

  test('stores a bucket array verbatim', async () => {
    const t = harness();
    await t.run((ctx) =>
      writeMetricSnapshot(ctx, 'bounty_time_to_fulfillment_h', '2026-01-15', {
        buckets: [1, 0, 4, 2, 0, 0, 0, 0],
      }),
    );
    const found = await rows(t, 'bounty_time_to_fulfillment_h');
    expect(found[0]?.buckets).toEqual([1, 0, 4, 2, 0, 0, 0, 0]);
  });
});
