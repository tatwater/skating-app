import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createCutMachine,
  destroyMachine,
  exitCodeOf,
  FLY_GUEST,
  flyConfigFromEnv,
  getMachine,
  listMachines,
  liveCutMachines,
  machineLogs,
  machineName,
  machineRunOf,
} from './fly';

const config = {
  token: 'tok',
  app: 'skating-imagery',
  image: 'registry.fly.io/skating-imagery:deployment-1',
  region: 'sjc',
};

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('flyConfigFromEnv', () => {
  it('names what is missing', () => {
    expect(flyConfigFromEnv({})).toEqual({ ok: false, missing: ['FLY_API_TOKEN', 'FLY_IMAGE'] });
  });
  it('defaults the app and region to fan-out.sh’s', () => {
    expect(flyConfigFromEnv({ FLY_API_TOKEN: 't', FLY_IMAGE: 'i' })).toEqual({
      ok: true,
      config: { token: 't', image: 'i', app: 'skating-imagery', region: 'sjc' },
    });
    expect(
      flyConfigFromEnv({ FLY_API_TOKEN: 't', FLY_IMAGE: 'i', FLY_APP: 'a', FLY_REGION: 'ewr' }),
    ).toMatchObject({
      config: { app: 'a', region: 'ewr' },
    });
  });
  it('points both of Fly’s hosts at a stand-in when FLY_API_URL is set (a proof)', () => {
    expect(
      flyConfigFromEnv({ FLY_API_TOKEN: 't', FLY_IMAGE: 'i', FLY_API_URL: 'http://127.0.0.1:9/' }),
    ).toMatchObject({
      config: { apiBase: 'http://127.0.0.1:9', logsBase: 'http://127.0.0.1:9' },
    });
  });
});

describe('machines', () => {
  it('names a cut as fan-out.sh does, with a retry suffix', () => {
    expect(machineName('S2C_19TEM_20251101_0_L2A', 1)).toBe('granule-s2c-19tem-20251101-0-l2a');
    expect(machineName('S2C_19TEM_20251101_0_L2A', 2)).toBe('granule-s2c-19tem-20251101-0-l2a-r2');
  });

  it('spawns with fan-out.sh’s exact configuration', async () => {
    const fetchMock = vi.fn(async () => json({ id: 'm1' }));
    vi.stubGlobal('fetch', fetchMock);
    const id = await createCutMachine(config, {
      granuleId: 'S2C_19TEM_20261005_0_L2A',
      maskSeason: 'winter-2026-27',
      attempt: 1,
      logKey: 'logs/cuts/winter-2026-27/S2C_19TEM_20261005_0_L2A/a1.log',
    });
    expect(id).toBe('m1');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.machines.dev/v1/apps/skating-imagery/machines');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body as string)).toEqual({
      name: 'granule-s2c-19tem-20261005-0-l2a',
      region: 'sjc',
      config: {
        image: config.image,
        guest: FLY_GUEST,
        // Kept stopped on exit, so the pump can read the exit event (D348); it destroys it after.
        auto_destroy: false,
        restart: { policy: 'no' },
        env: {
          MASK_SEASON: 'winter-2026-27',
          FLY_VM_SIZE_LABEL: 'shared-cpu-4x/2048MB',
          CUT_LOG_KEY: 'logs/cuts/winter-2026-27/S2C_19TEM_20261005_0_L2A/a1.log',
          CUT_ATTEMPT: '1',
        },
        init: { cmd: ['S2C_19TEM_20261005_0_L2A'] },
      },
    });
  });

  it('reports a failed spawn with the status and body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('name taken', { status: 409, statusText: 'Conflict' })),
    );
    await expect(
      createCutMachine(config, { granuleId: 'X', maskSeason: 's', attempt: 1, logKey: 'k' }),
    ).rejects.toThrow(/Fly spawn X: 409 Conflict name taken/);
  });

  it('counts only live cut Machines', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json([
          { id: '1', name: 'granule-a', state: 'started', updated_at: '2026-10-10T12:00:00Z' },
          { id: '2', name: 'granule-b', state: 'created' },
          { id: '3', name: 'granule-c', state: 'stopped' },
          { id: '4', name: 'ors', state: 'started' },
          { id: '5' },
        ]),
      ),
    );
    const machines = await listMachines(config);
    expect(machines[4]).toEqual({ id: '5', name: '', state: 'unknown', updatedAt: null });
    expect(machines[0]?.updatedAt).toBe(Date.parse('2026-10-10T12:00:00Z'));
    expect(liveCutMachines(machines)).toBe(2);
  });

  it('a failed list throws rather than reading as zero Machines', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 500, statusText: 'Oops' })),
    );
    await expect(listMachines(config)).rejects.toThrow(/Fly list: 500/);
  });

  it('reads a Machine’s state and exit code, and a 404 as gone', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/gone')
          ? new Response('', { status: 404 })
          : url.endsWith('/bad')
            ? new Response('', { status: 502, statusText: 'Bad' })
            : json({
                state: 'destroyed',
                events: [{ type: 'exit', request: { exit_event: { exit_code: 1 } } }],
              }),
      ),
    );
    expect(await getMachine(config, 'm1')).toEqual({
      state: 'destroyed',
      exitCode: 1,
      oomKilled: null,
      exitedAt: null,
      startedAt: null,
    });
    expect(await getMachine(config, 'gone')).toBeNull();
    await expect(getMachine(config, 'bad')).rejects.toThrow(/Fly get bad: 502/);
  });

  it('treats a missing exit code as unknown, never as success', () => {
    expect(exitCodeOf(null)).toBeNull();
    expect(exitCodeOf({ events: 'nope' })).toBeNull();
    expect(exitCodeOf({ events: [{ type: 'start' }, { type: 'exit', request: {} }] })).toBeNull();
    expect(
      exitCodeOf({ events: [{ type: 'exit', request: { exit_event: { exit_code: 0 } } }] }),
    ).toBe(0);
  });
});

describe('a Machine’s run, and what the pump does after it', () => {
  it('reads the newest exit event’s code, OOM flag and time, and the newest start', () => {
    expect(
      machineRunOf({
        events: [
          {
            type: 'exit',
            timestamp: 1_000_900,
            request: {
              exit_event: {
                exit_code: 137,
                oom_killed: true,
                exited_at: '1970-01-01T00:16:40.500Z',
              },
            },
          },
          { type: 'start', timestamp: 1_000_100 },
          { type: 'exit', timestamp: 5, request: { exit_event: { exit_code: 0 } } },
          { type: 'start', timestamp: 1 },
        ],
      }),
    ).toEqual({ exitCode: 137, oomKilled: true, exitedAt: 1_000_500, startedAt: 1_000_100 });
    // No `exited_at`: the event's own time. Nothing at all: every field unknown.
    expect(
      machineRunOf({ events: [{ type: 'exit', timestamp: 7, request: { exit_event: {} } }] }),
    ).toEqual({ exitCode: null, oomKilled: null, exitedAt: 7, startedAt: null });
    expect(machineRunOf(null)).toEqual({
      exitCode: null,
      oomKilled: null,
      exitedAt: null,
      startedAt: null,
    });
  });

  it('destroys with force, and a 404 is already gone', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes('/gone') ? new Response('', { status: 404 }) : new Response('{}'),
    );
    vi.stubGlobal('fetch', fetchMock);
    await destroyMachine(config, 'm1');
    await destroyMachine(config, 'gone');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.machines.dev/v1/apps/skating-imagery/machines/m1?force=true');
    expect(init.method).toBe('DELETE');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('busy', { status: 409, statusText: 'Conflict' })),
    );
    await expect(destroyMachine(config, 'm1')).rejects.toThrow(/Fly destroy m1: 409/);
  });

  it('reads Fly’s log lines for one instance, the app’s apart from the runner’s', async () => {
    const fetchMock = vi.fn(async () =>
      json({
        data: [
          {
            attributes: {
              timestamp: '2026-10-10T12:00:01Z',
              message: 'gdalwarp: 0...10',
              instance: 'm1',
              meta: { event: { provider: 'app' } },
            },
          },
          {
            attributes: {
              timestamp: '2026-10-10T12:00:02Z',
              message: 'Out of memory: Killed process 412 (gdalwarp)',
              instance: 'm1',
              meta: { event: { provider: 'runner' } },
            },
          },
          { attributes: { timestamp: '2026-10-10T12:00:03Z', message: 'other', instance: 'm2' } },
          { attributes: { message: 'no time' } },
          null,
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    expect(await machineLogs(config, 'm1')).toEqual([
      { loggedAt: Date.parse('2026-10-10T12:00:01Z'), text: 'gdalwarp: 0...10', source: 'app' },
      {
        loggedAt: Date.parse('2026-10-10T12:00:02Z'),
        text: 'Out of memory: Killed process 412 (gdalwarp)',
        source: 'runner',
      },
    ]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.fly.io/api/v1/apps/skating-imagery/logs?instance=m1');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 403, statusText: 'Forbidden' })),
    );
    await expect(machineLogs(config, 'm1')).rejects.toThrow(/Fly logs m1: 403/);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({})),
    );
    expect(await machineLogs(config, 'm1')).toEqual([]);
  });
});
