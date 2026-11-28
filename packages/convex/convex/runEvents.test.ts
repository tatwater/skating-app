/**
 * A run's log (D341, B01-8a): `runEvents.append` — the server's order, the line cap and its one
 * `cap` row, the kinds kept past it, the trim, the refused oversized append — and `importRuns.start`'s
 * new fields: the pass, its parent, the campaign object, and the `listedIn` it derives.
 */

import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { listedInOf, MAX_CAMPAIGN_FLAGS, MAX_CAMPAIGN_PLAN, MAX_CAMPAIGN_WORD } from './importRuns';
import {
  MAX_RUN_EVENT_APPEND,
  MAX_RUN_EVENT_TEXT,
  MAX_RUN_EVENTS,
  RUN_EVENT_CAP_TEXT,
  trimRunEventText,
} from './runEvents';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;

const start = (t: T, args: Record<string, unknown> = {}) =>
  t.mutation(internal.importRuns.start, {
    kind: 'canonical_water' as const,
    label: 'VT canonical water',
    deployment: 'dev:agile-bee-397',
    isProd: false,
    ...args,
  } as never) as Promise<Id<'importRuns'>>;

const getRun = (t: T, id: Id<'importRuns'>) =>
  t.run(async (ctx) => (await ctx.db.get(id)) as Doc<'importRuns'>);
const linesOf = (t: T, id: Id<'importRuns'>) =>
  t.run((ctx) =>
    ctx.db
      .query('runEvents')
      .withIndex('by_run_seq', (q) => q.eq('runId', id))
      .collect(),
  );

const lines = (n: number, kind: 'flush' | 'beat' | 'close' = 'flush', from = 0) =>
  Array.from({ length: n }, (_, i) => ({ kind, text: `line ${from + i}`, loggedAt: 1_000 + i }));

describe('runEvents.append', () => {
  test('lines take the server’s order, whatever the writer’s clock says', async () => {
    const t = convexTest(schema, modules);
    const runId = await start(t);
    await t.mutation(internal.runEvents.append, {
      runId,
      events: [
        { kind: 'start', text: 'Run started', loggedAt: 50 },
        { kind: 'stage', text: 'merge', loggedAt: 10 },
      ],
    });
    const answer = await t.mutation(internal.runEvents.append, {
      runId,
      events: [{ kind: 'flush', text: 'emitted=3', loggedAt: Number.NaN }],
    });
    expect(answer).toEqual({ stop: false, markedFailed: false, stored: 1, dropped: 0 });
    const stored = await linesOf(t, runId);
    expect(stored.map((l) => [l.seq, l.kind, l.loggedAt])).toEqual([
      [0, 'start', 50],
      [1, 'stage', 10],
      // A clock that isn't a number reads as the server's.
      [2, 'flush', stored[2]?.at],
    ]);
  });

  test('a long line is trimmed to the cap, never through a surrogate pair', async () => {
    const t = convexTest(schema, modules);
    const runId = await start(t);
    const emoji = `${'x'.repeat(MAX_RUN_EVENT_TEXT - 1)}❄️🧊`;
    await t.mutation(internal.runEvents.append, {
      runId,
      events: [{ kind: 'warn', text: 'y'.repeat(MAX_RUN_EVENT_TEXT + 40), loggedAt: 0 }],
    });
    const [line] = await linesOf(t, runId);
    expect(line?.text).toHaveLength(MAX_RUN_EVENT_TEXT);
    const cut = trimRunEventText(`${'x'.repeat(MAX_RUN_EVENT_TEXT - 1)}🧊`);
    expect(cut).toBe('x'.repeat(MAX_RUN_EVENT_TEXT - 1));
    expect(trimRunEventText(emoji)).toHaveLength(MAX_RUN_EVENT_TEXT);
    expect(trimRunEventText('short')).toBe('short');
  });

  test(`refuses more than ${MAX_RUN_EVENT_APPEND} lines in one append, writing none`, async () => {
    const t = convexTest(schema, modules);
    const runId = await start(t);
    await expect(
      t.mutation(internal.runEvents.append, { runId, events: lines(MAX_RUN_EVENT_APPEND + 1) }),
    ).rejects.toThrow(`At most ${MAX_RUN_EVENT_APPEND} log lines`);
    expect(await linesOf(t, runId)).toEqual([]);
    const ok = await t.mutation(internal.runEvents.append, {
      runId,
      events: lines(MAX_RUN_EVENT_APPEND),
    });
    expect(ok.stored).toBe(MAX_RUN_EVENT_APPEND);
  });

  test('refuses a run that does not exist', async () => {
    const t = convexTest(schema, modules);
    const runId = await start(t);
    await t.run((ctx) => ctx.db.delete(runId));
    await expect(
      t.mutation(internal.runEvents.append, { runId, events: lines(1) }),
    ).rejects.toThrow('not found');
  });

  test('the cap: one cap row counts every ordinary line past it; closes are kept', async () => {
    const t = convexTest(schema, modules);
    const runId = await start(t);
    // Up to one short of the cap, in full appends.
    for (let from = 0; from < MAX_RUN_EVENTS - 10; from += MAX_RUN_EVENT_APPEND) {
      const n = Math.min(MAX_RUN_EVENT_APPEND, MAX_RUN_EVENTS - 10 - from);
      await t.mutation(internal.runEvents.append, { runId, events: lines(n, 'flush', from) });
    }
    // An append that crosses it: 10 fit, then the cap row, then 15 dropped and one close kept.
    const crossing = await t.mutation(internal.runEvents.append, {
      runId,
      events: [...lines(25, 'beat'), { kind: 'close', text: 'Succeeded', loggedAt: 9 }],
    });
    expect(crossing).toMatchObject({ stored: 11, dropped: 15 });
    // Past it: ordinary lines only counted, a close kept.
    const after = await t.mutation(internal.runEvents.append, {
      runId,
      events: [...lines(4, 'flush'), { kind: 'close', text: 'Failed: late', loggedAt: 9 }],
    });
    expect(after).toMatchObject({ stored: 1, dropped: 4 });

    const stored = await linesOf(t, runId);
    const cap = stored.filter((l) => l.kind === 'cap');
    expect(cap).toHaveLength(1);
    expect(cap[0]).toMatchObject({ seq: MAX_RUN_EVENTS, dropped: 19, text: RUN_EVENT_CAP_TEXT });
    expect(stored.filter((l) => l.kind !== 'close' && l.kind !== 'cap')).toHaveLength(
      MAX_RUN_EVENTS,
    );
    expect(stored.slice(-2).map((l) => [l.seq, l.kind, l.text])).toEqual([
      [MAX_RUN_EVENTS + 1, 'close', 'Succeeded'],
      [MAX_RUN_EVENTS + 2, 'close', 'Failed: late'],
    ]);
    // `seq` stays dense and unique.
    expect(stored.map((l) => l.seq)).toEqual(stored.map((_, i) => i));
  });

  test('the cap row is made by the first line past the cap, a kept one included', async () => {
    const t = convexTest(schema, modules);
    const runId = await start(t);
    await t.run(async (ctx) => {
      for (let seq = 0; seq < MAX_RUN_EVENTS; seq++) {
        await ctx.db.insert('runEvents', {
          runId,
          seq,
          at: 0,
          loggedAt: 0,
          kind: 'flush',
          text: '',
        });
      }
    });
    const answer = await t.mutation(internal.runEvents.append, {
      runId,
      events: [{ kind: 'close', text: 'Succeeded', loggedAt: 0 }],
    });
    expect(answer).toMatchObject({ stored: 1, dropped: 0 });
    const tail = (await linesOf(t, runId)).slice(-2);
    expect(tail.map((l) => [l.seq, l.kind, l.dropped])).toEqual([
      [MAX_RUN_EVENTS, 'cap', 0],
      [MAX_RUN_EVENTS + 1, 'close', undefined],
    ]);
  });
});

describe('importRuns.start, widened (D341)', () => {
  test('a corpus run with no parent lists under Corpus; another kind lists nowhere yet', async () => {
    const t = convexTest(schema, modules);
    expect((await getRun(t, await start(t))).listedIn).toBe('corpus');
    expect((await getRun(t, await start(t, { kind: 'lake_depth' }))).listedIn).toBeUndefined();
    expect(listedInOf('corpus_campaign', undefined)).toBe('corpus');
    // The summer aerial's stages (B05) have no page yet.
    expect((await getRun(t, await start(t, { kind: 'aerial_tiles' }))).listedIn).toBeUndefined();
    for (const kind of ['aerial_select', 'aerial_tiles', 'aerial_assemble']) {
      expect(listedInOf(kind, undefined)).toBeUndefined();
    }
  });

  test("a campaign's pass keeps its parent and pass name, and leaves the list", async () => {
    const t = convexTest(schema, modules);
    const campaign = await start(t, {
      kind: 'corpus_campaign',
      label: 'Corpus campaign c1',
      campaignId: 'c1',
      campaign: {
        flags: ['--skip-landmarks'],
        plan: [
          { pass: 'merge', by: 'script' },
          { pass: 'landmarks', by: 'script', skipped: '--skip-landmarks' },
          { pass: 'prune-floor', by: 'hand' },
        ],
      },
    });
    const row = await getRun(t, campaign);
    expect(row.listedIn).toBe('corpus');
    expect(row.campaign?.plan).toHaveLength(3);
    const pass = await start(t, { parentRunId: campaign, campaignPass: 'merge', campaignId: 'c1' });
    expect(await getRun(t, pass)).toMatchObject({ parentRunId: campaign, campaignPass: 'merge' });
    expect((await getRun(t, pass)).listedIn).toBeUndefined();
  });

  test('a parent that is gone or is no campaign is dropped: the pass lists on its own', async () => {
    const t = convexTest(schema, modules);
    const notACampaign = await start(t);
    const pass = await start(t, { parentRunId: notACampaign });
    expect((await getRun(t, pass)).parentRunId).toBeUndefined();
    expect((await getRun(t, pass)).listedIn).toBe('corpus');
    const gone = await start(t, { kind: 'corpus_campaign' });
    await t.run((ctx) => ctx.db.delete(gone));
    const orphan = await start(t, { parentRunId: gone });
    expect((await getRun(t, orphan)).parentRunId).toBeUndefined();
  });

  test('refuses a campaign object on another kind, and one past its bounds', async () => {
    const t = convexTest(schema, modules);
    const campaign = { flags: [], plan: [] };
    await expect(start(t, { campaign })).rejects.toThrow('Only a corpus campaign row');
    const kind = 'corpus_campaign';
    await expect(
      start(t, { kind, campaign: { flags: Array(MAX_CAMPAIGN_FLAGS + 1).fill('-x'), plan: [] } }),
    ).rejects.toThrow('flags');
    await expect(
      start(t, {
        kind,
        campaign: {
          flags: [],
          plan: Array(MAX_CAMPAIGN_PLAN + 1).fill({ pass: 'load', by: 'script' }),
        },
      }),
    ).rejects.toThrow('passes');
    await expect(
      start(t, { kind, campaign: { flags: ['x'.repeat(MAX_CAMPAIGN_WORD + 1)], plan: [] } }),
    ).rejects.toThrow('characters');
    await expect(start(t, { campaignPass: 'x'.repeat(MAX_CAMPAIGN_WORD + 1) })).rejects.toThrow(
      'characters',
    );
  });
});

describe('importRuns.finish, widened (D341)', () => {
  test("a campaign's close lands on the object it opened with", async () => {
    const t = convexTest(schema, modules);
    const runId = await start(t, {
      kind: 'corpus_campaign',
      campaign: { flags: ['--states=VT'], plan: [{ pass: 'load', by: 'script' }] },
    });
    await t.mutation(internal.importRuns.finish, {
      runId,
      status: 'failed',
      error: 'Stopped at load (exit 1)',
      campaign: { exitCode: 1, lastPass: 'load' },
    });
    expect((await getRun(t, runId)).campaign).toEqual({
      flags: ['--states=VT'],
      plan: [{ pass: 'load', by: 'script' }],
      exitCode: 1,
      lastPass: 'load',
    });
  });

  test('a close with no campaign object to land on writes no invented plan', async () => {
    const t = convexTest(schema, modules);
    const runId = await start(t, { kind: 'corpus_campaign' });
    await t.mutation(internal.importRuns.finish, {
      runId,
      status: 'succeeded',
      campaign: { exitCode: 0 },
    });
    expect((await getRun(t, runId)).campaign).toBeUndefined();
    await expect(
      t.mutation(internal.importRuns.finish, {
        runId,
        status: 'succeeded',
        campaign: { exitCode: 0, lastPass: 'x'.repeat(MAX_CAMPAIGN_WORD + 1) },
      }),
    ).rejects.toThrow('characters');
  });
});
