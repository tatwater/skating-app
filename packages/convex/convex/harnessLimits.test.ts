/**
 * **The harness enforces the real backend's one-paginated-query rule** (`vitest.config.ts`,
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
