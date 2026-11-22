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
import type { Id } from './_generated/dataModel';
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
  // Distinct ranges (an empty index range each): 4,000 stand, 4,097 throw.
  type Ctx = Parameters<Parameters<typeof t.run>[0]>[0];
  const first = (ctx: Ctx, i: number) =>
    ctx.db
      .query('inboxCounts')
      .withIndex('by_key', (q) => q.eq('key', `k${i}`))
      .first();
  await t.run(async (ctx) => {
    for (let i = 0; i < 4_000; i++) await first(ctx, i);
  });
  await expect(
    t.run(async (ctx) => {
      for (let i = 0; i < 4_097; i++) await first(ctx, i);
    }),
  ).rejects.toThrow(/index ranges|limit: 4096/);
  // 5x its time when every package's suite runs at once (108 s there; 4.8 s alone).
}, 600_000);

/**
 * **Each operation costs what the real backend charges** (`vitest.config.ts`, `realBackendCounts`):
 * measured on a local backend, 100 of each in one transaction, its own `getTransactionMetrics`.
 */
test('the harness charges each operation as the real backend does (index ranges, documents read and written)', async () => {
  const t = convexTest(schema, modules);
  const seed = () =>
    t.run(async (ctx) => {
      const ids = [];
      for (let i = 0; i < 100; i++) {
        ids.push(await ctx.db.insert('inboxCounts', { key: `s${Math.random()}`, count: i }));
      }
      return ids;
    });
  type Ctx = Parameters<Parameters<typeof t.run>[0]>[0];
  const measure = async (op: (ctx: Ctx, ids: Id<'inboxCounts'>[]) => Promise<unknown>) => {
    const ids = await seed();
    return t.run(async (ctx) => {
      const used = async () => {
        const m = await ctx.meta.getTransactionMetrics();
        return [m.databaseQueries.used, m.documentsRead.used, m.documentsWritten.used] as const;
      };
      const [q0, r0, w0] = await used();
      await op(ctx, ids);
      const [q1, r1, w1] = await used();
      return { ranges: q1 - q0, read: r1 - r0, written: w1 - w0 };
    });
  };
  const byKey = (ctx: Ctx, key: string) =>
    ctx.db.query('inboxCounts').withIndex('by_key', (q) => q.eq('key', key));
  // [operation, the real backend's own counts]
  const table: [string, (ctx: Ctx, ids: Id<'inboxCounts'>[]) => Promise<unknown>, object][] = [
    [
      'get',
      async (c, ids) => {
        for (const id of ids) await c.db.get(id);
      },
      { ranges: 100, read: 100, written: 0 },
    ],
    [
      'patch',
      async (c, ids) => {
        for (const id of ids) await c.db.patch(id, { count: 7 });
      },
      { ranges: 100, read: 100, written: 99 },
    ],
    [
      'replace',
      async (c, ids) => {
        for (const id of ids) await c.db.replace(id, { key: `r${id}`, count: 1 });
      },
      { ranges: 100, read: 100, written: 100 },
    ],
    [
      'delete',
      async (c, ids) => {
        for (const id of ids) await c.db.delete(id);
      },
      { ranges: 100, read: 100, written: 100 },
    ],
    [
      'insert',
      async (c) => {
        for (let i = 0; i < 100; i++) await c.db.insert('inboxCounts', { key: `i${i}`, count: 0 });
      },
      { ranges: 0, read: 0, written: 100 },
    ],
    [
      'get then patch, a row',
      async (c, ids) => {
        for (const id of ids) {
          await c.db.get(id);
          await c.db.patch(id, { count: 9 });
        }
      },
      { ranges: 100, read: 200, written: 99 },
    ],
    [
      'patch twice, a row',
      async (c, ids) => {
        for (const id of ids) {
          await c.db.patch(id, { count: -1 });
          await c.db.patch(id, { count: -2 });
        }
      },
      { ranges: 100, read: 200, written: 200 },
    ],
    [
      'first, 100 distinct empty ranges',
      async (c) => {
        for (let i = 0; i < 100; i++) await byKey(c, `none${i}`).first();
      },
      { ranges: 100, read: 0, written: 0 },
    ],
    [
      'take(10), the same range 100 times',
      async (c) => {
        for (let i = 0; i < 100; i++) await c.db.query('inboxCounts').take(10);
      },
      { ranges: 1, read: 1_000, written: 0 },
    ],
    [
      'first on overlapping ranges',
      async (c) => {
        for (let i = 0; i < 100; i++)
          await c.db
            .query('inboxCounts')
            .withIndex('by_key', (q) => q.gt('key', `g${i}`))
            .first();
      },
      { ranges: 1, read: 100, written: 0 },
    ],
    [
      'a whole index, then 100 ranges inside it',
      async (c, ids) => {
        const all = await c.db.query('inboxCounts').withIndex('by_key').collect();
        for (const d of all.filter((x) => ids.includes(x._id))) await byKey(c, d.key).first();
      },
      { ranges: 1 },
    ],
  ];
  for (const [name, op, real] of table) {
    expect(await measure(op), name).toMatchObject(real);
  }
  // A filter's rejected rows are read: every row scanned, kept or not.
  const scanned = await measure(async (c) =>
    c.db
      .query('inboxCounts')
      .filter((q) => q.eq(q.field('count'), -99))
      .first(),
  );
  const rows = await t.run(async (c) => (await c.db.query('inboxCounts').collect()).length);
  expect(scanned).toMatchObject({ ranges: 1, read: rows });
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
