/**
 * The Fly Machines API, as the live imagery job uses it (A06i §5, D214).
 *
 * This file is to the Convex job what `scripts/imagery/fan-out.sh` is to a backfill: **the entire
 * Fly-specific surface**. D148's condition on choosing Fly — "keep 'which granules, when' outside
 * Fly's Machines API" — still holds: everything that decides *what* to cut lives in `imageryLive.ts`
 * and core, and leaving Fly means rewriting this one file.
 *
 * ⚠ **The Machine configuration must match `fan-out.sh` exactly**, and every number below is one that
 * file learned the hard way: an explicit size *and* memory (the default OOMs mid-warp), 2048 MB rather
 * than 8192 (RAM was 82% of lifetime spend), `auto_destroy` with `restart: no` (a failure is a
 * failure, not a crash loop on our bill), and the size label stamped into every manifest.
 */

const FLY_API = 'https://api.machines.dev/v1';

/** `fan-out.sh`'s defaults: `shared-cpu-4x`, 2048 MB, San Jose. */
export const FLY_GUEST = { cpu_kind: 'shared', cpus: 4, memory_mb: 2048 } as const;
export const FLY_VM_SIZE_LABEL = 'shared-cpu-4x/2048MB';
const DEFAULT_APP = 'skating-imagery';
const DEFAULT_REGION = 'sjc';

/**
 * Every state in which a Machine is alive or about to be — the only number worth throttling on.
 * `fan-out.sh` counts the same four: a burst of spawns piles up in `created` and `starting`.
 */
export const LIVE_STATES: ReadonlySet<string> = new Set([
  'created',
  'starting',
  'started',
  'replacing',
]);

export interface FlyConfig {
  token: string;
  app: string;
  image: string;
  region: string;
}

/** The config from the environment, or the names of what is missing. */
export function flyConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): { ok: true; config: FlyConfig } | { ok: false; missing: string[] } {
  const missing = (['FLY_API_TOKEN', 'FLY_IMAGE'] as const).filter((k) => !env[k]);
  if (missing.length > 0) return { ok: false, missing };
  return {
    ok: true,
    config: {
      token: env.FLY_API_TOKEN as string,
      // ⚠ Pinned by digest/label, never `:latest` — every Machine in a season must run the same code.
      image: env.FLY_IMAGE as string,
      app: env.FLY_APP || DEFAULT_APP,
      region: env.FLY_REGION || DEFAULT_REGION,
    },
  };
}

/**
 * The Machine's name: `fan-out.sh`'s `granule-<id, lower-case, dashes>`, so a live cut and a
 * backfill read alike in `fly logs`, plus `-r<n>` on a retry — names are unique, and the previous
 * attempt's Machine may still be being destroyed.
 */
export function machineName(granuleId: string, attempt: number): string {
  const base = `granule-${granuleId.toLowerCase().replace(/_/g, '-')}`;
  return attempt > 1 ? `${base}-r${attempt}` : base;
}

async function fly(config: FlyConfig, path: string, init?: RequestInit): Promise<Response> {
  return await fetch(`${FLY_API}/apps/${config.app}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
}

async function failure(res: Response, what: string): Promise<Error> {
  const body = await res.text().catch(() => '');
  return new Error(`Fly ${what}: ${res.status} ${res.statusText} ${body.slice(0, 200)}`.trim());
}

export interface FlyMachine {
  id: string;
  name: string;
  state: string;
}

/** Every Machine in the app (destroyed ones excluded, as the API does by default). */
export async function listMachines(config: FlyConfig): Promise<FlyMachine[]> {
  const res = await fly(config, '/machines');
  if (!res.ok) throw await failure(res, 'list');
  const rows = (await res.json()) as { id: string; name?: string; state?: string }[];
  return rows.map((m) => ({ id: m.id, name: m.name ?? '', state: m.state ?? 'unknown' }));
}

/** How many cut Machines are alive right now. */
export function liveCutMachines(machines: readonly FlyMachine[]): number {
  return machines.filter((m) => m.name.startsWith('granule-') && LIVE_STATES.has(m.state)).length;
}

/** Spawn one cut. Returns the Machine id. */
export async function createCutMachine(
  config: FlyConfig,
  granule: { granuleId: string; maskSeason: string; attempt: number },
): Promise<string> {
  const res = await fly(config, '/machines', {
    method: 'POST',
    body: JSON.stringify({
      name: machineName(granule.granuleId, granule.attempt),
      region: config.region,
      config: {
        image: config.image,
        guest: FLY_GUEST,
        auto_destroy: true,
        restart: { policy: 'no' },
        env: { MASK_SEASON: granule.maskSeason, FLY_VM_SIZE_LABEL },
        // The image's ENTRYPOINT is `cut-granule`; `init.cmd` is its one argument (D148's contract).
        init: { cmd: [granule.granuleId] },
      },
    }),
  });
  if (!res.ok) throw await failure(res, `spawn ${granule.granuleId}`);
  return ((await res.json()) as { id: string }).id;
}

/**
 * The exit code a Machine's process reported, if its events carry one. Read defensively: the field
 * (`events[].request.exit_event.exit_code`) is what flyctl prints, but an absent one means "unknown",
 * never "succeeded".
 */
export function exitCodeOf(machine: unknown): number | null {
  const events = (machine as { events?: unknown[] } | null)?.events;
  if (!Array.isArray(events)) return null;
  for (const event of events) {
    const e = event as { type?: string; request?: { exit_event?: { exit_code?: unknown } } };
    const code = e?.request?.exit_event?.exit_code;
    if (e?.type === 'exit' && typeof code === 'number') return code;
  }
  return null;
}

/** One Machine's state and exit code, or `null` once the API no longer knows it. */
export async function getMachine(
  config: FlyConfig,
  id: string,
): Promise<{ state: string; exitCode: number | null } | null> {
  const res = await fly(config, `/machines/${id}`);
  if (res.status === 404) return null;
  if (!res.ok) throw await failure(res, `get ${id}`);
  const machine = (await res.json()) as { state?: string };
  return { state: machine.state ?? 'unknown', exitCode: exitCodeOf(machine) };
}
