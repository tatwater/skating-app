/**
 * How long the capped texts are (the founder's ruling, 2026-11-14): recorded at each write as a length
 * and a band, folded into a day's `text_lengths` snapshot, and read over a season for the screen beside
 * each cap. Counts only.
 */
import { metricDay } from '@skating/core';
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import { rollupTextLengthsDay, TEXT_LENGTH_EVENT_KEEP_DAYS } from './analyticsRollup';
import { recordTextLength } from './lib/textLengths';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 14, 15);
const TODAY = metricDay(NOW);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

async function seedUser(t: T, subject: string, role: 'member' | 'moderator' | 'admin' = 'member') {
  const id = await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: subject,
      username: subject,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: {
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
        moderatorDecision: false,
      },
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role,
      status: 'active' as const,
      createdAt: NOW - 400 * DAY,
    }),
  );
  return { id, as: t.withIdentity({ subject }) };
}

const events = (t: T) => t.run((ctx) => ctx.db.query('textLengthEvents').collect());
const snapshot = (t: T, date: string) =>
  t.run((ctx) =>
    ctx.db
      .query('metricSnapshots')
      .withIndex('by_metric_date', (q) => q.eq('metric', 'text_lengths').eq('date', date))
      .unique(),
  );

describe('recording a length at the write', () => {
  test('a flag records its note; a repeat flag, which writes nothing, records nothing', async () => {
    const t = harness();
    const flagger = await seedUser(t, 'flagger');
    const target = await seedUser(t, 'target');
    const args = { targetType: 'user' as const, targetId: target.id, reason: 'spam' as const };
    await flagger.as.mutation(api.contentFlags.flag, { ...args, note: 'n'.repeat(995) });
    await flagger.as.mutation(api.contentFlags.flag, { ...args, note: 'again' });
    expect((await events(t)).map((r) => [r.kind, r.length, r.band, r.cap])).toEqual([
      ['flag_note', 995, 'to99', 1_000],
    ]);
  });

  test('a flag note past the cap is refused in plain words and records nothing', async () => {
    const t = harness();
    const flagger = await seedUser(t, 'flagger');
    const target = await seedUser(t, 'target');
    await expect(
      flagger.as.mutation(api.contentFlags.flag, {
        targetType: 'user',
        targetId: target.id,
        reason: 'spam',
        note: 'n'.repeat(1_001),
      }),
    ).rejects.toThrow('The note is 1,001 characters. Shorten it to 1,000 or fewer.');
    expect(await events(t)).toEqual([]);
  });

  test('a photo records its caption, an absent one as empty; one past the cap is refused', async () => {
    const t = harness();
    const uploader = await seedUser(t, 'uploader');
    const blobs = async () => ({
      storageId: await t.run((ctx) => ctx.storage.store(new Blob(['full']))),
      thumbStorageId: await t.run((ctx) => ctx.storage.store(new Blob(['thumb']))),
      placeOnMap: false,
    });
    await uploader.as.mutation(api.photos.create, { ...(await blobs()), caption: 'c'.repeat(500) });
    await uploader.as.mutation(api.photos.create, await blobs());
    await expect(
      uploader.as.mutation(api.photos.create, { ...(await blobs()), caption: 'c'.repeat(501) }),
    ).rejects.toThrow('The caption is 501 characters. Shorten it to 500 or fewer.');
    expect((await events(t)).map((r) => [r.kind, r.length, r.band])).toEqual([
      ['photo_caption', 500, 'atCap'],
      ['photo_caption', 0, 'empty'],
    ]);
  });
});

describe('the day fold', () => {
  async function record(t: T, kind: 'report_notes' | 'flag_note', lengths: number[], at = NOW) {
    await t.run(async (ctx) => {
      for (const n of lengths) await recordTextLength(ctx, kind, 'x'.repeat(n), at);
    });
  }

  test('folds a day per kind: bands, longest, writes and the cap; a kind with none is a measured zero', async () => {
    const t = harness();
    await record(t, 'report_notes', [0, 1_000, 4_999, 5_000]);
    await record(t, 'flag_note', [10]);
    await t.mutation(internal.analyticsRollup.rollupTextLengthsDayJob, { date: TODAY });
    const meta = (await snapshot(t, TODAY))?.meta as Record<string, unknown>;
    expect(meta.report_notes).toEqual({
      bands: { empty: 1, to25: 1, to50: 0, to75: 0, to90: 0, to99: 1, atCap: 1 },
      longest: 5_000,
      writes: 4,
      cap: 5_000,
    });
    expect(meta.photo_caption).toMatchObject({ writes: 0, longest: 0, cap: 500 });
    expect(meta.flag_note).toMatchObject({ writes: 1, longest: 10 });
  });

  test('a kind whose read hits its cap is not recorded; the other kinds still save', async () => {
    const t = harness();
    await record(t, 'report_notes', [1, 2, 3]);
    await record(t, 'flag_note', [5]);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await t.run((ctx) => rollupTextLengthsDay(ctx, TODAY, 2));
    vi.mocked(console.warn).mockRestore();
    const meta = (await snapshot(t, TODAY))?.meta as Record<string, unknown>;
    expect(meta.report_notes).toBeNull();
    expect(meta.flag_note).toMatchObject({ writes: 1 });
  });

  test('forward-only: a day before the record began, or past the events kept, is never written', async () => {
    const t = harness();
    // Before any event exists, nothing is written for today.
    await t.mutation(internal.analyticsRollup.rollupTextLengthsDayJob, { date: TODAY });
    expect(await snapshot(t, TODAY)).toBeNull();
    await record(t, 'flag_note', [5]);
    const yesterday = metricDay(NOW - DAY);
    await t.mutation(internal.analyticsRollup.rollupTextLengthsDayJob, { date: yesterday });
    expect(await snapshot(t, yesterday)).toBeNull();
    // A day older than the events are kept could only ever read as none: left alone.
    const old = metricDay(NOW - (TEXT_LENGTH_EVENT_KEEP_DAYS + 1) * DAY);
    await t.mutation(internal.analyticsRollup.rollupTextLengthsDayJob, { date: old });
    expect(await snapshot(t, old)).toBeNull();
  });

  test('after a quiet week the prune leaves no event, and a quiet day is still a measured zero', async () => {
    const t = harness();
    const then = NOW - (TEXT_LENGTH_EVENT_KEEP_DAYS + 2) * DAY;
    vi.setSystemTime(then);
    await record(t, 'flag_note', [5], then);
    // That day was folded while its event was kept; then a week passed with nothing written.
    await t.mutation(internal.analyticsRollup.rollupTextLengthsDayJob, { date: metricDay(then) });
    vi.setSystemTime(NOW);
    await t.mutation(internal.analyticsRollup.pruneTextLengthEvents, {});
    expect(await events(t)).toEqual([]);
    await t.mutation(internal.analyticsRollup.rollupTextLengthsDayJob, { date: TODAY });
    const meta = (await snapshot(t, TODAY))?.meta as Record<string, unknown> | undefined;
    expect(meta?.flag_note).toMatchObject({ writes: 0, longest: 0 });
  });

  test('the pulse day job starts the fold, so the tick and the backfill both reach it', async () => {
    const t = harness();
    await record(t, 'flag_note', [5]);
    await t.mutation(internal.analyticsRollup.rollupPulseDayJob, { date: TODAY });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const meta = (await snapshot(t, TODAY))?.meta as Record<string, unknown> | undefined;
    expect(meta?.flag_note).toMatchObject({ writes: 1 });
  });

  test('the prune drops events past the week and keeps the rest', async () => {
    const t = harness();
    await record(t, 'flag_note', [1], NOW - (TEXT_LENGTH_EVENT_KEEP_DAYS + 2) * DAY);
    await record(t, 'flag_note', [2], NOW - DAY);
    const result = await t.mutation(internal.analyticsRollup.pruneTextLengthEvents, {});
    expect(result.deleted).toBe(1);
    expect((await events(t)).map((r) => r.length)).toEqual([2]);
  });
});

describe('metrics.textLengths — the season, for the screen beside each cap', () => {
  test('per kind: the days aligned with the window, a day nothing recorded is null, and the season says what it misses', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    await t.run(async (ctx) => {
      await recordTextLength(ctx, 'report_notes', 'x'.repeat(4_900), NOW - DAY);
      await recordTextLength(ctx, 'report_notes', 'x'.repeat(100), NOW);
    });
    await t.mutation(internal.analyticsRollup.rollupTextLengthsDayJob, {
      date: metricDay(NOW - DAY),
    });
    await t.mutation(internal.analyticsRollup.rollupTextLengthsDayJob, { date: TODAY });

    const read = await mod.as.query(api.metrics.textLengths, {});
    expect(read.opensOn).toBe('2026-10-01');
    const notes = read.kinds.report_notes;
    expect(notes.cap).toBe(5_000);
    expect(notes.daily).toHaveLength(read.days.length);
    expect(notes.daily[0]).toBeNull();
    expect(notes.daily.at(-1)).toMatchObject({ writes: 1, longest: 100 });
    expect(notes.season).toMatchObject({ writes: 2, longest: 4_900 });
    expect(notes.season?.bands.to99).toBe(1);
    expect(notes.notRecordedDays).toBe(read.days.length - 2);
  });

  test('nothing recorded in the window is null, never zero', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const read = await mod.as.query(api.metrics.textLengths, {});
    expect(read.kinds.flag_note.season).toBeNull();
    expect(read.kinds.flag_note.daily.every((d) => d === null)).toBe(true);
  });

  test('a member is refused', async () => {
    const t = harness();
    const member = await seedUser(t, 'member');
    await expect(member.as.query(api.metrics.textLengths, {})).rejects.toThrow();
  });
});
