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
 * than 8192 (RAM was 82% of lifetime spend), `restart: no` (a failure is a failure, not a crash loop
 * on our bill), and the size label stamped into every manifest.
 *
 * **One difference, on purpose (B01-8b, D348): no `auto_destroy`.** A live cut's Machine stays
 * `stopped` when it exits, so the pump can read its exit event (the code, an out-of-memory kill, the
 * time) — a destroyed Machine is a 404, and the pump looks only every three minutes. The pump then
 * destroys it ({@link destroyMachine}), and a stopped cut Machine it finds while listing is cleared
 * too (`imageryLive`'s sweep). A backfill (`fan-out.sh`) still auto-destroys: nothing reads its exits.
 */

/** The Machines API. `FLY_API_URL` replaces both hosts (a local stand-in, for a proof). */
const FLY_API = 'https://api.machines.dev';
/** Fly's app log API (where `fly logs` reads), filtered by instance. */
const FLY_LOGS_API = 'https://api.fly.io';

/** One Fly API call, at most. */
const FLY_TIMEOUT_MS = 30_000;

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
  /** The Machines API's base; absent: {@link FLY_API}. */
  apiBase?: string;
  /** The log API's base; absent: {@link FLY_LOGS_API}. */
  logsBase?: string;
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
      // A stand-in for both of Fly's hosts, for a proof on a throwaway backend; never set on a real one.
      ...(env.FLY_API_URL
        ? {
            apiBase: env.FLY_API_URL.replace(/\/+$/, ''),
            logsBase: env.FLY_API_URL.replace(/\/+$/, ''),
          }
        : {}),
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
  return await fetch(`${config.apiBase ?? FLY_API}/v1/apps/${config.app}${path}`, {
    // ⚠ Bounded: `fan-out.sh` saw `fly machine run` hang for over an hour, and an unbounded call
    // here would hold the pump's lease and its action to the 10-minute limit for nothing.
    signal: AbortSignal.timeout(FLY_TIMEOUT_MS),
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
  /** When Fly last changed it (its `updated_at`), or `null` when it didn't say. */
  updatedAt: number | null;
}

/** An instant Fly sent: epoch ms, or an RFC 3339 string; anything else is `null`. */
function instant(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/** Every Machine in the app (destroyed ones excluded, as the API does by default). */
export async function listMachines(config: FlyConfig): Promise<FlyMachine[]> {
  const res = await fly(config, '/machines');
  if (!res.ok) throw await failure(res, 'list');
  const rows = (await res.json()) as {
    id: string;
    name?: string;
    state?: string;
    updated_at?: unknown;
  }[];
  return rows.map((m) => ({
    id: m.id,
    name: m.name ?? '',
    state: m.state ?? 'unknown',
    updatedAt: instant(m.updated_at),
  }));
}

/** A cut Machine: `fan-out.sh`'s and the pump's names both start so. */
export const isCutMachine = (m: Pick<FlyMachine, 'name'>) => m.name.startsWith('granule-');

/** A Machine that has exited and waits to be destroyed (`auto_destroy: false`). */
export const STOPPED_STATES: ReadonlySet<string> = new Set(['stopped', 'failed']);

/** How many cut Machines are alive right now. */
export function liveCutMachines(machines: readonly FlyMachine[]): number {
  return machines.filter((m) => isCutMachine(m) && LIVE_STATES.has(m.state)).length;
}

/**
 * Spawn one cut. Returns the Machine id. `logKey` is where the cutter uploads its log (core's
 * `cutLogKey`); an image from before B01-8b ignores it and the two env vars.
 */
export async function createCutMachine(
  config: FlyConfig,
  granule: { granuleId: string; maskSeason: string; attempt: number; logKey: string },
): Promise<string> {
  const res = await fly(config, '/machines', {
    method: 'POST',
    body: JSON.stringify({
      name: machineName(granule.granuleId, granule.attempt),
      region: config.region,
      config: {
        image: config.image,
        guest: FLY_GUEST,
        // Kept once it exits, so the pump can read its exit event, then destroyed by the pump.
        auto_destroy: false,
        restart: { policy: 'no' },
        env: {
          MASK_SEASON: granule.maskSeason,
          FLY_VM_SIZE_LABEL,
          CUT_LOG_KEY: granule.logKey,
          CUT_ATTEMPT: String(granule.attempt),
        },
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

/** What Fly says about a Machine's run: its exit event's fields and its start, each `null` if absent. */
export interface MachineRun {
  exitCode: number | null;
  oomKilled: boolean | null;
  exitedAt: number | null;
  startedAt: number | null;
}

/**
 * A Machine's exit event and start time, from its events (newest first, as Fly sends them; the newest
 * of each kind is read). The exit's time is `exit_event.exited_at`, else the event's own `timestamp`.
 * Read defensively: an absent field is unknown, never a default.
 */
export function machineRunOf(machine: unknown): MachineRun {
  const run: MachineRun = { exitCode: null, oomKilled: null, exitedAt: null, startedAt: null };
  const events = (machine as { events?: unknown[] } | null)?.events;
  if (!Array.isArray(events)) return run;
  let exitSeen = false;
  let startSeen = false;
  for (const event of events) {
    const e = event as {
      type?: string;
      timestamp?: unknown;
      request?: { exit_event?: { exit_code?: unknown; oom_killed?: unknown; exited_at?: unknown } };
    } | null;
    if (e?.type === 'exit' && !exitSeen) {
      exitSeen = true;
      const x = e.request?.exit_event;
      run.exitCode = typeof x?.exit_code === 'number' ? x.exit_code : null;
      run.oomKilled = typeof x?.oom_killed === 'boolean' ? x.oom_killed : null;
      run.exitedAt = instant(x?.exited_at) ?? instant(e.timestamp);
    } else if (e?.type === 'start' && !startSeen) {
      startSeen = true;
      run.startedAt = instant(e.timestamp);
    }
  }
  return run;
}

/** One Machine's state and what its events say, or `null` once the API no longer knows it. */
export async function getMachine(
  config: FlyConfig,
  id: string,
): Promise<({ state: string } & MachineRun) | null> {
  const res = await fly(config, `/machines/${id}`);
  if (res.status === 404) return null;
  if (!res.ok) throw await failure(res, `get ${id}`);
  const machine = (await res.json()) as { state?: string };
  return { state: machine.state ?? 'unknown', ...machineRunOf(machine) };
}

/**
 * Destroy one Machine (`force`, so a stopped one goes without a stop first). A 404 is already gone,
 * which is what was asked. Called only once its exit is on its attempt (`imageryLive`'s rule).
 */
export async function destroyMachine(config: FlyConfig, id: string): Promise<void> {
  const res = await fly(config, `/machines/${id}?force=true`, { method: 'DELETE' });
  if (res.ok || res.status === 404) return;
  throw await failure(res, `destroy ${id}`);
}

/** A line of Fly's log for one Machine: the app's own output, or Fly's (the runner's) word. */
export interface FlyMachineLogLine {
  loggedAt: number;
  text: string;
  source: 'app' | 'runner';
}

/** The most lines one read keeps: one page of Fly's log API is far fewer. */
const MAX_FLY_LOG_LINES = 2_000;

/**
 * **Fly's own log lines for one Machine** (D348): one page of the app log API (`fly logs`' source),
 * filtered by instance, bounded by the call's timeout. Lines whose provider is `app` are the cutter's
 * stdout and stderr; everything else (the runner: the VM, an out-of-memory kill, the exit) is Fly's,
 * and only Fly has it. Throws on a refusal: the caller keeps the exit event and goes without these.
 *
 * ⚠ Not part of the Machines API's documented surface (register Ma22): if it changes, or the
 * deployment's token can't read it, an attempt keeps Fly's exit event and loses only these lines.
 */
export async function machineLogs(config: FlyConfig, id: string): Promise<FlyMachineLogLine[]> {
  const params = new URLSearchParams({ instance: id });
  const res = await fetch(
    `${config.logsBase ?? FLY_LOGS_API}/api/v1/apps/${config.app}/logs?${params.toString()}`,
    {
      signal: AbortSignal.timeout(FLY_TIMEOUT_MS),
      headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/json' },
    },
  );
  if (!res.ok) throw await failure(res, `logs ${id}`);
  const body = (await res.json()) as {
    data?: {
      attributes?: {
        timestamp?: unknown;
        message?: unknown;
        instance?: unknown;
        meta?: { event?: { provider?: unknown } };
      };
    }[];
  };
  const lines: FlyMachineLogLine[] = [];
  for (const row of Array.isArray(body?.data) ? body.data : []) {
    const a = row?.attributes;
    const loggedAt = instant(a?.timestamp);
    if (loggedAt === null || typeof a?.message !== 'string') continue;
    // Filtered by the API already; a line for another instance is never this Machine's.
    if (typeof a.instance === 'string' && a.instance !== id) continue;
    lines.push({
      loggedAt,
      text: a.message,
      source: a.meta?.event?.provider === 'app' ? 'app' : 'runner',
    });
    if (lines.length >= MAX_FLY_LOG_LINES) break;
  }
  return lines;
}
