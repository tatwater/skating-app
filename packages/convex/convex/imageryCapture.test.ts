/**
 * **A cut's attempt, from claim to settle, and its log** (D344, D346, D348, B01-8b-2), against a
 * stubbed bucket and Fly: the attempt opened at the claim, its Machine stamped at the spawn, closed at
 * the settle with Fly's exit event and its machine time, its log (the cutter's upload merged with
 * Fly's word) copied into `runEvents`, the object deleted and the Machine destroyed — and the keep
 * rule: no Machine is destroyed before its exit is on its attempt, and stopped Machines never pile
 * up without bound.
 */

import { CUT_LOG_MAX_LINES, cutLogKey, formatCutLogLine, tileSurveyKey } from '@skating/core';
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { seasonEmailLink } from './imageryIngest';
import {
  CAPTURE_RETRY_MS,
  emptyMarkerKey,
  FAILED_LOG_DAYS,
  IMAGERY_PAGE_PATH,
  KEPT_LOG_DAYS,
  MAX_STOPPED_MACHINES,
  ORPHAN_STOPPED_MS,
  slotOf,
} from './imageryLive';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;

const SEASON = 'winter-2026-27';
const ARCHIVE = 'https://imagery.example.com';
const ENDPOINT = 'https://acct.r2.cloudflarestorage.com';
const IMAGE = 'registry.fly.io/skating-imagery:deployment-2';
const MIN = 60_000;
const DAY = 86_400_000;
const ENV = {
  IMAGERY_ARCHIVE_URL: ARCHIVE,
  R2_ACCESS_KEY_ID: 'id',
  R2_SECRET_ACCESS_KEY: 'secret',
  R2_ENDPOINT: ENDPOINT,
  FLY_API_TOKEN: 'tok',
  FLY_IMAGE: IMAGE,
};
const G = 'S2C_19TEA_20261005_0_L2A';

/** The bucket and Fly, as one stub can play them. */
interface World {
  /** Bucket objects by key: JSON values, or raw text for a log. */
  objects: Map<string, unknown>;
  /** Keys whose signed GET answers 503 (an R2 blink). */
  failingGets: Set<string>;
  deleted: string[];
  machines: Map<
    string,
    { id: string; name: string; state: string; updated_at?: string; events?: unknown[] }
  >;
  /** Fly's log lines per instance; `'forbidden'` answers 403. */
  flyLogs: Map<string, unknown[]> | 'forbidden';
  destroyed: string[];
  destroyFails: boolean;
  spawnBodies: { name: string; config: { env: Record<string, string>; auto_destroy: boolean } }[];
  nextId: number;
}

function world(): World {
  return {
    objects: new Map<string, unknown>([
      [`masks/${SEASON}.json`, { season: SEASON, bodies: 10, waterMasks: true }],
      [
        `masks/${SEASON}-search.json`,
        {
          season: SEASON,
          surveyKey: tileSurveyKey(SEASON, 10),
          bbox: [0, 0, 1, 1],
          emptyTiles: [],
        },
      ],
    ]),
    failingGets: new Set(),
    deleted: [],
    machines: new Map(),
    flyLogs: new Map(),
    destroyed: [],
    destroyFails: false,
    spawnBodies: [],
    nextId: 1,
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function stub(w: World) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: Request | string, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const url = new URL(req.url);
      if (req.url.startsWith(ARCHIVE)) {
        const found = w.objects.get(url.pathname.slice(1));
        return found === undefined ? new Response('', { status: 404 }) : json(found);
      }
      if (req.url.startsWith(ENDPOINT)) {
        const key = decodeURIComponent(url.pathname.replace('/skating-imagery/', ''));
        if (req.method === 'DELETE') {
          w.deleted.push(key);
          w.objects.delete(key);
          return new Response(null, { status: 204 });
        }
        if (w.failingGets.has(key)) return new Response('', { status: 503, statusText: 'Down' });
        const found = w.objects.get(key);
        if (found === undefined) return new Response(null, { status: 404 });
        if (req.method === 'HEAD') return new Response(null);
        return new Response(typeof found === 'string' ? found : JSON.stringify(found));
      }
      if (url.host === 'api.fly.io') {
        if (w.flyLogs === 'forbidden') return new Response('', { status: 403, statusText: 'No' });
        const instance = url.searchParams.get('instance') ?? '';
        return json({ data: w.flyLogs.get(instance) ?? [] });
      }
      if (url.host === 'api.machines.dev') {
        const id = url.pathname.split('/machines/')[1];
        if (req.method === 'POST') {
          const body = JSON.parse(await req.text());
          w.spawnBodies.push(body);
          const mid = `m${w.nextId++}`;
          w.machines.set(mid, { id: mid, name: body.name, state: 'started' });
          return json({ id: mid });
        }
        if (req.method === 'DELETE') {
          if (w.destroyFails) return new Response('', { status: 500, statusText: 'Err' });
          w.destroyed.push(id as string);
          w.machines.delete(id as string);
          return new Response('{}');
        }
        if (id) {
          const m = w.machines.get(id);
          return m ? json(m) : new Response('', { status: 404 });
        }
        return json([...w.machines.values()]);
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

async function openSeason(t: T, fields: Partial<Doc<'imageryIngestSeasons'>> = {}) {
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

async function queue(t: T, id: string, fields: Partial<Doc<'imageryGranules'>> = {}) {
  return await t.run((ctx) =>
    ctx.db.insert('imageryGranules', {
      granuleId: id,
      slot: slotOf(id)?.slot ?? id,
      mission: 's2',
      season: SEASON,
      capturedAt: '2026-10-05T15:30:00Z',
      status: 'queued',
      attempts: 0,
      queuedAt: Date.now(),
      ...fields,
    }),
  );
}

const pump = (t: T) => t.action(internal.imageryLive.pump, {});
const attempts = (t: T) => t.run((ctx) => ctx.db.query('imageryAttempts').collect());
const granuleRow = (t: T, id: Id<'imageryGranules'>) => t.run((ctx) => ctx.db.get(id));
const lines = (t: T, attemptId: Id<'imageryAttempts'>) =>
  t.run(async (ctx) =>
    (
      await ctx.db
        .query('runEvents')
        .withIndex('by_attempt_seq', (q) => q.eq('attemptId', attemptId))
        .collect()
    ).map((e) => ({
      seq: e.seq,
      origin: e.origin,
      kind: e.kind,
      text: e.text,
      keepUntil: e.keepUntil,
    })),
  );
const counts = (t: T) => t.run((ctx) => ctx.db.query('imageryCounts').first());
const pumpRow = (t: T) =>
  t.run(async (ctx) => (await ctx.db.query('imageryPump').collect()).find((r) => r.key === 'pump'));

/** A cutter log, stamped as the tee stamps it, from `start` (ms) one line a second. */
const cutterLog = (start: number, texts: string[]) =>
  texts.map((text, i) => formatCutLogLine(start + i * 1000, text)).join('\n');

/** Stop Machine `id` with an exit event (and its start), as Fly keeps a finished one. */
function exitMachine(
  w: World,
  id: string,
  exit: { code?: number; oom?: boolean; startedAt: number; exitedAt: number },
) {
  const m = w.machines.get(id);
  if (!m) throw new Error(`no machine ${id}`);
  m.state = 'stopped';
  m.updated_at = new Date(exit.exitedAt).toISOString();
  m.events = [
    {
      type: 'exit',
      timestamp: exit.exitedAt,
      request: {
        exit_event: {
          ...(exit.code !== undefined ? { exit_code: exit.code } : {}),
          ...(exit.oom !== undefined ? { oom_killed: exit.oom } : {}),
          exited_at: new Date(exit.exitedAt).toISOString(),
        },
      },
    },
    { type: 'start', timestamp: exit.startedAt },
  ];
}

/** Queue one granule and spawn it: the attempt and its Machine. */
async function spawnOne(t: T, _w: World, fields: Partial<Doc<'imageryGranules'>> = {}) {
  const gid = await queue(t, G, fields);
  await pump(t);
  const [attempt] = (await attempts(t)).filter((a) => a.granuleRowId === gid).slice(-1);
  if (!attempt?.machineId) throw new Error('no spawn');
  return { gid, attempt, machineId: attempt.machineId };
}

describe('the attempt, from claim to spawn', () => {
  test('a claim opens an attempt; the spawn stamps its Machine and passes the log key', async () => {
    const t = convexTest(schema, modules);
    await openSeason(t);
    const w = world();
    stub(w);
    const { gid, attempt, machineId } = await spawnOne(t, w);
    expect(attempt).toMatchObject({
      granuleRowId: gid,
      granuleId: G,
      season: SEASON,
      attempt: 1,
      machineName: 'granule-s2c-19tea-20261005-0-l2a',
      machineId,
      image: IMAGE,
      verdict: 'cutting',
      log: 'pending',
    });
    expect(Math.abs(attempt.spawnedAt - Date.now())).toBeLessThan(1_000);
    // The Machine is kept on exit, and told where to upload its log.
    expect(w.spawnBodies[0]?.config.auto_destroy).toBe(false);
    expect(w.spawnBodies[0]?.config.env).toMatchObject({
      CUT_LOG_KEY: cutLogKey(SEASON, G, 1),
      CUT_ATTEMPT: '1',
    });
    // The pump's row: the live count it saw and the image, first seen now.
    expect(await pumpRow(t)).toMatchObject({
      liveMachines: 0,
      liveMachinesAt: expect.any(Number),
      image: IMAGE,
      imageSeenAt: attempt.spawnedAt,
    });
  });

  test('a new image is recorded when it first spawns; the same one keeps its first sighting', async () => {
    const t = convexTest(schema, modules);
    await openSeason(t);
    const w = world();
    stub(w);
    const { attempt } = await spawnOne(t, w);
    const first = attempt.spawnedAt;
    vi.advanceTimersByTime(10 * MIN);
    await queue(t, 'S2C_19TEB_20261005_0_L2A');
    await pump(t);
    expect((await pumpRow(t))?.imageSeenAt).toBe(first);
    vi.stubEnv('FLY_IMAGE', `${IMAGE}-next`);
    vi.advanceTimersByTime(10 * MIN);
    await queue(t, 'S2C_19TEC_20261005_0_L2A');
    await pump(t);
    const row = await pumpRow(t);
    expect(row?.image).toBe(`${IMAGE}-next`);
    expect(row?.imageSeenAt).toBeGreaterThan(first);
  });

  test('a refused spawn closes its attempt refused, with no log; an untried claim leaves none', async () => {
    const t = convexTest(schema, modules);
    await openSeason(t);
    const w = world();
    stub(w);
    const fetchFn = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: Request | string, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input, init);
        if (req.url.includes('api.machines.dev') && req.method === 'POST') {
          return new Response('no room', { status: 422, statusText: 'Unprocessable' });
        }
        return fetchFn(req);
      }),
    );
    // Four queued: three refusals trip the breaker, and the fourth claim goes back untried.
    for (const c of ['A', 'B', 'C', 'D']) await queue(t, `S2C_19TE${c}_20261005_0_L2A`);
    await pump(t);
    const rows = await attempts(t);
    expect(rows.map((a) => a.verdict)).toEqual(['refused', 'refused', 'refused']);
    expect(rows.every((a) => a.log === 'none' && a.settledAt !== undefined)).toBe(true);
    expect(rows[0]?.error).toMatch(/Fly spawn .+: 422/);
    // A refusal spends a number: the next try of that granule is attempt 2, never a reuse.
    vi.advanceTimersByTime(31 * MIN);
    vi.stubGlobal('fetch', fetchFn);
    await pump(t);
    const next = (await attempts(t)).filter((a) => a.granuleId === rows[0]?.granuleId);
    expect(next.map((a) => a.attempt)).toEqual([1, 2]);
    expect(next[1]?.machineName).toBe('granule-s2c-19tea-20261005-0-l2a-r2');
  });

  test('numbers continue past a granule tried before attempts, and past Retry failed', async () => {
    const t = convexTest(schema, modules);
    await openSeason(t);
    const w = world();
    stub(w);
    // Tried once before attempts were recorded, then requeued: its first recorded try is attempt 2.
    const { attempt } = await spawnOne(t, w, { attempts: 1 });
    expect(attempt.attempt).toBe(2);
  });
});

describe('the settle and the capture', () => {
  test('a cut killed by OOM: exit 137 recorded, Fly’s lines kept, failed, its log open 200 days', async () => {
    const t = convexTest(schema, modules);
    await openSeason(t, { imageryPausedAt: undefined });
    const w = world();
    stub(w);
    // Its second attempt (the first missed): an OOM on this one fails the granule.
    const { gid, attempt, machineId } = await spawnOne(t, w, { attempts: 1 });
    const t0 = Date.now();
    w.objects.set(
      cutLogKey(SEASON, G, attempt.attempt),
      cutterLog(t0 + 5_000, ['start S2C_19TEA', 'gdalwarp: 0...10...20', 'exit 137']),
    );
    exitMachine(w, machineId, {
      code: 137,
      oom: true,
      startedAt: t0 + 4_000,
      exitedAt: t0 + 64_000,
    });
    (w.flyLogs as Map<string, unknown[]>).set(machineId, [
      {
        attributes: {
          timestamp: new Date(t0 + 63_000).toISOString(),
          message: 'Out of memory: Killed process 412 (gdalwarp)',
          instance: machineId,
          meta: { event: { provider: 'runner' } },
        },
      },
    ]);
    vi.advanceTimersByTime(4 * MIN);
    expect(await pump(t)).toMatchObject({ failed: 1, captured: 1, destroyed: 1 });
    expect(await granuleRow(t, gid)).toMatchObject({
      status: 'failed',
      lastError: 'exit 137 · out of memory',
    });
    const [a] = await attempts(t);
    expect(a).toMatchObject({
      verdict: 'failed',
      exitCode: 137,
      oomKilled: true,
      startedAt: t0 + 4_000,
      exitedAt: t0 + 64_000,
      machineMs: 60_000,
      machineMsFrom: 'fly',
      log: 'kept',
      error: 'exit 137 · out of memory',
    });
    const log = await lines(t, a?._id as Id<'imageryAttempts'>);
    expect(log.map((l) => [l.origin, l.kind, l.text])).toEqual([
      [
        'pump',
        'stage',
        `Asked Fly for granule-s2c-19tea-20261005-0-l2a-r2 on shared-cpu-4x/2048MB · ${IMAGE}`,
      ],
      ['cutter', 'line', 'start S2C_19TEA'],
      ['cutter', 'line', 'gdalwarp: 0...10...20'],
      ['cutter', 'fail', 'exit 137'],
      ['fly', 'fail', 'Out of memory: Killed process 412 (gdalwarp)'],
      ['fly', 'fail', 'exit 137 · out of memory'],
      ['pump', 'fail', 'Settled failed: exit 137 · out of memory'],
    ]);
    expect(log.every((l) => l.keepUntil === (a?.settledAt ?? 0) + FAILED_LOG_DAYS * DAY)).toBe(
      true,
    );
    // The exit was on the attempt; Fly's lines were read while it still had the Machine; then the
    // Machine went, and the copied object.
    const order = (
      globalThis.fetch as unknown as { mock: { calls: [Request | string, RequestInit?][] } }
    ).mock.calls.map(
      ([r, i]) =>
        `${r instanceof Request ? r.method : (i?.method ?? 'GET')} ${String(r instanceof Request ? r.url : r)}`,
    );
    const at = (re: RegExp) => order.findIndex((c) => re.test(c));
    expect(at(/api\.fly\.io/)).toBeGreaterThanOrEqual(0);
    expect(at(/api\.fly\.io/)).toBeLessThan(at(/^DELETE https:\/\/api\.machines\.dev/));
    expect(w.destroyed).toEqual([machineId]);
    expect(w.deleted).toEqual([cutLogKey(SEASON, G, attempt.attempt)]);
    expect((await counts(t))?.machineMs).toBe(60_000);
  });

  test('a cut whose VM vanished: no exit event, Fly’s runner lines only, requeued on a first miss', async () => {
    const t = convexTest(schema, modules);
    await openSeason(t);
    const w = world();
    stub(w);
    const { gid, attempt, machineId } = await spawnOne(t, w);
    const t0 = Date.now();
    // Fly no longer knows the Machine: a 404, no exit. The upload never came (killed before it).
    w.machines.delete(machineId);
    (w.flyLogs as Map<string, unknown[]>).set(machineId, [
      {
        attributes: {
          timestamp: new Date(t0 + 30_000).toISOString(),
          message: 'Process appears to have been OOM killed!',
          instance: machineId,
          meta: { event: { provider: 'runner' } },
        },
      },
      {
        attributes: {
          timestamp: new Date(t0 + 29_000).toISOString(),
          message: 'gdalwarp: 0...10',
          instance: machineId,
          meta: { event: { provider: 'app' } },
        },
      },
    ]);
    // Pause, so the requeued granule isn't spawned again in the same run.
    await t.run(async (ctx) => {
      const row = await ctx.db.query('imageryIngestSeasons').first();
      await ctx.db.patch((row as Doc<'imageryIngestSeasons'>)._id, { imageryPausedAt: Date.now() });
    });
    vi.advanceTimersByTime(4 * MIN);
    expect(await pump(t)).toMatchObject({ requeued: 1, captured: 1, destroyed: 0 });
    expect((await granuleRow(t, gid))?.status).toBe('queued');
    const [a] = await attempts(t);
    expect(a).toMatchObject({ verdict: 'requeued', log: 'none', machineMsFrom: 'settle' });
    expect(a?.exitCode).toBeUndefined();
    expect(a?.oomKilled).toBeUndefined();
    const log = await lines(t, a?._id as Id<'imageryAttempts'>);
    expect(log.map((l) => [l.origin, l.text])).toEqual([
      ['pump', expect.stringMatching(/^Asked Fly for granule-/)],
      ['pump', "The cutter didn't upload a log: its image may be from before logs were kept"],
      ['fly', 'gdalwarp: 0...10'],
      ['fly', 'Process appears to have been OOM killed!'],
      ['pump', 'Settled: no frame, so it goes back in line for another attempt'],
    ]);
    // Nothing to destroy (Fly has no Machine), nothing to delete (no object).
    expect(w.destroyed).toEqual([]);
    expect(w.deleted).toEqual([]);
    void attempt;
  });

  test('a landed cut waits for its Machine to exit, then keeps its log collapsed a month', async () => {
    const t = convexTest(schema, modules);
    await openSeason(t, { imageryPausedAt: undefined });
    const w = world();
    stub(w);
    const { gid, attempt, machineId } = await spawnOne(t, w);
    const t0 = Date.now();
    w.objects.set(`frames/${SEASON}/${G}.json`, { granuleId: G });
    w.objects.set(
      cutLogKey(SEASON, G, 1),
      cutterLog(t0 + 1_000, ['start', 'uploaded the manifest', 'exit 0']),
    );
    vi.advanceTimersByTime(4 * MIN);
    // The frame is there, but the Machine is still live: it waits.
    expect(await pump(t)).toMatchObject({ running: 1, landed: 0 });
    exitMachine(w, machineId, { code: 0, oom: false, startedAt: t0 + 500, exitedAt: t0 + 3_500 });
    vi.advanceTimersByTime(3 * MIN);
    expect(await pump(t)).toMatchObject({ landed: 1, captured: 1, destroyed: 1 });
    expect((await granuleRow(t, gid))?.status).toBe('landed');
    const [a] = await attempts(t);
    expect(a).toMatchObject({ verdict: 'landed', exitCode: 0, machineMs: 3_000, log: 'kept' });
    const log = await lines(t, a?._id as Id<'imageryAttempts'>);
    expect(log.at(-1)).toMatchObject({ origin: 'pump', text: 'Settled: the frame landed' });
    expect(log[0]?.keepUntil).toBe((a?.settledAt ?? 0) + KEPT_LOG_DAYS * DAY);
    // A landed cut doesn't ask Fly for its lines.
    const calls = (globalThis.fetch as unknown as { mock: { calls: [Request | string][] } }).mock
      .calls;
    expect(
      calls.some(([r]) => String(r instanceof Request ? r.url : r).includes('api.fly.io')),
    ).toBe(false);
    void attempt;
  });

  test('a landed cut whose Machine hangs past the wait lands anyway, and its Machine is left live', async () => {
    const t = convexTest(schema, modules);
    await openSeason(t, { imageryPausedAt: undefined });
    const w = world();
    stub(w);
    const { gid } = await spawnOne(t, w);
    w.objects.set(`frames/${SEASON}/${G}.json`, { granuleId: G });
    vi.advanceTimersByTime(16 * MIN);
    expect(await pump(t)).toMatchObject({ landed: 1, destroyed: 0 });
    expect((await granuleRow(t, gid))?.status).toBe('landed');
    expect(w.destroyed).toEqual([]);
  });

  test('an empty cut copies its marker’s reason onto the granule and its log', async () => {
    const t = convexTest(schema, modules);
    await openSeason(t, { imageryPausedAt: undefined });
    const w = world();
    stub(w);
    const { gid, machineId } = await spawnOne(t, w);
    const t0 = Date.now();
    w.objects.set(emptyMarkerKey(SEASON, G), {
      granuleId: G,
      reason: 'no lake inside the imaged footprint',
    });
    w.objects.set(cutLogKey(SEASON, G, 1), cutterLog(t0, ['start', 'nothing to cut', 'exit 0']));
    exitMachine(w, machineId, { code: 0, startedAt: t0, exitedAt: t0 + 2_000 });
    vi.advanceTimersByTime(4 * MIN);
    expect(await pump(t)).toMatchObject({ empty: 1, captured: 1 });
    expect(await granuleRow(t, gid)).toMatchObject({
      status: 'empty',
      emptyReason: 'no lake inside the imaged footprint',
    });
    const [a] = await attempts(t);
    const log = await lines(t, a?._id as Id<'imageryAttempts'>);
    expect(log.at(-1)?.text).toBe('Settled: nothing to cut · no lake inside the imaged footprint');
  });

  test('an old image with no log: none, with Fly’s exit and lines kept', async () => {
    const t = convexTest(schema, modules);
    await openSeason(t, { imageryPausedAt: undefined });
    const w = world();
    stub(w);
    const { machineId } = await spawnOne(t, w, { attempts: 1 });
    const t0 = Date.now();
    exitMachine(w, machineId, { code: 1, startedAt: t0, exitedAt: t0 + 20_000 });
    vi.advanceTimersByTime(4 * MIN);
    await pump(t);
    const [a] = await attempts(t);
    expect(a).toMatchObject({ verdict: 'failed', log: 'none', exitCode: 1, machineMsFrom: 'fly' });
    const log = await lines(t, a?._id as Id<'imageryAttempts'>);
    expect(log.map((l) => l.text)).toContain('exit 1');
    expect(w.destroyed).toEqual([machineId]);
  });

  test('Fly’s log API refused: the exit is kept, and the log says the lines couldn’t be read', async () => {
    const t = convexTest(schema, modules);
    await openSeason(t, { imageryPausedAt: undefined });
    const w = world();
    w.flyLogs = 'forbidden';
    stub(w);
    const { machineId } = await spawnOne(t, w, { attempts: 1 });
    const t0 = Date.now();
    w.objects.set(cutLogKey(SEASON, G, 2), cutterLog(t0, ['start', 'exit 2']));
    exitMachine(w, machineId, { code: 2, startedAt: t0, exitedAt: t0 + 1_000 });
    vi.advanceTimersByTime(4 * MIN);
    await pump(t);
    const [a] = await attempts(t);
    expect(a).toMatchObject({ verdict: 'failed', log: 'kept', exitCode: 2 });
    const log = await lines(t, a?._id as Id<'imageryAttempts'>);
    expect(
      log.some((l) => /Fly's own log lines couldn't be read: Fly logs .+: 403/.test(l.text)),
    ).toBe(true);
  });

  test('a capture that fails is retried next run, then copied; past an hour it is missing', async () => {
    const t = convexTest(schema, modules);
    await openSeason(t, { imageryPausedAt: undefined });
    const w = world();
    stub(w);
    const { gid, machineId } = await spawnOne(t, w, { attempts: 1 });
    const t0 = Date.now();
    const key = cutLogKey(SEASON, G, 2);
    w.objects.set(key, cutterLog(t0, ['start', 'exit 1']));
    w.failingGets.add(key);
    exitMachine(w, machineId, { code: 1, startedAt: t0, exitedAt: t0 + 1_000 });
    vi.advanceTimersByTime(4 * MIN);
    expect(await pump(t)).toMatchObject({ failed: 1, captured: 0, capturesOwed: 1 });
    // The verdict and the exit are kept, and — the exit being on the attempt — the Machine is gone.
    const [owed] = await attempts(t);
    expect(owed).toMatchObject({ verdict: 'failed', exitCode: 1, log: 'pending' });
    expect(w.destroyed).toEqual([machineId]);
    expect(w.deleted).toEqual([]);
    expect((await granuleRow(t, gid))?.status).toBe('failed');
    // R2 is back: the next run (it has work: a capture owed) copies it and deletes the object.
    w.failingGets.clear();
    vi.advanceTimersByTime(3 * MIN);
    expect(await pump(t)).toMatchObject({ captured: 1, capturesOwed: 0 });
    const [kept] = await attempts(t);
    expect(kept?.log).toBe('kept');
    expect((await lines(t, kept?._id as Id<'imageryAttempts'>)).map((l) => l.text)).toContain(
      'exit 1',
    );
    expect(w.deleted).toEqual([key]);

    // Another that never reads: missing after an hour, and its object left for the bucket's rule.
    await t.run((ctx) => ctx.db.delete(gid));
    const g2 = 'S2C_19TEB_20261005_0_L2A';
    const second = await queue(t, g2, { attempts: 1 });
    await pump(t);
    const a2 = (await attempts(t)).find((a) => a.granuleRowId === second) as Doc<'imageryAttempts'>;
    const key2 = cutLogKey(SEASON, g2, a2.attempt);
    w.objects.set(key2, cutterLog(Date.now(), ['exit 1']));
    w.failingGets.add(key2);
    exitMachine(w, a2.machineId as string, {
      code: 1,
      startedAt: Date.now(),
      exitedAt: Date.now(),
    });
    vi.advanceTimersByTime(4 * MIN);
    await pump(t);
    vi.advanceTimersByTime(CAPTURE_RETRY_MS + MIN);
    await pump(t);
    expect((await t.run((ctx) => ctx.db.get(a2._id)))?.log).toBe('missing');
    expect(w.deleted).not.toContain(key2);
  });

  test('a capture retried after a partial write never doubles a line, and drops a longer try’s tail', async () => {
    const t = convexTest(schema, modules);
    await openSeason(t);
    const w = world();
    stub(w);
    const { attempt } = await spawnOne(t, w);
    const line = (i: number) => ({
      origin: 'cutter' as const,
      kind: 'line' as const,
      loggedAt: i,
      text: `l${i}`,
    });
    const chunk = (from: number, n: number) => Array.from({ length: n }, (_, i) => line(from + i));
    const write = (from: number, n: number) =>
      t.mutation(internal.imageryLive.appendAttemptLines, {
        attemptId: attempt._id,
        from,
        lines: chunk(from, n),
        keepUntil: 1,
      });
    // A first try wrote two chunks of 500 and died; the retry writes all three, then closes at 1,200.
    await write(0, 500);
    await write(500, 500);
    await write(0, 500);
    await write(500, 500);
    await write(1_000, 200);
    // An even earlier, longer try had left a line past the end.
    await t.run((ctx) =>
      ctx.db.insert('runEvents', {
        attemptId: attempt._id,
        seq: 1_400,
        at: 0,
        loggedAt: 0,
        kind: 'line',
        text: 'stale',
        keepUntil: 1,
      }),
    );
    await t.mutation(internal.imageryLive.closeAttemptLog, {
      attemptId: attempt._id,
      log: 'kept',
      total: 1_200,
    });
    const log = await lines(t, attempt._id);
    expect(log).toHaveLength(1_200);
    expect(new Set(log.map((l) => l.seq)).size).toBe(1_200);
    // Closed: a late chunk writes nothing more; and no chunk may be over 500 lines.
    await write(1_200, 10);
    expect(await lines(t, attempt._id)).toHaveLength(1_200);
    await t.run((ctx) => ctx.db.patch(attempt._id, { log: 'pending' }));
    await expect(write(0, 501)).rejects.toThrow(/over 500/);
  });

  test(`a log past the cap keeps ${CUT_LOG_MAX_LINES} lines with its end`, async () => {
    const t = convexTest(schema, modules);
    await openSeason(t, { imageryPausedAt: undefined });
    const w = world();
    stub(w);
    const { machineId, attempt } = await spawnOne(t, w, { attempts: 1 });
    const t0 = Date.now();
    w.objects.set(
      cutLogKey(SEASON, G, attempt.attempt),
      cutterLog(t0, [...Array.from({ length: 2_400 }, (_, i) => `line ${i}`), 'exit 1']),
    );
    exitMachine(w, machineId, { code: 1, startedAt: t0, exitedAt: t0 + 2_401_000 });
    vi.advanceTimersByTime(4 * MIN);
    await pump(t);
    const [a] = await attempts(t);
    const log = await lines(t, a?._id as Id<'imageryAttempts'>);
    expect(log).toHaveLength(CUT_LOG_MAX_LINES);
    expect(log.some((l) => /lines in the middle of this log weren't kept/.test(l.text))).toBe(true);
    expect(log.map((l) => l.text)).toEqual(expect.arrayContaining(['exit 1', 'line 2399']));
  });
});

describe('the keep rule: Machines kept until the pump reads them', () => {
  test('a Machine left stopped by a pump that was down is destroyed on its next tick, its exit read first', async () => {
    const t = convexTest(schema, modules);
    await openSeason(t, { imageryPausedAt: undefined });
    const w = world();
    stub(w);
    const { gid, machineId } = await spawnOne(t, w);
    const t0 = Date.now();
    // The settle couldn't reach Fly (it was down), so the frame landed with no exit on the attempt.
    w.objects.set(`frames/${SEASON}/${G}.json`, { granuleId: G });
    const fetchFn = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: Request | string, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input, init);
        if (req.url.includes(`/machines/${machineId}`)) return new Response('', { status: 502 });
        return fetchFn(req);
      }),
    );
    vi.advanceTimersByTime(4 * MIN);
    await pump(t);
    expect((await granuleRow(t, gid))?.status).toBe('landed');
    expect((await attempts(t))[0]?.exitCode).toBeUndefined();
    expect(w.destroyed).toEqual([]);
    // Fly is back, the Machine stopped: the sweep reads its exit onto the attempt, then destroys it.
    vi.stubGlobal('fetch', fetchFn);
    exitMachine(w, machineId, { code: 0, oom: false, startedAt: t0, exitedAt: t0 + 9_000 });
    await queue(t, 'S2C_19TEB_20261005_0_L2A'); // the next tick has work
    vi.advanceTimersByTime(3 * MIN);
    expect(await pump(t)).toMatchObject({ destroyed: 1 });
    expect((await attempts(t))[0]).toMatchObject({ exitCode: 0, exitedAt: t0 + 9_000 });
    expect(w.destroyed).toEqual([machineId]);
  });

  test('never destroys a stopped Machine whose attempt is still open', async () => {
    const t = convexTest(schema, modules);
    await openSeason(t, { imageryPausedAt: undefined });
    const w = world();
    stub(w);
    const { machineId } = await spawnOne(t, w);
    // Stopped, but every check fails (the bucket is down): the attempt stays open, so the sweep
    // leaves the Machine for the settle.
    exitMachine(w, machineId, { code: 0, startedAt: Date.now(), exitedAt: Date.now() + 1_000 });
    const fetchFn = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: Request | string, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input, init);
        if (req.url.startsWith(ENDPOINT) && req.method === 'HEAD') {
          return new Response('', { status: 503 });
        }
        return fetchFn(req);
      }),
    );
    vi.advanceTimersByTime(4 * MIN);
    expect(await pump(t)).toMatchObject({ unknown: 1, destroyed: 0, stopped: 1 });
    expect(w.destroyed).toEqual([]);
    expect((await attempts(t))[0]?.verdict).toBe('cutting');
  });

  test('a stopped cut Machine no attempt claims is destroyed only after an hour stopped', async () => {
    const t = convexTest(schema, modules);
    await openSeason(t, { imageryPausedAt: undefined });
    const w = world();
    w.machines.set('orphan', {
      id: 'orphan',
      name: 'granule-s2c-old',
      state: 'stopped',
      updated_at: new Date(Date.now() - 30 * MIN).toISOString(),
    });
    w.machines.set('other', {
      id: 'other',
      name: 'ors',
      state: 'stopped',
      updated_at: '2020-01-01T00:00:00Z',
    });
    stub(w);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await queue(t, G);
    await pump(t);
    expect(w.destroyed).toEqual([]);
    vi.advanceTimersByTime(ORPHAN_STOPPED_MS);
    await queue(t, 'S2C_19TEB_20261005_0_L2A');
    await pump(t);
    // Only the cut Machine: another app's Machine is never the pump's.
    expect(w.destroyed).toEqual(['orphan']);
  });

  test('a Machine whose destroy failed is cleared later even when nothing is queued or cutting', async () => {
    const t = convexTest(schema, modules);
    const season = await openSeason(t, { imageryPausedAt: undefined });
    const w = world();
    stub(w);
    const { gid, machineId } = await spawnOne(t, w);
    const t0 = Date.now();
    w.objects.set(`frames/${SEASON}/${G}.json`, { granuleId: G });
    exitMachine(w, machineId, { code: 0, oom: false, startedAt: t0, exitedAt: t0 + 9_000 });
    // The settle reads the exit, but Fly won't destroy: the Machine is left stopped.
    w.destroyFails = true;
    vi.advanceTimersByTime(4 * MIN);
    await pump(t);
    expect((await granuleRow(t, gid))?.status).toBe('landed');
    expect(w.machines.has(machineId)).toBe(true);
    expect((await pumpRow(t))?.stoppedMachines).toBe(1);
    // Paused, nothing queued, nothing cutting, no log owed: the tick still lists and clears it.
    await t.run((ctx) => ctx.db.patch(season, { imageryPausedAt: Date.now() }));
    w.destroyFails = false;
    vi.advanceTimersByTime(3 * MIN);
    expect(await pump(t)).toMatchObject({ destroyed: 1, stopped: 0 });
    expect(w.destroyed).toEqual([machineId]);
    expect((await pumpRow(t))?.stoppedMachines).toBe(0);
    // And then the pump is quiet again: nothing to do, no listing.
    vi.advanceTimersByTime(3 * MIN);
    expect(await pump(t)).toEqual({ skipped: 'nothing to do' });
  });

  test(`past ${MAX_STOPPED_MACHINES} stopped cut Machines it can't clear, no new cut starts`, async () => {
    const t = convexTest(schema, modules);
    await openSeason(t, { imageryPausedAt: undefined });
    const w = world();
    w.destroyFails = true;
    for (let i = 0; i < MAX_STOPPED_MACHINES; i++) {
      w.machines.set(`s${i}`, {
        id: `s${i}`,
        name: `granule-x${i}`,
        state: 'stopped',
        updated_at: new Date(Date.now() - 2 * ORPHAN_STOPPED_MS).toISOString(),
      });
    }
    stub(w);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await queue(t, G);
    expect(await pump(t)).toMatchObject({ spawned: 0, stopped: MAX_STOPPED_MACHINES });
    expect(w.spawnBodies).toEqual([]);
    const alerts = await t.run(async (ctx) =>
      (await ctx.db.system.query('_scheduled_functions').collect()).filter((j) =>
        j.name.includes('broadcastToStaff'),
      ),
    );
    expect(alerts[0]?.args[0]).toMatchObject({
      heading: 'Finished satellite cuts are not being cleared',
    });
    // Destroys work again: the sweep clears them (25 a run), and cuts start once under the bound.
    w.destroyFails = false;
    vi.advanceTimersByTime(3 * MIN);
    await pump(t);
    expect(w.destroyed).toHaveLength(25);
    expect(w.spawnBodies).toHaveLength(1);
  });
});

describe('the poll', () => {
  test('stores when the catalog published each pass', async () => {
    const t = convexTest(schema, modules);
    await openSeason(t);
    const w = world();
    stub(w);
    const fetchFn = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: Request | string, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input, init);
        if (new URL(req.url).host === 'earth-search.aws.element84.com') {
          const body = JSON.parse(await req.text()) as { collections: string[] };
          return json({
            features:
              body.collections[0] === 'sentinel-2-l2a'
                ? [
                    {
                      id: G,
                      properties: {
                        datetime: '2026-10-05T15:30:00Z',
                        created: '2026-10-06T01:14:00Z',
                      },
                    },
                  ]
                : [],
            links: [],
          });
        }
        return fetchFn(req);
      }),
    );
    await t.action(internal.imageryLive.poll, {});
    const [g] = await t.run((ctx) => ctx.db.query('imageryGranules').collect());
    expect(g?.catalogedAt).toBe(Date.parse('2026-10-06T01:14:00Z'));
    // The follow-on pump is a manual run, never a cron one (Ma27 (b)).
    const jobs = await t.run(async (ctx) =>
      (await ctx.db.system.query('_scheduled_functions').collect()).filter((j) =>
        j.name.includes('tickAction'),
      ),
    );
    expect(jobs[0]?.args[0]).toMatchObject({ trigger: 'manual' });
  });
});

describe('the emails send people to Machinery › Imagery', () => {
  test('every imagery alert’s link, and no sentence naming the Seasons page', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.imageryLive.alertAdmins, {
      key: 'k',
      season: SEASON,
      problem: 'p',
      detail: 'd',
    });
    const [job] = await t.run(async (ctx) =>
      (await ctx.db.system.query('_scheduled_functions').collect()).filter((j) =>
        j.name.includes('broadcastToStaff'),
      ),
    );
    expect(job?.args[0]).toMatchObject({ deepLinkPath: IMAGERY_PAGE_PATH });
    expect(JSON.stringify(job?.args[0])).toContain('the **Imagery** page in Machinery');
    expect(JSON.stringify(job?.args[0])).not.toMatch(/Seasons/);
  });

  test('the season emails that ask for Start open the Imagery page; the watch’s news stays', () => {
    expect(seasonEmailLink('opened')).toBe('/admin/machinery/imagery');
    expect(seasonEmailLink('imagery')).toBe('/admin/machinery/imagery');
    expect(seasonEmailLink('winter')).toBe('/admin/seasons');
    expect(seasonEmailLink('closed')).toBe('/admin/seasons');
  });
});
