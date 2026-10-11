import { tileSurveyKey } from '@skating/core';
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { emptyMarkerKey, POLL_CAP, slotOf } from './imageryLive';
import { unreadableRetryMs } from './lib/imageryPump';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

/**
 * Live imagery (A06i §5, D214): poll → pump → index, single-flight, against a stubbed catalog,
 * bucket and Fly API.
 */

type T = ReturnType<typeof convexTest>;
const SEASON = 'winter-2026-27';
const ARCHIVE = 'https://imagery.example.com';
const ENDPOINT = 'https://acct.r2.cloudflarestorage.com';

const ENV = {
  IMAGERY_ARCHIVE_URL: ARCHIVE,
  R2_ACCESS_KEY_ID: 'id',
  R2_SECRET_ACCESS_KEY: 'secret',
  R2_ENDPOINT: ENDPOINT,
  FLY_API_TOKEN: 'tok',
  FLY_IMAGE: 'registry.fly.io/skating-imagery:deployment-1',
};

const s2 = (tile: string, date: string, version = 0, platform = 'S2C') =>
  `${platform}_${tile}_${date}_${version}_L2A`;
const s1 = (start: string) => `S1A_IW_GRDH_1SDV_${start}_${start.slice(0, 9)}235959_05A1B2_06C3D4`;

const feature = (id: string, datetime: string, extra: Record<string, unknown> = {}) => ({
  id,
  properties: { datetime, ...extra },
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [-72, 44],
        [-71, 44],
        [-71, 45],
        [-72, 44],
      ],
    ],
  },
});

interface World {
  s2: ReturnType<typeof feature>[];
  s1: ReturnType<typeof feature>[];
  sidecar: unknown;
  plan: unknown;
  manifests: Map<string, unknown>;
  latest: unknown;
  machines: { id: string; name: string; state: string }[];
  machineDetail: Map<string, unknown>;
  spawnFails: Set<string>;
  failStac?: boolean;
  puts: Map<string, unknown>;
  spawned: string[];
}

function world(overrides: Partial<World> = {}): World {
  return {
    s2: [],
    s1: [],
    sidecar: { season: SEASON, bodies: 24831, waterMasks: true },
    plan: {
      season: SEASON,
      surveyKey: tileSurveyKey(SEASON, 24831),
      bbox: [-75, 42, -67, 47],
      emptyTiles: ['18TZZ'],
    },
    manifests: new Map(),
    latest: { season: 'winter-2025-26' },
    machines: [],
    machineDetail: new Map(),
    spawnFails: new Set(),
    puts: new Map(),
    spawned: [],
    ...overrides,
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** A stand-in ETag: any change to the stored content changes it. */
const etag = (value: unknown) => {
  let h = 0;
  for (const c of JSON.stringify(value) ?? '') h = (h * 31 + c.charCodeAt(0)) | 0;
  return (h >>> 0).toString(16);
};

function stub(w: World) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: Request | string, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const url = new URL(req.url);
      if (url.host === 'earth-search.aws.element84.com') {
        if (w.failStac) return new Response('', { status: 502, statusText: 'Bad Gateway' });
        const body = JSON.parse(await req.text()) as { collections: string[] };
        return json({
          features: body.collections[0] === 'sentinel-2-l2a' ? w.s2 : w.s1,
          links: [],
        });
      }
      if (req.url.startsWith(ARCHIVE)) {
        const key = url.pathname.slice(1);
        const found =
          key === `masks/${SEASON}.json`
            ? w.sidecar
            : key === `masks/${SEASON}-search.json`
              ? w.plan
              : key === 'index/latest.json'
                ? w.latest
                : w.manifests.get(key);
        if (found === 'error') return new Response('', { status: 500, statusText: 'Err' });
        if (found === undefined || found === null) return new Response('', { status: 404 });
        return req.method === 'HEAD' ? new Response(null) : json(found);
      }
      if (req.url.startsWith(ENDPOINT)) {
        if (req.method === 'PUT') {
          w.puts.set(url.pathname.replace('/skating-imagery/', ''), JSON.parse(await req.text()));
          return new Response('');
        }
        // A signed read of one object, straight from the bucket.
        const key = url.pathname
          .replace('/skating-imagery/', '')
          .replace(/^\/skating-imagery$/, '');
        if (key && !url.searchParams.has('list-type')) {
          const found = w.manifests.get(key);
          if (found === 'error') return new Response('', { status: 500, statusText: 'Err' });
          if (found === undefined || found === null) return new Response(null, { status: 404 });
          return req.method === 'HEAD' ? new Response(null) : json(found);
        }
        // The listing of one prefix, each object with an ETag that changes when its content does.
        const prefix = url.searchParams.get('prefix') ?? '';
        const contents = [...w.manifests.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .map(
            ([k, v]) => `<Contents><Key>${k}</Key><ETag>&quot;${etag(v)}&quot;</ETag></Contents>`,
          )
          .join('');
        return new Response(
          `<ListBucketResult>${contents}<IsTruncated>false</IsTruncated></ListBucketResult>`,
        );
      }
      if (url.host === 'api.machines.dev') {
        if (req.method === 'POST') {
          const body = JSON.parse(await req.text()) as { config: { init: { cmd: string[] } } };
          const granule = body.config.init.cmd[0] as string;
          if (w.spawnFails.has(granule))
            return new Response('no', { status: 500, statusText: 'Err' });
          w.spawned.push(granule);
          return json({ id: `m-${granule}` });
        }
        const id = url.pathname.split('/machines/')[1];
        if (id) {
          const detail = w.machineDetail.get(id);
          if (detail === 'error') return new Response('', { status: 502, statusText: 'Bad' });
          return detail ? json(detail) : new Response('', { status: 404 });
        }
        return json(w.machines);
      }
      throw new Error(`unexpected fetch ${req.method} ${req.url}`);
    }),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-10T12:00:00Z'));
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function openSeason(t: T, fields: Record<string, unknown> = {}) {
  return await t.run((ctx) =>
    ctx.db.insert('imageryIngestSeasons', {
      season: SEASON,
      opensOn: '2026-10-03',
      openedBy: ['sentinel'],
      winterFrom: null,
      sitesSampled: 28,
      detectedAt: Date.now(),
      imageryStartedAt: Date.now(),
      ...fields,
    }),
  );
}

const runs = (t: T) => t.run((ctx) => ctx.db.query('imageryRuns').collect());
const granules = (t: T) => t.run((ctx) => ctx.db.query('imageryGranules').collect());
const scheduled = (t: T, name: string) =>
  t.run(async (ctx) =>
    (await ctx.db.system.query('_scheduled_functions').collect()).filter(
      (j) => j.name.includes(name) && j.state.kind === 'pending',
    ),
  );

describe('slotOf', () => {
  test('a reprocessing shares its slot; radar slots by platform and start', () => {
    expect(slotOf(s2('19TEM', '20261005', 1))).toEqual({
      slot: 'S2C_19TEM_20261005',
      mission: 's2',
    });
    expect(slotOf(s1('20261005T224512'))).toEqual({ slot: 'S1A_20261005T224512', mission: 's1' });
    expect(slotOf('nonsense')).toBeNull();
  });
});

describe('poll', () => {
  test('does nothing — and records nothing — until imagery is started', async () => {
    const t = convexTest(schema, modules);
    stub(world());
    expect(await t.action(internal.imageryLive.poll, {})).toEqual({
      outcome: 'skipped',
      detail: 'no watch is open',
    });
    await openSeason(t, { imageryStartedAt: undefined });
    expect((await t.action(internal.imageryLive.poll, {})).detail).toBe(
      'imagery has not been started',
    );
    await t.run(async (ctx) => {
      const row = await ctx.db.query('imageryIngestSeasons').first();
      await ctx.db.patch((row as { _id: Id<'imageryIngestSeasons'> })._id, {
        imageryStartedAt: 1,
        imageryPausedAt: 2,
      });
    });
    expect((await t.action(internal.imageryLive.poll, {})).detail).toBe('imagery is paused');
    await t.run(async (ctx) => {
      const row = await ctx.db.query('imageryIngestSeasons').first();
      await ctx.db.patch((row as { _id: Id<'imageryIngestSeasons'> })._id, {
        imageryPausedAt: undefined,
        closesOn: '2027-05-01',
      });
    });
    expect((await t.action(internal.imageryLive.poll, {})).detail).toBe('the watch has ended');
    expect(await runs(t)).toEqual([]);
  });

  test('queues each new slot once, skipping empty tiles and reprocessings', async () => {
    const t = convexTest(schema, modules);
    await openSeason(t);
    const w = world({
      s2: [
        feature(s2('19TEM', '20261005'), '2026-10-05T15:30:00Z', { 'eo:cloud_cover': 99 }),
        feature(s2('19TEM', '20261005', 1), '2026-10-05T15:30:00Z'),
        feature(s2('18TZZ', '20261005'), '2026-10-05T15:31:00Z'),
      ],
      s1: [
        feature(s1('20261006T224512'), '2026-10-06T22:45:12Z', { 'sat:orbit_state': 'ascending' }),
      ],
    });
    stub(w);
    expect(await t.action(internal.imageryLive.poll, {})).toEqual({
      outcome: 'ok',
      detail: 'window 2026-10-03 → 2026-10-10',
    });
    const queued = await granules(t);
    // The cloudy scene is kept (no cloud gate); its v1 reprocessing wins its slot; the empty tile is
    // dropped; the radar pass rides along.
    expect(queued.map((g) => g.granuleId).sort()).toEqual(
      [s1('20261006T224512'), s2('19TEM', '20261005', 1)].sort(),
    );
    expect(queued.every((g) => g.status === 'queued' && g.season === SEASON)).toBe(true);
    expect(await counts(t)).toMatchObject({ queued: 2 });
    expect((await seasonRow(t))?.imageryWindowTo).toBe('2026-10-10');

    // The next poll overlaps five days and finds the same passes: nothing new is queued, and a v0
    // published late into an already-cut slot is not cut a second time.
    vi.setSystemTime(new Date('2026-10-12T12:00:00Z'));
    w.s2.push(feature(s2('19TEM', '20261005', 0, 'S2C'), '2026-10-05T15:30:00Z'));
    const again = await t.action(internal.imageryLive.poll, {});
    expect(again.detail).toBe('window 2026-10-05 → 2026-10-12');
    expect(await granules(t)).toHaveLength(2);
    expect((await runs(t)).at(-1)?.counts).toMatchObject({ queued: 0, alreadyQueued: 2 });
  });

  test('refuses, once a day, without credentials', async () => {
    const t = convexTest(schema, modules);
    await openSeason(t);
    vi.unstubAllEnvs();
    stub(world());
    expect((await t.action(internal.imageryLive.poll, {})).outcome).toBe('refused');
    await t.action(internal.imageryLive.poll, {});
    const alerts = await scheduled(t, 'broadcastToStaff');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.args[0]).toMatchObject({
      roles: ['admin'],
      heading: 'Satellite imagery is not configured',
    });
    expect(JSON.stringify(alerts[0]?.args[0])).toContain('FLY_API_TOKEN');
    expect((await runs(t)).map((r) => r.outcome)).toEqual(['refused', 'refused']);
  });

  test('refuses without staged masks, or with a search plan from another bake', async () => {
    const t = convexTest(schema, modules);
    await openSeason(t);
    stub(world({ sidecar: null }));
    expect((await t.action(internal.imageryLive.poll, {})).detail).toContain('bake-masks');
    stub(world({ plan: { surveyKey: 'v3:winter-2026-27:1', bbox: [0, 0, 1, 1], emptyTiles: [] } }));
    expect((await t.action(internal.imageryLive.poll, {})).detail).toContain('publish-search-plan');
  });

  test('a catalog failure is recorded and alerts the admins', async () => {
    const t = convexTest(schema, modules);
    await openSeason(t);
    stub(world({ failStac: true }));
    const result = await t.action(internal.imageryLive.poll, {});
    expect(result).toMatchObject({ outcome: 'failed' });
    expect(result.detail).toContain('STAC search failed: 502');
    expect((await scheduled(t, 'broadcastToStaff'))[0]?.args[0]).toMatchObject({
      heading: 'A satellite catalog check failed',
    });
  });

  test(`queues at most ${POLL_CAP} a check, oldest first, and resumes where it stopped`, async () => {
    const t = convexTest(schema, modules);
    await openSeason(t);
    // 150 passes on each of 3 days: the cap lands inside the second day.
    const features = Array.from({ length: 450 }, (_, i) => {
      const day = String(3 + Math.floor(i / 150)).padStart(2, '0');
      const n = i % 150;
      const tile = `19T${String.fromCharCode(65 + Math.floor(n / 26))}${String.fromCharCode(65 + (n % 26))}`;
      return feature(s2(tile, `202610${day}`), `2026-10-${day}T15:30:00Z`);
    });
    const w = world({ s2: features });
    stub(w);
    const result = await t.action(internal.imageryLive.poll, {});
    expect(result).toEqual({ outcome: 'capped', detail: 'window 2026-10-03 → 2026-10-04' });
    expect(await granules(t)).toHaveLength(POLL_CAP);
    expect((await runs(t))[0]?.counts).toMatchObject({ queued: POLL_CAP, notYetExamined: 150 });
    // ⚠ The window stops at the newest pass queued, not today, so nothing over the cap is lost.
    expect((await seasonRow(t))?.imageryWindowTo).toBe('2026-10-04');
    expect((await scheduled(t, 'broadcastToStaff'))[0]?.args[0]).toMatchObject({
      heading: `A satellite check hit its cap of ${POLL_CAP}`,
    });

    // The next check starts from the overlap and queues the rest.
    vi.setSystemTime(new Date('2026-10-10T18:00:00Z'));
    expect((await t.action(internal.imageryLive.poll, {})).outcome).toBe('ok');
    expect(await granules(t)).toHaveLength(450);
  });
});

async function seedAdmin(t: T) {
  return await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: 'admin',
      displayName: 'A',
      username: 'a',
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
        nearbyReportDigest: true,
        greatReportNearby: true,
      },
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role: 'admin' as const,
      status: 'active' as const,
      createdAt: Date.now(),
    }),
  );
}

async function queue(t: T, ids: string[], fields: Record<string, unknown> = {}) {
  return await t.run(async (ctx) => {
    const out: Id<'imageryGranules'>[] = [];
    for (const id of ids) {
      out.push(
        await ctx.db.insert('imageryGranules', {
          granuleId: id,
          slot: slotOf(id)?.slot ?? id,
          mission: 's2' as const,
          season: SEASON,
          capturedAt: '2026-10-05T15:30:00Z',
          status: 'queued' as const,
          attempts: 0,
          queuedAt: Date.now(),
          ...fields,
        }),
      );
    }
    return out;
  });
}

const seasonRow = (t: T) => t.run((ctx) => ctx.db.query('imageryIngestSeasons').first());
const counts = (t: T) => t.run((ctx) => ctx.db.query('imageryCounts').first());
/** Every job by name, pending or already run — advancing fake timers runs due ones. */
const jobs = (t: T, name: string) =>
  t.run(async (ctx) =>
    (await ctx.db.system.query('_scheduled_functions').collect()).filter((j) =>
      j.name.includes(name),
    ),
  );
const pumpNow = (t: T) => t.action(internal.imageryLive.pump, {});

const runState = (t: T, key: 'pump' | 'index' = 'pump') =>
  t.run(async (ctx) => (await ctx.db.query('imageryPump').collect()).find((r) => r.key === key));
const fullFleet = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `x${i}`, name: `granule-x${i}`, state: 'started' }));

describe('pump — starting cuts', () => {
  test('starts up to the live cap, and leaves the lease free', async () => {
    const t = convexTest(schema, modules);
    await openSeason(t);
    const ids = [s2('19TEA', '20261005'), s2('19TEB', '20261005'), s2('19TEC', '20261005')];
    await queue(t, ids);
    const w = world({ machines: fullFleet(23) });
    stub(w);
    expect(await pumpNow(t)).toMatchObject({ live: 23, spawned: 2 });
    expect(w.spawned).toEqual(ids.slice(0, 2));
    expect(
      (await granules(t))
        .filter((g) => g.status === 'spawned')
        .every((g) => g.machineId?.startsWith('m-')),
    ).toBe(true);
    expect((await runs(t))[0]).toMatchObject({ kind: 'pump', outcome: 'ok' });
    expect((await runState(t))?.runningUntil).toBe(0);
  });

  test('with nothing to do, a tick is one read: no lease, no row, no run', async () => {
    const t = convexTest(schema, modules);
    await openSeason(t, { imageryPausedAt: Date.now() });
    // Queued but paused, and nothing cutting: nothing to do.
    await queue(t, [s2('19TEA', '20261005')]);
    stub(world());
    expect(await pumpNow(t)).toEqual({ skipped: 'nothing to do' });
    expect(await runState(t)).toBeNull();
    expect(await runs(t)).toEqual([]);
  });

  test('never starts a cut while paused — but still settles the ones in flight', async () => {
    const t = convexTest(schema, modules);
    await openSeason(t, { imageryPausedAt: Date.now() });
    const landed = s2('19TEZ', '20261005');
    await queue(t, [s2('19TEA', '20261005')]);
    await queue(t, [landed], { status: 'spawned', attempts: 1, machineId: 'm', spawnedAt: 0 });
    const w = world({
      manifests: new Map([[`frames/${SEASON}/${landed}.json`, { granuleId: landed }]]),
    });
    stub(w);
    expect(await pumpNow(t)).toMatchObject({ landed: 1, spawned: 0 });
    expect(w.spawned).toEqual([]);
    // A frame landed: the index tick will rebuild.
    expect((await runState(t, 'index'))?.dirtySeq).toBe(1);
  });

  test('a refused spawn spends no attempt; three in a row trip the breaker and back off', async () => {
    const t = convexTest(schema, modules);
    await openSeason(t);
    const ids = ['A', 'B', 'C', 'D', 'E'].map((c) => s2(`19TE${c}`, '20261005'));
    await queue(t, ids);
    stub(world({ spawnFails: new Set(ids) }));
    expect(await pumpNow(t)).toMatchObject({ refused: 3, spawned: 0 });
    const rows = await granules(t);
    expect(rows.every((g) => g.status === 'queued' && g.attempts === 0)).toBe(true);
    // The three tried carry a refusal each; the two never tried carry nothing.
    expect(rows.filter((g) => g.refusals === 1)).toHaveLength(3);
    expect((await scheduled(t, 'broadcastToStaff'))[0]?.args[0]).toMatchObject({
      heading: 'Fly is refusing new satellite cuts',
      roles: ['admin'],
    });
    expect(((await runState(t))?.backoffUntil ?? 0) - Date.now()).toBeGreaterThanOrEqual(
      29 * 60_000,
    );
    // A tick during the backoff does nothing.
    expect(await pumpNow(t)).toEqual({ skipped: 'backing off' });
  });

  test('after a backoff the breaker is half-open: one probe, and a success closes it', async () => {
    const t = convexTest(schema, modules);
    await openSeason(t);
    const ids = ['A', 'B', 'C', 'D'].map((c) => s2(`19TE${c}`, '20261005'));
    await queue(t, ids);
    const w = world({ spawnFails: new Set(ids.slice(0, 3)) });
    stub(w);
    await pumpNow(t); // three refusals trip it; the fourth goes back untried
    vi.advanceTimersByTime(31 * 60_000);
    // Fly is fixed. The first run after the backoff claims one granule — the probe — and it
    // succeeds; the breaker closes, and the next run starts the rest.
    w.spawnFails.clear();
    expect(await pumpNow(t)).toMatchObject({ spawned: 1, refused: 0 });
    expect((await runState(t))?.refusalStreak).toBe(0);
    expect(await pumpNow(t)).toMatchObject({ spawned: 3 });
  });

  test('a half-open probe that is refused trips the breaker again at once', async () => {
    const t = convexTest(schema, modules);
    await openSeason(t);
    const ids = ['A', 'B', 'C', 'D'].map((c) => s2(`19TE${c}`, '20261005'));
    await queue(t, ids);
    stub(world({ spawnFails: new Set(ids) }));
    await pumpNow(t);
    vi.advanceTimersByTime(31 * 60_000);
    expect(await pumpNow(t)).toMatchObject({ refused: 1 });
    expect(((await runState(t))?.backoffUntil ?? 0) - Date.now()).toBeGreaterThanOrEqual(
      29 * 60_000,
    );
  });

  test('the streak carries across runs, so one refusal at a time still trips', async () => {
    const t = convexTest(schema, modules);
    await openSeason(t);
    const id = s2('19TEA', '20261005');
    stub(world({ spawnFails: new Set([id]), machines: fullFleet(24) }));
    await queue(t, [id]);
    for (let run = 1; run <= 3; run++) {
      await pumpNow(t);
      expect((await runState(t))?.refusalStreak).toBe(run);
    }
    // Three refusals of the one granule: it is failed, and the breaker is open.
    expect((await granules(t))[0]).toMatchObject({ status: 'failed', refusals: 3 });
    expect((await runState(t))?.backoffUntil).toBeGreaterThan(Date.now());
    const headings = (await scheduled(t, 'broadcastToStaff')).map(
      (j) => (j.args[0] as { heading: string }).heading,
    );
    expect(headings).toContain('Fly is refusing new satellite cuts');
    expect(headings).toContain('1 satellite cut failed');
  });

  test('a refused granule goes to the back of the queue', async () => {
    const t = convexTest(schema, modules);
    await openSeason(t);
    const bad = s2('19TEA', '20261005');
    const good = s2('19TEB', '20261005');
    await queue(t, [bad]);
    vi.advanceTimersByTime(1_000);
    await queue(t, [good]);
    const w = world({ spawnFails: new Set([bad]), machines: fullFleet(24) });
    stub(w);
    vi.advanceTimersByTime(1_000);
    await pumpNow(t); // claims the bad one (oldest), refused — and re-queued at this later time
    await pumpNow(t); // claims the good one now — the bad one moved behind it
    expect(w.spawned).toEqual([good]);
  });

  test('a spawn that times out is left in flight, not refused', async () => {
    const t = convexTest(schema, modules);
    await openSeason(t);
    const id = s2('19TEA', '20261005');
    await queue(t, [id]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: Request | string, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input, init);
        if (req.url.includes('api.machines.dev') && req.method === 'POST') {
          throw new DOMException('The operation timed out.', 'TimeoutError');
        }
        if (req.url.includes('api.machines.dev')) return new Response('[]');
        return new Response('', { status: 404 });
      }),
    );
    expect(await pumpNow(t)).toMatchObject({ unconfirmed: 1, refused: 0 });
    expect((await granules(t))[0]).toMatchObject({ status: 'spawned', attempts: 1 });
    expect((await granules(t))[0]?.machineId).toBeUndefined();
    expect((await runState(t))?.refusalStreak).toBe(0);
  });

  test('two timeouts stop a run starting more; the untried claims go back to the queue', async () => {
    const t = convexTest(schema, modules);
    await openSeason(t);
    const ids = ['A', 'B', 'C', 'D'].map((c) => s2(`19TE${c}`, '20261005'));
    await queue(t, ids);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: Request | string, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input, init);
        if (req.url.includes('api.machines.dev') && req.method === 'POST') {
          throw new DOMException('The operation timed out.', 'TimeoutError');
        }
        if (req.url.includes('api.machines.dev')) return new Response('[]');
        return new Response('', { status: 404 });
      }),
    );
    expect(await pumpNow(t)).toMatchObject({ unconfirmed: 2 });
    const rows = await granules(t);
    expect(rows.filter((g) => g.status === 'spawned')).toHaveLength(2);
    expect(rows.filter((g) => g.status === 'queued' && g.attempts === 0)).toHaveLength(2);
    // (Seeded directly, so only the run's own moves are counted: four claimed, two handed back.)
    expect(await counts(t)).toMatchObject({ queued: -2, spawned: 2 });
    expect((await scheduled(t, 'broadcastToStaff'))[0]?.args[0]).toMatchObject({
      heading: 'Fly is not answering spawns',
    });
  });

  test('a spawn budget stops a slow run, handing the rest back', async () => {
    const t = convexTest(schema, modules);
    await openSeason(t);
    const ids = ['A', 'B', 'C'].map((c) => s2(`19TE${c}`, '20261005'));
    await queue(t, ids);
    stub(world());
    const fetchFn = globalThis.fetch;
    // Each create takes three minutes of the clock: the second one ends past the four-minute budget.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: Request | string, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input, init);
        if (req.url.includes('api.machines.dev') && req.method === 'POST') {
          vi.advanceTimersByTime(3 * 60_000);
        }
        return fetchFn(req);
      }),
    );
    expect(await pumpNow(t)).toMatchObject({ spawned: 2 });
    expect((await granules(t)).filter((g) => g.status === 'queued')).toHaveLength(1);
  });

  test('Pause during a batch stops it: no spawn after the Pause commits, the rest handed back', async () => {
    const t = convexTest(schema, modules);
    const id = await openSeason(t);
    const ids = ['A', 'B', 'C'].map((c) => s2(`19TE${c}`, '20261005'));
    await queue(t, ids);
    const w = world();
    stub(w);
    const fetchFn = globalThis.fetch;
    // An admin presses Pause while the first create is in flight.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: Request | string, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input, init);
        if (req.url.includes('api.machines.dev') && req.method === 'POST') {
          await t.run((ctx) => ctx.db.patch(id, { imageryPausedAt: Date.now() }));
        }
        return fetchFn(req);
      }),
    );
    expect(await pumpNow(t)).toMatchObject({ spawned: 1 });
    expect(w.spawned).toEqual(ids.slice(0, 1));
    const rows = await granules(t);
    expect(rows.filter((g) => g.status === 'queued' && g.attempts === 0)).toHaveLength(2);
  });

  test('an unreadable Machine list backs off with one alert a day, and starts nothing', async () => {
    const t = convexTest(schema, modules);
    await openSeason(t);
    await queue(t, [s2('19TEA', '20261005')]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: Request | string) => {
        const url = input instanceof Request ? input.url : input;
        if (url.includes('api.machines.dev')) return new Response('', { status: 401 });
        return new Response('', { status: 404 });
      }),
    );
    expect(await pumpNow(t)).toMatchObject({ spawned: 0 });
    expect((await granules(t))[0]?.status).toBe('queued');
    vi.advanceTimersByTime(31 * 60_000);
    await pumpNow(t);
    const alerts = await jobs(t, 'broadcastToStaff');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.args[0]).toMatchObject({
      heading: 'The Fly API is refusing the imagery job',
    });
  });

  test('a run that throws backs off, leaves a run row, and tells the admins', async () => {
    const t = convexTest(schema, modules);
    await openSeason(t);
    await queue(t, [s2('19TEA', '20261005')]);
    // Fly refuses the list, and the alert about it then throws (a corrupt duplicate throttle row
    // makes its `.unique()` read fail) — an unexpected error in the middle of a run.
    await t.run(async (ctx) => {
      await ctx.db.insert('dailyThrottle', { key: 'imagery-fly', lastOn: '2000-01-01' });
      await ctx.db.insert('dailyThrottle', { key: 'imagery-fly', lastOn: '2000-01-01' });
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 401 })),
    );
    await expect(pumpNow(t)).rejects.toThrow();
    const state = await runState(t);
    expect(state?.runningUntil).toBe(0);
    expect((state?.backoffUntil ?? 0) - Date.now()).toBeGreaterThanOrEqual(29 * 60_000);
    expect((await runs(t))[0]).toMatchObject({ kind: 'pump', outcome: 'failed' });
    expect((await scheduled(t, 'broadcastToStaff'))[0]?.args[0]).toMatchObject({
      heading: 'The imagery pump hit an error',
    });
  });

  test('does nothing without credentials', async () => {
    const t = convexTest(schema, modules);
    await openSeason(t);
    await queue(t, [s2('19TEA', '20261005')]);
    vi.unstubAllEnvs();
    expect(await pumpNow(t)).toEqual({ skipped: 'unconfigured' });
  });
});

describe('admin resets', () => {
  test('Retry failed and Try again now clear the backoff and run the pump at once', async () => {
    const t = convexTest(schema, modules);
    await openSeason(t);
    await seedAdmin(t);
    const admin = t.withIdentity({ subject: 'admin' });
    for (const press of [
      () => admin.mutation(api.imageryLive.retryFailed, {}),
      () => admin.mutation(api.imageryLive.tryAgainNow, {}),
    ]) {
      await t.run(async (ctx) => {
        for (const r of await ctx.db.query('imageryPump').collect()) await ctx.db.delete(r._id);
        await ctx.db.insert('imageryPump', {
          key: 'pump',
          runningUntil: 0,
          backoffUntil: Date.now() + 20 * 60_000,
          refusalStreak: 3,
          blindTicks: 2,
        });
      });
      await press();
      expect(await runState(t)).toMatchObject({ refusalStreak: 0, blindTicks: 0 });
      expect((await runState(t))?.backoffUntil).toBeUndefined();
    }
    expect(await scheduled(t, 'imageryLive:pump')).toHaveLength(2);
  });
});

describe('the run state', () => {
  test('one holder at a time; only its token releases the lease; a dead holder lapses', async () => {
    const t = convexTest(schema, modules);
    await openSeason(t);
    await queue(t, [s2('19TEA', '20261005')]);
    expect(await t.mutation(internal.imageryLive.begin, { key: 'pump', token: 'a' })).toMatchObject(
      {
        ok: true,
      },
    );
    stub(world());
    expect(await pumpNow(t)).toEqual({ skipped: 'running' });
    await t.mutation(internal.imageryLive.end, { key: 'pump', token: 'stale' });
    expect((await runState(t))?.runningUntil).toBeGreaterThan(Date.now());
    // The lease outlives any action (10 minutes), then lapses.
    vi.advanceTimersByTime(11 * 60_000);
    expect(await pumpNow(t)).toEqual({ skipped: 'running' });
    vi.advanceTimersByTime(5 * 60_000);
    expect((await t.mutation(internal.imageryLive.begin, { key: 'pump', token: 'b' })).ok).toBe(
      true,
    );
  });

  test("an admin's reset during a run is not overwritten when the run ends", async () => {
    const t = convexTest(schema, modules);
    await t.run((ctx) =>
      ctx.db.insert('imageryPump', { key: 'pump', runningUntil: 0, refusalStreak: 2 }),
    );
    await t.mutation(internal.imageryLive.begin, { key: 'pump', token: 'a' });
    vi.advanceTimersByTime(1_000);
    await seedAdmin(t);
    await t.withIdentity({ subject: 'admin' }).mutation(api.imageryLive.tryAgainNow, {});
    // The run ends having tripped the breaker on its stale streak — the reset wins.
    await t.mutation(internal.imageryLive.end, {
      key: 'pump',
      token: 'a',
      backoff: true,
      refusalStreak: 3,
    });
    const state = await runState(t);
    expect(state?.backoffUntil).toBeUndefined();
    expect(state?.refusalStreak).toBe(0);
  });
});

describe('the index tick', () => {
  test('does nothing with no request outstanding, or while another build holds the lease', async () => {
    const t = convexTest(schema, modules);
    stub(world());
    expect(await t.action(internal.imageryLive.buildIndex, {})).toBeNull();
    await t.mutation(internal.imageryLive.markIndexDirty, {});
    await t.mutation(internal.imageryLive.begin, { key: 'index', token: 'other' });
    expect(await t.action(internal.imageryLive.buildIndex, {})).toBeNull();
    expect(await t.query(internal.imageryLive.indexOutstanding, { now: Date.now() })).toBe(1);
  });

  test('without credentials it builds nothing and keeps the request', async () => {
    const t = convexTest(schema, modules);
    vi.unstubAllEnvs();
    await t.mutation(internal.imageryLive.markIndexDirty, {});
    expect(await t.action(internal.imageryLive.buildIndex, {})).toBeNull();
    expect(await t.query(internal.imageryLive.indexOutstanding, { now: Date.now() })).toBe(1);
  });

  test('a frame landing during a build is built again', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.imageryLive.markIndexDirty, {});
    const seq = await t.query(internal.imageryLive.indexOutstanding, { now: Date.now() });
    await t.mutation(internal.imageryLive.markIndexDirty, {}); // lands mid-build
    await t.mutation(internal.imageryLive.markIndexBuilt, { seq: seq as number });
    expect(await t.query(internal.imageryLive.indexOutstanding, { now: Date.now() })).toBe(2);
    // An older build finishing late never moves the mark backwards.
    await t.mutation(internal.imageryLive.markIndexBuilt, { seq: 2 });
    await t.mutation(internal.imageryLive.markIndexBuilt, { seq: 1 });
    expect(await t.query(internal.imageryLive.indexOutstanding, { now: Date.now() })).toBeNull();
  });
});

describe('pump — settling cuts', () => {
  test('settles each cut by what the bucket and Fly say', async () => {
    const t = convexTest(schema, modules);
    await openSeason(t, { imageryPausedAt: Date.now() }); // settle only
    const landed = s2('19TEA', '20261005');
    const running = s2('19TEB', '20261005');
    const firstMiss = s2('19TEC', '20261005');
    const emptyCut = s2('19TED', '20261005');
    const failedCut = s2('19TEE', '20261005');
    const lostClaim = s2('19TEF', '20261005');
    const freshClaim = s2('19TEG', '20261005');
    const justSpawned = s2('19TEH', '20261005');
    const spawnedAt = Date.now() - 30 * 60_000;
    await queue(t, [landed, running], {
      status: 'spawned',
      attempts: 1,
      machineId: 'm',
      spawnedAt,
    });
    await queue(t, [firstMiss], { status: 'spawned', attempts: 1, machineId: 'gone', spawnedAt });
    await queue(t, [emptyCut], { status: 'spawned', attempts: 2, machineId: 'exit0', spawnedAt });
    await queue(t, [failedCut], { status: 'spawned', attempts: 2, machineId: 'exit1', spawnedAt });
    await queue(t, [lostClaim], { status: 'spawned', attempts: 2, spawnedAt });
    await queue(t, [freshClaim], { status: 'spawned', attempts: 1, spawnedAt: Date.now() });
    await queue(t, [justSpawned], {
      status: 'spawned',
      attempts: 1,
      machineId: 'm2',
      spawnedAt: Date.now(),
    });
    const w = world({
      manifests: new Map([[`frames/${SEASON}/${landed}.json`, { granuleId: landed }]]),
      machineDetail: new Map<string, unknown>([
        ['m', { state: 'started' }],
        [
          'exit0',
          {
            state: 'destroyed',
            events: [{ type: 'exit', request: { exit_event: { exit_code: 0 } } }],
          },
        ],
        [
          'exit1',
          {
            state: 'destroyed',
            events: [{ type: 'exit', request: { exit_event: { exit_code: 1 } } }],
          },
        ],
      ]),
    });
    stub(w);
    expect(await pumpNow(t)).toMatchObject({
      landed: 1,
      running: 1,
      young: 2,
      requeued: 1,
      empty: 1,
      failed: 2,
      unknown: 0,
    });
    const by = new Map((await granules(t)).map((g) => [g.granuleId, g]));
    expect(by.get(landed)?.status).toBe('landed');
    expect(by.get(running)?.status).toBe('spawned');
    expect(by.get(firstMiss)?.status).toBe('queued');
    expect(by.get(firstMiss)?.machineId).toBeUndefined();
    expect(by.get(emptyCut)?.status).toBe('empty');
    expect(by.get(failedCut)).toMatchObject({ status: 'failed', lastError: 'exit 1' });
    // Never confirmed is not empty: no Machine was ever seen.
    expect(by.get(lostClaim)).toMatchObject({
      status: 'failed',
      lastError: 'spawn never confirmed',
    });
    expect(by.get(freshClaim)?.status).toBe('spawned');
    expect(by.get(justSpawned)?.status).toBe('spawned');
    expect((await runState(t, 'index'))?.dirtySeq).toBe(1);
    expect((await scheduled(t, 'broadcastToStaff'))[0]?.args[0]).toMatchObject({
      heading: '2 satellite cuts failed',
    });
  });

  test('empty needs proof: a Machine gone from the API is failed, unless the cutter recorded nothing to cut', async () => {
    const t = convexTest(schema, modules);
    await openSeason(t, { imageryPausedAt: Date.now() });
    const vanished = s2('19TEA', '20261005');
    const recorded = s2('19TEB', '20261005');
    const recordedFirstTry = s2('19TEC', '20261005');
    const spawnedAt = Date.now() - 30 * 60_000;
    // Both Machines auto-destroyed and the API no longer knows them (a 404): no exit code at all.
    await queue(t, [vanished, recorded], {
      status: 'spawned',
      attempts: 2,
      machineId: 'gone',
      spawnedAt,
    });
    await queue(t, [recordedFirstTry], {
      status: 'spawned',
      attempts: 1,
      machineId: 'gone',
      spawnedAt,
    });
    stub(
      world({
        manifests: new Map<string, unknown>([
          [emptyMarkerKey(SEASON, recorded), { granuleId: recorded }],
          [emptyMarkerKey(SEASON, recordedFirstTry), { granuleId: recordedFirstTry }],
        ]),
      }),
    );
    expect(await pumpNow(t)).toMatchObject({ empty: 2, failed: 1, requeued: 0 });
    const by = new Map((await granules(t)).map((g) => [g.granuleId, g]));
    expect(by.get(vanished)).toMatchObject({
      status: 'failed',
      lastError: 'gone with no frame and no nothing-to-cut record',
    });
    expect(by.get(recorded)?.status).toBe('empty');
    // The record settles a first miss too: no retry for a granule known to hold nothing.
    expect(by.get(recordedFirstTry)?.status).toBe('empty');
    // Outside `frames/`, so the index never lists it as a frame.
    expect(emptyMarkerKey(SEASON, recorded).startsWith('frames/')).toBe(false);
  });

  test('a first miss that exited non-zero keeps the code', async () => {
    const t = convexTest(schema, modules);
    const id = s2('19TEA', '20261005');
    await queue(t, [id], { status: 'spawned', attempts: 1, machineId: 'exit3', spawnedAt: 0 });
    stub(
      world({
        machineDetail: new Map([
          [
            'exit3',
            {
              state: 'stopped',
              events: [{ type: 'exit', request: { exit_event: { exit_code: 3 } } }],
            },
          ],
        ]),
      }),
    );
    await pumpNow(t);
    expect((await granules(t))[0]).toMatchObject({ status: 'queued', lastError: 'exit 3' });
  });

  test('three blind runs in a row back off — however few cuts are in flight', async () => {
    const t = convexTest(schema, modules);
    await queue(t, [s2('19TEA', '20261005')], {
      status: 'spawned',
      attempts: 1,
      machineId: 'm',
      spawnedAt: 0,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 503, statusText: 'Down' })),
    );
    for (let run = 1; run <= 2; run++) {
      expect(await pumpNow(t)).toMatchObject({ unknown: 1 });
      expect((await runState(t))?.backoffUntil).toBeUndefined();
      expect((await runState(t))?.blindTicks).toBe(run);
    }
    await pumpNow(t);
    expect((await granules(t))[0]?.status).toBe('spawned');
    expect((await scheduled(t, 'broadcastToStaff'))[0]?.args[0]).toMatchObject({
      heading: 'Cuts in flight cannot be checked',
    });
    expect(((await runState(t))?.backoffUntil ?? 0) - Date.now()).toBeGreaterThanOrEqual(
      29 * 60_000,
    );
  });

  test('one blink among answers — or among cuts too young to check — is not a backoff', async () => {
    const t = convexTest(schema, modules);
    await openSeason(t, { imageryPausedAt: Date.now() });
    await queue(t, [s2('19TEA', '20261005')], {
      status: 'spawned',
      attempts: 1,
      machineId: 'bad',
      spawnedAt: 0,
    });
    await queue(t, [s2('19TEB', '20261005')], {
      status: 'spawned',
      attempts: 1,
      machineId: 'm',
      spawnedAt: 0,
    });
    stub(
      world({
        machineDetail: new Map<string, unknown>([
          ['bad', 'error'],
          ['m', { state: 'started' }],
        ]),
      }),
    );
    expect(await pumpNow(t)).toMatchObject({ unknown: 1, running: 1 });
    // And the other shape: one blink beside cuts too young to check.
    await t.run(async (ctx) => {
      for (const g of await ctx.db.query('imageryGranules').collect()) {
        if (g.machineId === 'm')
          await ctx.db.patch(g._id, { spawnedAt: Date.now(), machineId: 'm' });
      }
    });
    expect(await pumpNow(t)).toMatchObject({ unknown: 1, young: 1 });
    expect(await scheduled(t, 'broadcastToStaff')).toHaveLength(0);
    expect((await runState(t))?.backoffUntil).toBeUndefined();
  });
});

describe('buildIndex', () => {
  const manifest = (
    granuleId: string,
    capturedAt: string,
    extra: Record<string, unknown> = {},
  ) => ({
    granuleId,
    capturedAt,
    season: SEASON,
    bodyCount: 12,
    bands: ['visual', 'scl'],
    cloudCoverPct: 40,
    bodies: [{ waterBodyId: 'x' }],
    ...extra,
  });

  test('reads only new manifests, drops vanished ones, writes the index and turns latest over', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.imageryLive.markIndexDirty, {});
    const a = s2('19TEA', '20261005');
    const b = s2('19TEB', '20261006');
    const w = world({
      manifests: new Map<string, unknown>([
        [
          `frames/${SEASON}/${a}.json`,
          manifest(a, '2026-10-05T15:30:00Z', { footprint: { type: 'Polygon', coordinates: [] } }),
        ],
        [`frames/${SEASON}/${a}-visual.pmtiles`, {}],
      ]),
    });
    stub(w);
    expect(await t.action(internal.imageryLive.buildIndex, {})).toEqual({ frames: 2 });
    const index = w.puts.get(`index/${SEASON}.json`) as { frames: { key: string }[] };
    expect(index.frames.map((f) => f.key)).toEqual([
      `frames/${SEASON}/${a}-visual.pmtiles`,
      `frames/${SEASON}/${a}-scl.pmtiles`,
    ]);
    expect(w.puts.get('index/latest.json')).toEqual({ season: SEASON });
    expect(JSON.stringify(index)).not.toContain('waterBodyId'); // per-body stats stay in R2

    // Later: a new manifest lands, the first vanishes, and latest already points here.
    w.manifests.delete(`frames/${SEASON}/${a}.json`);
    w.manifests.set(
      `frames/${SEASON}/${b}.json`,
      manifest(b, '2026-10-06T15:30:00Z', {
        bands: undefined,
        band: 'vh',
        orbitDirection: 'ascending',
        cloudCoverPct: undefined,
      }),
    );
    w.latest = { season: SEASON };
    w.puts.clear();
    // Not dirty: the tick is one read and writes nothing.
    expect(await t.action(internal.imageryLive.buildIndex, {})).toBeNull();
    expect(w.puts.size).toBe(0);
    await t.mutation(internal.imageryLive.markIndexDirty, {});
    await t.action(internal.imageryLive.buildIndex, {});
    const next = w.puts.get(`index/${SEASON}.json`) as {
      frames: { granuleId: string; band: string }[];
    };
    expect(next.frames).toEqual([
      expect.objectContaining({
        granuleId: b,
        band: 'vh',
        orbitDirection: 'ascending',
        cloudCoverPct: null,
      }),
    ]);
    expect(w.puts.has('index/latest.json')).toBe(false);
    const rows = await t.run((ctx) => ctx.db.query('imageryFrames').collect());
    expect(rows.map((r) => r.granuleId)).toEqual([b]);
  });

  test('an unreadable manifest is counted, not fatal; a season without frames does not take latest', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.imageryLive.markIndexDirty, {});
    const w = world({
      manifests: new Map<string, unknown>([[`frames/${SEASON}/bad.json`, null]]),
      latest: null,
    });
    stub(w);
    // `null` in the map lists the key but 404s on read; `'error'` lists it and 500s.
    w.manifests.set(`frames/${SEASON}/bad.json`, null);
    w.manifests.set(`frames/${SEASON}/worse.json`, 'error');
    await t.action(internal.imageryLive.buildIndex, {});
    expect(w.puts.has('index/latest.json')).toBe(false);
    expect((await runs(t))[0]).toMatchObject({
      outcome: 'failed',
      counts: expect.objectContaining({ unreadable: 2, frames: 0 }),
    });
    expect((await scheduled(t, 'broadcastToStaff'))[0]?.args[0]).toMatchObject({
      heading: 'Some cut frames cannot be read into the imagery index',
    });
  });

  test('an unreadable manifest is retried — later, less often — and never holds back a new frame', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.imageryLive.markIndexDirty, {});
    const a = s2('19TEA', '20261005');
    const b = s2('19TEB', '20261006');
    const bad = `frames/${SEASON}/${a}.json`;
    const w = world({ manifests: new Map<string, unknown>([[bad, 'error']]) });
    stub(w);
    const due = () => t.query(internal.imageryLive.indexOutstanding, { now: Date.now() });
    expect(await t.action(internal.imageryLive.buildIndex, {})).toEqual({ frames: 0 });
    // The last cut has landed and imagery is paused: nothing will mark the index dirty again —
    // the retry is what reads it, in half an hour.
    expect(await due()).toBeNull();
    const firstRetry = (await runState(t, 'index'))?.retryAt as number;
    expect(firstRetry - Date.now()).toBe(30 * 60_000);
    expect(JSON.stringify((await scheduled(t, 'broadcastToStaff'))[0]?.args[0])).toContain(
      'again in 30 minutes',
    );
    // A good frame lands meanwhile: it is built on the next tick, not held for the retry — and
    // that build neither escalates the wait nor pushes the retry back.
    vi.advanceTimersByTime(10 * 60_000);
    w.manifests.set(`frames/${SEASON}/${b}.json`, manifest(b, '2026-10-06T15:30:00Z'));
    await t.mutation(internal.imageryLive.markIndexDirty, {});
    expect(await t.action(internal.imageryLive.buildIndex, {})).toEqual({ frames: 2 });
    expect(await runState(t, 'index')).toMatchObject({ unreadableStreak: 1, retryAt: firstRetry });
    // The retry comes due on its own; still unreadable, the next wait doubles to an hour.
    vi.advanceTimersByTime(21 * 60_000);
    expect(await due()).not.toBeNull();
    await t.action(internal.imageryLive.buildIndex, {});
    expect(await runState(t, 'index')).toMatchObject({ unreadableStreak: 2 });
    expect(((await runState(t, 'index'))?.retryAt ?? 0) - Date.now()).toBe(60 * 60_000);
    // The page shows the wait, and Try again now makes it due at once.
    await seedAdmin(t);
    const admin = t.withIdentity({ subject: 'admin' });
    expect((await admin.query(api.imageryLive.activity, {})).indexRetryAt).toBeGreaterThan(
      Date.now(),
    );
    await admin.mutation(api.imageryLive.tryAgainNow, {});
    expect(await due()).toBe(2);
    // The manifest is fixed: the retry reads it, and the wait is gone.
    w.manifests.set(bad, manifest(a, '2026-10-05T15:30:00Z'));
    expect(await t.action(internal.imageryLive.buildIndex, {})).toEqual({ frames: 4 });
    expect(await due()).toBeNull();
    const job = await runState(t, 'index');
    expect(job?.retryAt).toBeUndefined();
    expect(job?.unreadableStreak).toBeUndefined();
  });

  test('Try again now pressed during a build is the next retry, not overwritten by its wait', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.imageryLive.markIndexDirty, {});
    const bad = `frames/${SEASON}/${s2('19TEA', '20261005')}.json`;
    stub(world({ manifests: new Map<string, unknown>([[bad, 'error']]) }));
    await t.action(internal.imageryLive.buildIndex, {}); // a retry is pending, 30 minutes out
    // A new frame's build is under way when the admin presses Try again now…
    await t.mutation(internal.imageryLive.markIndexDirty, {});
    await t.mutation(internal.imageryLive.begin, { key: 'index', token: 'run' });
    vi.advanceTimersByTime(1_000);
    await seedAdmin(t);
    await t.withIdentity({ subject: 'admin' }).mutation(api.imageryLive.tryAgainNow, {});
    // …and that build still cannot read it: the admin's retry stands — due now, not pushed back.
    expect(
      await t.mutation(internal.imageryLive.markIndexBuilt, { seq: 2, unreadableKeys: ['k'] }),
    ).toEqual({ retryInMs: 0 });
    expect(await runState(t, 'index')).toMatchObject({ unreadableStreak: 1 });
  });

  test('a build that starts once the retry is due is the retry, whatever asked for it', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.imageryLive.markIndexDirty, {});
    const bad = `frames/${SEASON}/${s2('19TEA', '20261005')}.json`;
    stub(world({ manifests: new Map<string, unknown>([[bad, 'error']]) }));
    await t.action(internal.imageryLive.buildIndex, {});
    // Past the retry, a new frame asks for a build: it re-reads the manifest, so it was the retry,
    // and the wait doubles rather than sitting in the past.
    vi.advanceTimersByTime(31 * 60_000);
    await t.mutation(internal.imageryLive.markIndexDirty, {});
    await t.action(internal.imageryLive.buildIndex, {});
    expect(await runState(t, 'index')).toMatchObject({ unreadableStreak: 2 });
    expect(((await runState(t, 'index'))?.retryAt ?? 0) - Date.now()).toBe(60 * 60_000);
  });

  test('the unreadable retry waits half an hour, doubling to a six-hour ceiling', () => {
    expect([1, 2, 3, 4, 5, 6, 9].map((n) => unreadableRetryMs(n) / 60_000)).toEqual([
      30, 60, 120, 240, 360, 360, 360,
    ]);
  });

  test('a recut manifest is read again: its new ETag retires the saved row', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.imageryLive.markIndexDirty, {});
    const a = s2('19TEA', '20261005');
    const key = `frames/${SEASON}/${a}.json`;
    const w = world({
      manifests: new Map<string, unknown>([[key, manifest(a, '2026-10-05T15:30:00Z')]]),
    });
    stub(w);
    await t.action(internal.imageryLive.buildIndex, {});
    // A manual recut writes the same key: one band now, and a different body count.
    w.manifests.set(key, manifest(a, '2026-10-05T15:30:00Z', { bands: ['visual'], bodyCount: 15 }));
    await t.mutation(internal.imageryLive.markIndexDirty, {});
    expect(await t.action(internal.imageryLive.buildIndex, {})).toEqual({ frames: 1 });
    const index = w.puts.get(`index/${SEASON}.json`) as { frames: { band: string }[] };
    expect(index.frames.map((f) => f.band)).toEqual(['visual']);
    const rows = await t.run((ctx) => ctx.db.query('imageryFrames').collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ bodyCount: 15, bands: ['visual'] });
    // Unchanged since: the next build reuses the row and reads nothing.
    await t.mutation(internal.imageryLive.markIndexDirty, {});
    await t.action(internal.imageryLive.buildIndex, {});
    expect((await runs(t)).at(-1)?.counts).toMatchObject({ added: 0 });
  });

  test('a row saved before ETags were kept is read again — it may predate a recut', async () => {
    const t = convexTest(schema, modules);
    const a = s2('19TEA', '20261005');
    const key = `frames/${SEASON}/${a}.json`;
    // Saved by an earlier build, with no ETag and the old details; the bucket holds the recut.
    await t.run((ctx) =>
      ctx.db.insert('imageryFrames', {
        season: SEASON,
        manifestKey: key,
        granuleId: a,
        capturedAt: '2026-10-05T15:30:00Z',
        cloudCoverPct: 40,
        bodyCount: 12,
        bands: ['visual', 'scl'],
      }),
    );
    await t.mutation(internal.imageryLive.markIndexDirty, {});
    stub(
      world({
        manifests: new Map<string, unknown>([
          [key, manifest(a, '2026-10-05T15:30:00Z', { bands: ['visual'], bodyCount: 15 })],
        ]),
      }),
    );
    await t.action(internal.imageryLive.buildIndex, {});
    const [row] = await t.run((ctx) => ctx.db.query('imageryFrames').collect());
    expect(row).toMatchObject({ bodyCount: 15, bands: ['visual'] });
    expect(row?.etag).toBeDefined();
  });

  test("slow reads run out the build's budget, not the action: each group is saved, the next tick goes on", async () => {
    const t = convexTest(schema, modules);
    const manifests = new Map<string, unknown>();
    for (let i = 0; i < 20; i++) {
      const g = s2(`19T${String(i).padStart(3, '0')}`, '20261005');
      manifests.set(`frames/${SEASON}/${g}.json`, manifest(g, '2026-10-05T15:30:00Z'));
    }
    await t.mutation(internal.imageryLive.markIndexDirty, {});
    stub(world({ manifests }));
    const fetchFn = globalThis.fetch;
    // Every signed manifest read stalls to its 30 s timeout before answering.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: Request | string, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input, init);
        if (req.url.startsWith(ENDPOINT) && req.url.includes('/frames/') && req.method === 'GET') {
          vi.advanceTimersByTime(30_000);
        }
        return fetchFn(req);
      }),
    );
    const saved = () => t.run((ctx) => ctx.db.query('imageryFrames').collect());
    // One group of eight takes four minutes: the budget is spent, and what it read is kept.
    await t.action(internal.imageryLive.buildIndex, {});
    expect(await saved()).toHaveLength(8);
    expect((await runs(t)).at(-1)?.counts).toMatchObject({ added: 8, deferred: 12 });
    expect(await t.query(internal.imageryLive.indexOutstanding, { now: Date.now() })).toBe(1);
    // Each tick goes on from there, until every frame is read and the request is satisfied.
    await t.action(internal.imageryLive.buildIndex, {});
    expect(await saved()).toHaveLength(16);
    await t.action(internal.imageryLive.buildIndex, {});
    expect(await saved()).toHaveLength(20);
    expect(await t.query(internal.imageryLive.indexOutstanding, { now: Date.now() })).toBeNull();
    expect((await runs(t)).at(-1)?.counts).toMatchObject({ added: 4 });
  });

  test('manifests that stall go to the back, so the readable frames behind them are reached', async () => {
    const t = convexTest(schema, modules);
    const manifests = new Map<string, unknown>();
    const stalling = new Set<string>();
    // Sixteen manifests that stall to their timeout and fail, listed ahead of four good ones.
    for (let i = 0; i < 20; i++) {
      const g = s2(`19T${String(i).padStart(3, '0')}`, '20261005');
      const key = `frames/${SEASON}/${g}.json`;
      if (i < 16) stalling.add(key);
      manifests.set(key, manifest(g, '2026-10-05T15:30:00Z'));
    }
    await t.mutation(internal.imageryLive.markIndexDirty, {});
    stub(world({ manifests }));
    const fetchFn = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: Request | string, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input, init);
        const key = new URL(req.url).pathname.replace('/skating-imagery/', '');
        if (req.url.startsWith(ENDPOINT) && req.method === 'GET' && stalling.has(key)) {
          vi.advanceTimersByTime(30_000);
          return new Response('', { status: 504, statusText: 'Timeout' });
        }
        return fetchFn(req);
      }),
    );
    const good = async () =>
      (await t.run((ctx) => ctx.db.query('imageryFrames').collect())).map((r) => r.manifestKey);
    // Two builds spend their budgets on the stalling front of the list, remembering each failure.
    await t.action(internal.imageryLive.buildIndex, {});
    await t.action(internal.imageryLive.buildIndex, {});
    expect(await good()).toEqual([]);
    expect(await t.query(internal.imageryLive.unreadableKeys, {})).toHaveLength(16);
    // The third reads the good frames first, the known-unreadable ones behind them.
    await t.action(internal.imageryLive.buildIndex, {});
    expect(await good()).toHaveLength(4);
    // Nothing readable is left, so the request is satisfied; the sixteen wait for their retry.
    expect(await t.query(internal.imageryLive.indexOutstanding, { now: Date.now() })).toBeNull();
    expect((await runState(t, 'index'))?.retryAt).toBeGreaterThan(Date.now());
    expect(await t.query(internal.imageryLive.unreadableKeys, {})).toHaveLength(16);
  });

  test('known-unreadable manifests take turns, so a repaired one behind stalling ones is read', async () => {
    const t = convexTest(schema, modules);
    const manifests = new Map<string, unknown>();
    const stalling = new Set<string>();
    const keys: string[] = [];
    for (let i = 0; i < 17; i++) {
      const g = s2(`19T${String(i).padStart(3, '0')}`, '20261005');
      const key = `frames/${SEASON}/${g}.json`;
      keys.push(key);
      stalling.add(key);
      manifests.set(key, manifest(g, '2026-10-05T15:30:00Z'));
    }
    // All seventeen are known unreadable, the last in line repaired since.
    const repaired = keys[16] as string;
    stalling.delete(repaired);
    await t.mutation(internal.imageryLive.markIndexBuilt, { seq: 0, unreadableKeys: keys });
    await t.mutation(internal.imageryLive.markIndexDirty, {});
    stub(world({ manifests }));
    const fetchFn = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: Request | string, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input, init);
        const key = new URL(req.url).pathname.replace('/skating-imagery/', '');
        if (req.url.startsWith(ENDPOINT) && req.method === 'GET' && stalling.has(key)) {
          vi.advanceTimersByTime(30_000);
          return new Response('', { status: 504, statusText: 'Timeout' });
        }
        return fetchFn(req);
      }),
    );
    const read = async () =>
      (await t.run((ctx) => ctx.db.query('imageryFrames').collect())).map((r) => r.manifestKey);
    // The first build spends its budget on the front eight; they go to the back of the line.
    await t.action(internal.imageryLive.buildIndex, {});
    expect(await read()).toEqual([]);
    expect((await t.query(internal.imageryLive.unreadableKeys, {})).slice(-8)).toEqual(
      keys.slice(0, 8),
    );
    // The next starts where that one stopped; the one after reaches the repaired manifest.
    for (let build = 0; build < 2 && (await read()).length === 0; build++) {
      vi.advanceTimersByTime(7 * 60 * 60_000); // past any retry wait
      await t.action(internal.imageryLive.buildIndex, {});
    }
    expect(await read()).toEqual([repaired]);
  });

  test('a build cut short still sets the unreadable retry and alert', async () => {
    const t = convexTest(schema, modules);
    const manifests = new Map<string, unknown>();
    for (let i = 0; i < 12; i++) {
      const g = s2(`19T${String(i).padStart(3, '0')}`, '20261005');
      manifests.set(
        `frames/${SEASON}/${g}.json`,
        i === 0 ? 'error' : manifest(g, '2026-10-05T15:30:00Z'),
      );
    }
    await t.mutation(internal.imageryLive.markIndexDirty, {});
    stub(world({ manifests }));
    const fetchFn = globalThis.fetch;
    // Every read takes 30 s: the first group of eight uses the budget, and one of them fails.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: Request | string, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input, init);
        if (req.url.startsWith(ENDPOINT) && req.url.includes('/frames/') && req.method === 'GET') {
          vi.advanceTimersByTime(30_000);
        }
        return fetchFn(req);
      }),
    );
    await t.action(internal.imageryLive.buildIndex, {});
    expect((await runs(t)).at(-1)?.counts).toMatchObject({ added: 7, unreadable: 1, deferred: 4 });
    // Readable manifests are left: the request stands — and the failure still has its wait and email.
    expect(await t.query(internal.imageryLive.indexOutstanding, { now: Date.now() })).toBe(1);
    expect((await runState(t, 'index'))?.retryAt).toBeGreaterThan(Date.now());
    expect((await scheduled(t, 'broadcastToStaff'))[0]?.args[0]).toMatchObject({
      heading: 'Some cut frames cannot be read into the imagery index',
    });
  });

  test('a failed rebuild alerts the admins', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.imageryLive.markIndexDirty, {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 403, statusText: 'Forbidden' })),
    );
    expect(await t.action(internal.imageryLive.buildIndex, {})).toBeNull();
    expect((await runs(t))[0]).toMatchObject({ kind: 'index', outcome: 'failed' });
    expect((await scheduled(t, 'broadcastToStaff'))[0]?.args[0]).toMatchObject({
      heading: 'The imagery index could not be rebuilt',
    });
    // A failed build leaves its request standing, so the next tick retries.
    expect(await t.query(internal.imageryLive.indexOutstanding, { now: Date.now() })).toBe(1);
  });
});

describe('the page', () => {
  test("sees runs, this season's ledger, the last failures and any backoff; Retry failed requeues", async () => {
    const t = convexTest(schema, modules);
    await openSeason(t);
    stub(world());
    await t.mutation(internal.imageryLive.queueGranules, {
      items: [
        {
          granuleId: s2('19TEA', '20261005'),
          slot: 'S2C_19TEA_20261005',
          mission: 's2',
          season: SEASON,
          capturedAt: '2026-10-05T15:30:00Z',
        },
        {
          granuleId: s2('19TEB', '20261005'),
          slot: 'S2C_19TEB_20261005',
          mission: 's2',
          season: SEASON,
          capturedAt: '2026-10-05T15:31:00Z',
        },
      ],
      cap: 10,
    });
    // Claim both, then fail one — every move through the ledger.
    const claims = await t.mutation(internal.imageryLive.claimForSpawn, {
      season: SEASON,
      limit: 2,
    });
    await t.mutation(internal.imageryLive.settleMany, {
      settled: [{ id: claims[1]?.id as Id<'imageryGranules'>, status: 'failed', error: 'exit 1' }],
    });
    await t.mutation(internal.imageryLive.settleSpawn, {
      id: claims[0]?.id as Id<'imageryGranules'>,
      untried: true,
    });
    await t.mutation(internal.imageryLive.recordRun, {
      season: SEASON,
      kind: 'poll',
      startedAt: 1,
      outcome: 'ok',
    });
    await seedAdmin(t);
    const admin = t.withIdentity({ subject: 'admin' });
    const activity = await admin.query(api.imageryLive.activity, {});
    expect(activity.counts).toEqual({ queued: 1, spawned: 0, landed: 0, empty: 0, failed: 1 });
    expect(activity.failed).toEqual([{ granuleId: s2('19TEB', '20261005'), lastError: 'exit 1' }]);
    expect(activity.runs).toHaveLength(1);
    expect(activity.configured).toBe(true);
    expect(activity.backoffUntil).toBeNull();

    expect(await admin.mutation(api.imageryLive.retryFailed, {})).toEqual({ requeued: 1 });
    expect((await admin.query(api.imageryLive.activity, {})).counts).toMatchObject({
      queued: 2,
      failed: 0,
    });
  });

  test('settling ignores a row that is not cutting; a claim with no room takes nothing', async () => {
    const t = convexTest(schema, modules);
    const [id] = await queue(t, [s2('19TEA', '20261005')]);
    expect(
      await t.mutation(internal.imageryLive.settleSpawn, {
        id: id as Id<'imageryGranules'>,
        machineId: 'm',
      }),
    ).toEqual({ failed: false });
    await t.mutation(internal.imageryLive.settleMany, {
      settled: [{ id: id as Id<'imageryGranules'>, status: 'landed' }],
    });
    expect((await granules(t))[0]?.status).toBe('queued');
    expect(
      await t.mutation(internal.imageryLive.claimForSpawn, { season: SEASON, limit: 0 }),
    ).toEqual([]);
    expect(
      await t.mutation(internal.imageryLive.setWindowTo, {
        season: 'winter-2030-31',
        windowTo: 'x',
      }),
    ).toBeNull();
  });
});
