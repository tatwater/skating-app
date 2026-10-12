import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createCutMachine,
  exitCodeOf,
  FLY_GUEST,
  flyConfigFromEnv,
  getMachine,
  listMachines,
  liveCutMachines,
  machineName,
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
        auto_destroy: true,
        restart: { policy: 'no' },
        env: { MASK_SEASON: 'winter-2026-27', FLY_VM_SIZE_LABEL: 'shared-cpu-4x/2048MB' },
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
      createCutMachine(config, { granuleId: 'X', maskSeason: 's', attempt: 1 }),
    ).rejects.toThrow(/Fly spawn X: 409 Conflict name taken/);
  });

  it('counts only live cut Machines', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json([
          { id: '1', name: 'granule-a', state: 'started' },
          { id: '2', name: 'granule-b', state: 'created' },
          { id: '3', name: 'granule-c', state: 'stopped' },
          { id: '4', name: 'ors', state: 'started' },
          { id: '5' },
        ]),
      ),
    );
    const machines = await listMachines(config);
    expect(machines[4]).toEqual({ id: '5', name: '', state: 'unknown' });
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
    expect(await getMachine(config, 'm1')).toEqual({ state: 'destroyed', exitCode: 1 });
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
