import { tileSurveyKey } from '@skating/core';
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { POLL_CAP, slotOf } from './imageryLive';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

/**
 * Live imagery (A06i §5, D214): poll → spawn → reconcile → index, against a stubbed catalog,
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
        const keys = [...w.manifests.keys()].map((k) => `<Key>${k}</Key>`).join('');
        return new Response(
          `<ListBucketResult>${keys}<IsTruncated>false</IsTruncated></ListBucketResult>`,
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

  test('queues each new slot once, skipping empty tiles and reprocessings, then spawns', async () => {
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
    expect(await scheduled(t, 'imageryLive:spawn')).toHaveLength(1);
    expect(
      (await t.run((ctx) => ctx.db.query('imageryIngestSeasons').first()))?.imageryWindowTo,
    ).toBe('2026-10-10');

    // The next poll overlaps five days and finds the same passes: nothing new is queued, and a v0
    // published late into an already-cut slot is not cut a second time.
    vi.setSystemTime(new Date('2026-10-12T12:00:00Z'));
    w.s2.push(feature(s2('19TEM', '20261005', 0, 'S2C'), '2026-10-05T15:30:00Z'));
    const again = await t.action(internal.imageryLive.poll, {});
    expect(again.detail).toBe('window 2026-10-05 → 2026-10-12');
    expect(await granules(t)).toHaveLength(2);
    const last = (await runs(t)).at(-1);
    expect(last?.counts).toMatchObject({ queued: 0, alreadyQueued: 2 });
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
      heading: 'A satellite catalog poll failed',
    });
  });

  test(`queues at most ${POLL_CAP} a poll, oldest first, and says so`, async () => {
    const t = convexTest(schema, modules);
    await openSeason(t);
    const features = Array.from({ length: POLL_CAP + 2 }, (_, i) => {
      const day = String(3 + (i % 7)).padStart(2, '0');
      const tile = `19T${String.fromCharCode(65 + (Math.floor(i / 26) % 26))}${String.fromCharCode(65 + (i % 26))}`;
      return feature(s2(tile, `202610${day}`), `2026-10-${day}T15:30:00Z`);
    });
    stub(world({ s2: features }));
    const result = await t.action(internal.imageryLive.poll, {});
    expect(result.outcome).toBe('capped');
    expect(await granules(t)).toHaveLength(POLL_CAP);
    expect((await runs(t))[0]?.counts).toMatchObject({ overCap: 2 });
    expect((await scheduled(t, 'broadcastToStaff'))[0]?.args[0]).toMatchObject({
      heading: `A satellite poll hit its cap of ${POLL_CAP}`,
    });
  });
});

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

describe('spawn', () => {
  test('spawns up to the live cap, reschedules for the rest, and schedules a reconcile', async () => {
    const t = convexTest(schema, modules);
    const ids = [s2('19TEA', '20261005'), s2('19TEB', '20261005'), s2('19TEC', '20261005')];
    await queue(t, ids);
    const w = world({
      machines: Array.from({ length: 23 }, (_, i) => ({
        id: `x${i}`,
        name: `granule-x${i}`,
        state: 'started',
      })),
    });
    stub(w);
    expect(await t.action(internal.imageryLive.spawn, {})).toEqual({
      spawned: 2,
      failed: 0,
      remaining: 1,
    });
    expect(w.spawned).toEqual(ids.slice(0, 2));
    const rows = await granules(t);
    expect(
      rows.filter((g) => g.status === 'spawned').every((g) => g.machineId?.startsWith('m-')),
    ).toBe(true);
    expect(await scheduled(t, 'imageryLive:spawn')).toHaveLength(1);
    expect(await scheduled(t, 'imageryLive:reconcile')).toHaveLength(1);
    expect((await runs(t))[0]).toMatchObject({
      kind: 'spawn',
      counts: { live: 23, claimed: 2, spawned: 2 },
    });
  });

  test('a failed spawn is retried once, then settled as failed', async () => {
    const t = convexTest(schema, modules);
    const [id] = await queue(t, [s2('19TEA', '20261005')]);
    const w = world({ spawnFails: new Set([s2('19TEA', '20261005')]) });
    stub(w);
    expect(await t.action(internal.imageryLive.spawn, {})).toMatchObject({ failed: 1 });
    expect(await t.run((ctx) => ctx.db.get(id as Id<'imageryGranules'>))).toMatchObject({
      status: 'queued',
      attempts: 1,
    });
    await t.action(internal.imageryLive.spawn, {});
    expect(await t.run((ctx) => ctx.db.get(id as Id<'imageryGranules'>))).toMatchObject({
      status: 'failed',
      attempts: 2,
    });
    expect((await runs(t)).at(-1)?.outcome).toBe('failed');
  });

  test('an unreadable Machine list waits rather than floods', async () => {
    const t = convexTest(schema, modules);
    await queue(t, [s2('19TEA', '20261005')]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 500 })),
    );
    expect(await t.action(internal.imageryLive.spawn, {})).toEqual({
      spawned: 0,
      failed: 0,
      remaining: -1,
    });
    expect(await scheduled(t, 'imageryLive:spawn')).toHaveLength(1);
    expect((await granules(t))[0]?.status).toBe('queued');
  });

  test('spawns nothing without credentials', async () => {
    const t = convexTest(schema, modules);
    vi.unstubAllEnvs();
    expect(await t.action(internal.imageryLive.spawn, {})).toEqual({
      spawned: 0,
      failed: 0,
      remaining: 0,
    });
    expect(await t.action(internal.imageryLive.reconcile, {})).toBeNull();
    expect(await t.action(internal.imageryLive.buildIndex, {})).toBeNull();
  });
});

describe('reconcile', () => {
  test('settles each cut by what the bucket and Fly say', async () => {
    const t = convexTest(schema, modules);
    const landed = s2('19TEA', '20261005');
    const running = s2('19TEB', '20261005');
    const firstMiss = s2('19TEC', '20261005');
    const emptyCut = s2('19TED', '20261005');
    const failedCut = s2('19TEE', '20261005');
    const lostClaim = s2('19TEF', '20261005');
    const freshClaim = s2('19TEG', '20261005');
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
    // Both `landed` and `running` share Machine id `m`; only the one with a manifest is landed.
    const counts = await t.action(internal.imageryLive.reconcile, {});
    expect(counts).toEqual({ landed: 1, running: 2, requeued: 1, empty: 2, failed: 1 });
    const by = new Map((await granules(t)).map((g) => [g.granuleId, g]));
    expect(by.get(landed)?.status).toBe('landed');
    expect(by.get(running)?.status).toBe('spawned');
    expect(by.get(firstMiss)?.status).toBe('queued');
    expect(by.get(firstMiss)?.machineId).toBeUndefined();
    expect(by.get(emptyCut)?.status).toBe('empty');
    expect(by.get(failedCut)).toMatchObject({ status: 'failed', lastError: 'exit 1' });
    expect(by.get(lostClaim)?.status).toBe('empty');
    expect(by.get(freshClaim)?.status).toBe('spawned');
    expect(await scheduled(t, 'imageryLive:reconcile')).toHaveLength(1);
    expect(await scheduled(t, 'imageryLive:spawn')).toHaveLength(1);
    expect(await scheduled(t, 'imageryLive:buildIndex')).toHaveLength(1);
    expect((await scheduled(t, 'broadcastToStaff'))[0]?.args[0]).toMatchObject({
      heading: '1 satellite cut failed twice',
    });
    expect((await runs(t))[0]).toMatchObject({ kind: 'reconcile', outcome: 'failed' });
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
    await t.action(internal.imageryLive.reconcile, {});
    expect((await granules(t))[0]).toMatchObject({ status: 'queued', lastError: 'exit 3' });
  });

  test('nothing spawned records nothing', async () => {
    const t = convexTest(schema, modules);
    stub(world());
    expect(await t.action(internal.imageryLive.reconcile, {})).toEqual({
      landed: 0,
      running: 0,
      requeued: 0,
      empty: 0,
      failed: 0,
    });
    expect(await runs(t)).toEqual([]);
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
    expect((await runs(t))[0]?.counts).toMatchObject({ unreadable: 2, frames: 0 });
  });

  test('a failed rebuild alerts the admins', async () => {
    const t = convexTest(schema, modules);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 403, statusText: 'Forbidden' })),
    );
    expect(await t.action(internal.imageryLive.buildIndex, {})).toBeNull();
    expect((await runs(t))[0]).toMatchObject({ kind: 'index', outcome: 'failed' });
    expect((await scheduled(t, 'broadcastToStaff'))[0]?.args[0]).toMatchObject({
      heading: 'The imagery index could not be rebuilt',
    });
  });
});

describe('activity', () => {
  test('the admin page sees runs, the ledger and the last failures', async () => {
    const t = convexTest(schema, modules);
    await queue(t, [s2('19TEA', '20261005')]);
    await queue(t, [s2('19TEB', '20261005')], { status: 'failed', lastError: 'exit 1' });
    await t.mutation(internal.imageryLive.recordRun, {
      season: SEASON,
      kind: 'poll',
      startedAt: 1,
      outcome: 'ok',
    });
    await t.run((ctx) =>
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
    const activity = await t.withIdentity({ subject: 'admin' }).query(api.imageryLive.activity, {});
    expect(activity.counts).toEqual({ queued: 1, spawned: 0, landed: 0, empty: 0, failed: 1 });
    expect(activity.failed).toEqual([{ granuleId: s2('19TEB', '20261005'), lastError: 'exit 1' }]);
    expect(activity.runs).toHaveLength(1);
    expect(activity.configured).toBe(true);
  });

  test('settleSpawn ignores a vanished row and claimForSpawn takes nothing for no room', async () => {
    const t = convexTest(schema, modules);
    const [id] = await queue(t, [s2('19TEA', '20261005')]);
    await t.run((ctx) => ctx.db.delete(id as Id<'imageryGranules'>));
    expect(
      await t.mutation(internal.imageryLive.settleSpawn, {
        id: id as Id<'imageryGranules'>,
        machineId: 'm',
      }),
    ).toBeNull();
    expect(await t.mutation(internal.imageryLive.claimForSpawn, { limit: 0 })).toEqual([]);
    expect(
      await t.mutation(internal.imageryLive.setWindowTo, {
        season: 'winter-2030-31',
        windowTo: 'x',
      }),
    ).toBeNull();
  });
});
