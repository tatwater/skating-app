/**
 * **The harness enforces the real backend's limits** (`vitest.config.ts`): every transaction runs
 * under Convex's default per-transaction limits (documents and bytes read and written, index ranges,
 * functions scheduled), which `convex-test` leaves off unless asked; and its one-paginated-query rule
 * (`vitest.config.ts`,
 * `singlePaginatePerMutation`): a mutation that calls `.paginate()` twice in one execution throws, as
 * Convex's `queryPage` syscall refuses it ("This query or mutation function ran multiple paginated
 * queries") — and each execution, a nested one too, counts on its own.
 */

import { convexTest } from 'convex-test';
import { expect, test } from 'vitest';
import { internal } from './_generated/api';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

test('a mutation paginating twice throws; once is fine; each execution counts alone', async () => {
  const t = convexTest(schema, modules);
  await expect(
    t.run(async (ctx) => {
      await ctx.db.query('inboxItems').paginate({ cursor: null, numItems: 1 });
      await ctx.db.query('inboxCounts').paginate({ cursor: null, numItems: 1 });
    }),
  ).rejects.toThrow(/Only a single paginated query/);
  for (let i = 0; i < 2; i++) {
    await t.run((ctx) => ctx.db.query('inboxItems').paginate({ cursor: null, numItems: 1 }));
  }
});

test('a nested call counts on its own, as the backend gives each execution its own journal', async () => {
  const t = convexTest(schema, modules);
  // The caller pages once, and the backfill it calls pages once of its own: both stand.
  await t.run(async (ctx) => {
    await ctx.db.query('inboxItems').paginate({ cursor: null, numItems: 1 });
    await ctx.runMutation(internal.inboxItems.backfill, {});
  });
});

test('every transaction runs under Convex’s own limits: index ranges past 4,096 throw', async () => {
  const t = convexTest(schema, modules);
  const id = await t.run((ctx) => ctx.db.insert('inboxCounts', { key: 'k', count: 0 }));
  await t.run(async (ctx) => {
    for (let i = 0; i < 4_000; i++) await ctx.db.get(id);
  });
  await expect(
    t.run(async (ctx) => {
      for (let i = 0; i < 4_097; i++) await ctx.db.get(id);
    }),
  ).rejects.toThrow(/index ranges|limit: 4096/);
});

test('an array past Convex’s 8,192 items is refused, as the backend refuses it, wherever it is a value', async () => {
  const t = convexTest(schema, modules);
  const items = (n: number) => Array.from({ length: n }, (_, i) => `k${i}`);
  // A document at the cap stands; one item more is refused — inserted, patched, nested at any depth.
  const row = {
    action: 'hide' as const,
    targetType: 'report' as const,
    targetId: 'r',
    reason: 'x',
  };
  const metadata = (n: number) => ({ keys: items(n) });
  const id = await t.run((ctx) =>
    ctx.db.insert('moderationActions', { ...row, metadata: metadata(8_192), createdAt: 0 }),
  );
  await expect(
    t.run((ctx) =>
      ctx.db.insert('moderationActions', { ...row, metadata: metadata(8_193), createdAt: 0 }),
    ),
  ).rejects.toThrow(/Array length is too long \(8193 > maximum length 8192\)/);
  await expect(
    t.run((ctx) => ctx.db.patch(id, { metadata: { deep: [{ keys: items(8_193) }] } })),
  ).rejects.toThrow(/Array length is too long/);
  await expect(
    t.run((ctx) => ctx.db.replace(id, { ...row, metadata: metadata(8_193), createdAt: 0 })),
  ).rejects.toThrow(/Array length is too long/);
  // A registered function's arguments are a value too (checked before its own validator).
  await expect(
    t.mutation(internal.inboxItems.backfill, { pad: items(8_193) } as never),
  ).rejects.toThrow(/Array length is too long/);
  // And a scheduled function's arguments are stored (in a harness of their own: a throw inside the
  // scheduler leaves its transaction unusable).
  await expect(
    convexTest(schema, modules).run((ctx) =>
      ctx.scheduler.runAfter(0, internal.inboxItems.backfill, { pad: items(8_193) } as never),
    ),
  ).rejects.toThrow(/Array length is too long/);
});
