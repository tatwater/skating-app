import type { api } from '@skating/convex/api';
import {
  addDaysIso,
  type CronLiveness,
  type CronLivenessInput,
  type CronSchedule,
  celsiusToFahrenheit,
  cronLiveness,
  parseGranuleId,
  parseSarGranuleId,
} from '@skating/core';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';

import { TODAY, YESTERDAY } from './imageryWords';

/**
 * **Machinery › Imagery's view model** — the one file that reads the server's shapes
 * (`packages/convex/convex/machineryImagery.ts`, a contract X2 landed as stubs; S3 builds the
 * bodies) and turns them into what the page draws. Every Imagery component takes its server types
 * from here, so when S3 refines a view (it may reshape `WatchFacts`, or add a field) the integrator
 * adjusts this file alone.
 *
 * **Fields read beyond X2's stubs** (each tolerant: absent reads as the stubs' contract):
 * - `machineryRuns.lanes`' `imagery` key (S3 adds it; its shape isn't landed): read by
 *   {@link imageryLaneTailOf} as `{ state: ImageryState, ready?: boolean, crons?: CronJobView[] }`.
 *   Until it arrives, the Imagery lane draws no tail but on its own page, where the page read gives it.
 * - Nothing else: every other fact is the stubs' own.
 *
 * Nothing here says anything about the ice (D3): a granule is a satellite pass being cut, a cron is
 * the machinery on time or not — never a claim about conditions.
 */

// ── The server's shapes ────────────────────────────────────────────────────────────────────────

/** `machineryImagery.page`: the head, the crons and the waiting facts, or `null` with no season. */
export type ImageryPageRead = FunctionReturnType<typeof api.machineryImagery.page>;
export type ImageryPageView = NonNullable<ImageryPageRead>;
export type ImageryState = ImageryPageView['state'];
export type WatchFactsView = NonNullable<ImageryPageView['watch']>;
export type PersonView = NonNullable<ImageryPageView['startedBy']>;

/** One cron's card, as `machineryCrons` sends it (the page's `crons`: poll, pump, index). */
export type CronJobView = ImageryPageView['crons'][number];

/** `machineryImagery.granules`: a page of the list. */
export type GranulePage = FunctionReturnType<typeof api.machineryImagery.granules>;
export type GranuleFilter = FunctionArgs<typeof api.machineryImagery.granules>['filter'];
export type GranuleRowView = GranulePage['page'][number];
export type GranuleStatus = GranuleRowView['status'];

/** `machineryImagery.granule`: one granule's detail, or `null` when it's gone. */
export type GranuleRead = FunctionReturnType<typeof api.machineryImagery.granule>;
export type GranuleView = NonNullable<GranuleRead>;
export type AttemptView = GranuleView['attempts'][number];
export type AttemptVerdict = AttemptView['verdict'];

/** `machineryImagery.attemptLog`: a page of one attempt's lines. */
export type AttemptLogPage = FunctionReturnType<typeof api.machineryImagery.attemptLog>;
export type AttemptLogLine = AttemptLogPage['page'][number];

/** The five writes' receipts. */
export type ImageryReceipt = FunctionReturnType<typeof api.machineryImagery.startImagery>;
export type RetryReceipt = FunctionReturnType<typeof api.machineryImagery.retryFailed>;

/** The list's filters, in the board's order (*Cutting* is the `spawned` status). */
export const GRANULE_FILTERS = [
  'all',
  'queued',
  'cutting',
  'empty',
  'failed',
] as const satisfies readonly GranuleFilter[];

/**
 * The poll's *Run now*, as the page hands W2's card and drawer (an additive prop, a seam request):
 * pressable, drawn disabled (`null`: imagery isn't running), or not drawn (absent).
 */
export type RunNowProp = { onPress: () => Promise<boolean> } | null;

// ── The page's state ───────────────────────────────────────────────────────────────────────────

/**
 * What the page draws: the waiting page (not started, or no watch yet: the sentinels, the line and
 * the start panel) or the working page (running, paused, ended: the granules and their attempts).
 */
export type PageShape = 'waiting' | 'working';

export function pageShapeOf(state: ImageryState): PageShape {
  return state === 'notStarted' || state === 'noWatch' ? 'waiting' : 'working';
}

/**
 * Whether a waiting season has crossed the imagery line: some sentinel's coldest night so far at or
 * below it. The watch's facts carry both; nothing is inferred from a forecast (D3: an air
 * temperature at a named site, never ice).
 */
export function lineCrossed(watch: WatchFactsView | null): boolean {
  if (watch === null || watch.closestNight === null) return false;
  return watch.closestNight.lowC <= watch.lineC;
}

/** A °C as the page writes °F: one decimal, a whole number without it ("20", "20.8"). */
export function fahrenheit(c: number): string {
  const f = Math.round(celsiusToFahrenheit(c) * 10) / 10;
  const shown = Object.is(f, -0) ? 0 : f;
  return Number.isInteger(shown) ? String(shown) : shown.toFixed(1);
}

/** "winter-2026-27" → "Winter 2026–27". */
export function seasonWords(season: string): string {
  const m = /^winter-(\d{4})-(\d{2})$/.exec(season);
  return m === null ? season : `Winter ${m[1]}–${m[2]}`;
}

/** Every granule the season's ledger holds, whatever its state ("of 23 queued since the start"). */
export function totalQueued(counts: ImageryPageView['counts']): number {
  return counts.queued + counts.spawned + counts.landed + counts.empty + counts.failed;
}

/** Machine-minutes from the season's milliseconds, rounded to the nearest whole minute. */
export const machineMinutes = (ms: number): number => Math.round(Math.max(0, ms) / 60_000);

/**
 * Whether *Try again now* has anything to lift: the pump backing off, or the index waiting to
 * re-read a frame it couldn't (the server refuses it otherwise, `tryAgainNow`).
 */
export function waitingToRetry(view: ImageryPageView, now: number): boolean {
  const backingOff = view.backoffUntil !== null && view.backoffUntil > now;
  return backingOff || view.index.retryAt !== null;
}

// ── A granule ──────────────────────────────────────────────────────────────────────────────────

/**
 * A granule's name as the list and the detail say it: "Sentinel-2B · tile 18TXP", "Sentinel-1A ·
 * GRD". An id neither grammar knows keeps its mission and the id.
 */
export function granuleTitle(row: Pick<GranuleRowView, 'granuleId' | 'mission'>): string {
  const optical = parseGranuleId(row.granuleId);
  if (optical !== null) return `${platformWords(optical.platform)} · tile ${optical.tile}`;
  const radar = parseSarGranuleId(row.granuleId);
  if (radar !== null) {
    return `${platformWords(radar.platform)} · ${radar.productType.replace(/[HM]$/, '')}`;
  }
  return `${row.mission === 's1' ? 'Sentinel-1' : 'Sentinel-2'} · ${row.granuleId}`;
}

/** The platform alone: "Sentinel-1A". */
export function granulePlatform(row: Pick<GranuleRowView, 'granuleId' | 'mission'>): string {
  const optical = parseGranuleId(row.granuleId);
  if (optical !== null) return platformWords(optical.platform);
  const radar = parseSarGranuleId(row.granuleId);
  if (radar !== null) return platformWords(radar.platform);
  return row.mission === 's1' ? 'Sentinel-1' : 'Sentinel-2';
}

/** "S2B" → "Sentinel-2B". */
const platformWords = (p: string) => `Sentinel-${p.slice(1)}`;

/** A capture instant from the stored ISO string, or `null` when it doesn't parse. */
export function capturedAtOf(row: Pick<GranuleRowView, 'capturedAt'>): number | null {
  const at = Date.parse(row.capturedAt);
  return Number.isFinite(at) ? at : null;
}

/** The instant a row's age counts from: its settle, its spawn, or its queueing. */
export function granuleAgeFrom(row: GranuleRowView): number {
  return row.settledAt ?? row.spawnedAt ?? row.queuedAt;
}

/**
 * The list under *All*: the failed granules first (the server's `failedFirst`, at most 50), then
 * everything else newest first — each failed row once, never again in the page below.
 */
export function allListRows(
  failed: readonly GranuleRowView[],
  rest: readonly GranuleRowView[],
): { failed: GranuleRowView[]; rest: GranuleRowView[] } {
  const seen = new Set(failed.map((r) => r.id));
  return {
    failed: [...failed],
    rest: rest.filter((r) => r.status !== 'failed' && !seen.has(r.id)),
  };
}

/** The attempt a granule's log opens on: the URL's, else the newest. */
export function openAttempt(
  attempts: readonly AttemptView[],
  asked: number | null,
): AttemptView | null {
  if (asked !== null) {
    const found = attempts.find((a) => a.attempt === asked);
    if (found !== undefined) return found;
  }
  return attempts.reduce<AttemptView | null>(
    (newest, a) => (newest === null || a.attempt > newest.attempt ? a : newest),
    null,
  );
}

/** Whether an attempt's verdict is a cut that didn't land: its log is drawn open (ruling 14). */
export function attemptFailed(verdict: AttemptVerdict): boolean {
  return (
    verdict === 'failed' ||
    verdict === 'requeued' ||
    verdict === 'refused' ||
    verdict === 'unconfirmed'
  );
}

/** Whether an attempt's log has lines to read: kept, or none from the cutter but Fly's own. */
export function attemptLogReadable(a: AttemptView): boolean {
  return a.log === 'kept' || a.log === 'none' || a.log === 'missing';
}

/** The newest attempt's exit, for the detail's fourth stat. */
export function lastExit(attempts: readonly AttemptView[]): { code: number; oom: boolean } | null {
  const last = openAttempt(attempts, null);
  if (last === null || last.exitCode === null) return null;
  return { code: last.exitCode, oom: last.oomKilled === true };
}

// ── The crons, at the page's clock ─────────────────────────────────────────────────────────────

/** What a cron says at a moment: core's verdict, read with the card's one extra fact. */
export type CronState = 'stalled' | 'failed' | 'late' | 'never' | 'running' | 'ok';

/** A cron as the lane's tail reads it (the card's fields this needs). */
export type CronTailInput = {
  schedule: CronSchedule;
  inputs: CronLivenessInput;
  lastRun: { startedAt: number; outcome: string } | null;
};

const lastRunFailed = (lastRun: CronTailInput['lastRun']) =>
  lastRun !== null && (lastRun.outcome === 'failed' || lastRun.outcome === 'killed');

/**
 * A cron's state at `now`: core's `cronLiveness` on the server-sent inputs (the one rule), then the
 * Overview card's reading of it (`machinery.cronJobState`): a killed tick is failed, and a failed
 * last run stays failed through the quiet and running ticks after it until a later run.
 *
 * ⚠ The second half mirrors the server's `cronJobState` (`convex/machinery.ts`), which the web can't
 * import: a seam request asks to move it into core beside `cronLiveness`, so the card, the lane and
 * the Overview read one function.
 */
export function cronStateAt(
  cron: CronTailInput,
  now: number,
): {
  state: CronState;
  liveness: CronLiveness;
} {
  const liveness = cronLiveness(cron.inputs, cron.schedule, now);
  switch (liveness.state) {
    case 'killed':
      return { state: 'failed', liveness };
    case 'running':
      return { state: lastRunFailed(cron.lastRun) ? 'failed' : 'running', liveness };
    case 'ok':
      return { state: lastRunFailed(cron.lastRun) ? 'failed' : 'ok', liveness };
    default:
      return { state: liveness.state, liveness };
  }
}

const WORST: readonly CronState[] = ['stalled', 'failed', 'late', 'never', 'running', 'ok'];

/**
 * The worst of the crons' states at `now`, and for *ok* the newest tick (the lane's "ok 2 min").
 * No crons is `never`.
 */
export function worstCron(
  crons: readonly CronTailInput[],
  now: number,
): { state: CronState; lastTickAt: number | null } {
  let worst: CronState = crons.length === 0 ? 'never' : 'ok';
  let lastTickAt: number | null = null;
  for (const cron of crons) {
    const { state, liveness } = cronStateAt(cron, now);
    if (WORST.indexOf(state) < WORST.indexOf(worst)) worst = state;
    if ('lastTickAt' in liveness) {
      lastTickAt =
        lastTickAt === null ? liveness.lastTickAt : Math.max(lastTickAt, liveness.lastTickAt);
    }
  }
  return { state: worst, lastTickAt };
}

// ── The sidebar's tail ─────────────────────────────────────────────────────────────────────────

/**
 * The Imagery lane's tail: the season's state while imagery isn't running (and, waiting, whether the
 * line has crossed — a start then waits on a person), else its three crons, re-read on the clock.
 */
export type ImageryLaneTail =
  | { state: 'notStarted'; ready: boolean }
  | { state: 'paused' | 'ended' | 'noWatch' }
  | { state: 'running'; crons: readonly CronTailInput[] };

/** The tail from the page's own read (on the Imagery page, where it is always at hand). */
export function imageryLaneTailFromPage(view: ImageryPageView): ImageryLaneTail {
  switch (view.state) {
    case 'notStarted':
      return { state: 'notStarted', ready: lineCrossed(view.watch) };
    case 'running':
      return { state: 'running', crons: view.crons };
    default:
      return { state: view.state };
  }
}

/**
 * The tail from `machineryRuns.lanes`' `imagery` key, which S3 adds (assumed `{ state, ready?,
 * crons? }`; see the file's head). Anything else — absent, or a shape this doesn't know — is no
 * tail, never a guess.
 */
export function imageryLaneTailOf(raw: unknown): ImageryLaneTail | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as { state?: unknown; ready?: unknown; crons?: unknown };
  switch (r.state) {
    case 'notStarted':
      return { state: 'notStarted', ready: r.ready === true };
    case 'paused':
    case 'ended':
    case 'noWatch':
      return { state: r.state };
    case 'running':
      return Array.isArray(r.crons)
        ? { state: 'running', crons: r.crons as CronTailInput[] }
        : undefined;
    default:
      return undefined;
  }
}

// ── Days and times, as the page writes them ────────────────────────────────────────────────────

/** "Sat 3 Oct": an instant's day in `timeZone`. */
export function dayWords(at: number, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone,
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('weekday')} ${get('day')} ${get('month')}`;
}

/** "Today", "Yesterday", else "Sat 3 Oct": an instant's day beside the reader's now. */
export function relativeDay(at: number, now: number, timeZone?: string): string {
  const key = (x: number) =>
    new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      timeZone,
    }).format(x);
  if (key(at) === key(now)) return TODAY;
  if (key(at) === key(now - 86_400_000)) return YESTERDAY;
  return dayWords(at, timeZone);
}

/** "3 Oct": an instant's day in `timeZone`, without its weekday. */
export function shortDayWords(at: number, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone }).format(at);
}

/** "Sat 3 Oct" for a calendar day the watch stored (`YYYY-MM-DD`), read in UTC: a label, not an instant. */
export function isoDayWords(iso: string): string {
  const at = Date.parse(`${iso}T12:00:00Z`);
  return Number.isFinite(at) ? dayWords(at, 'UTC') : iso;
}

/** "12 Oct 22:51": a capture or a spawn, in `timeZone`. */
export function dayClock(at: number, timeZone?: string): string {
  const day = shortDayWords(at, timeZone);
  const time = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).format(at);
  return `${day} ${time}`;
}

// ── The sentinels' lows, for the waiting page ──────────────────────────────────────────────────

/** `sentinelLows.forSeason`'s answer, as the waiting page reads it beside the chart. */
export type SentinelLowsRead = FunctionReturnType<typeof api.sentinelLows.forSeason>;
type LowsValue = Extract<SentinelLowsRead, { state: 'value' }>;

/** What the head takes from the lows: how many sentinels opened the watch, and the line's night. */
export type LowsFacts = {
  opened: { fired: number; of: number } | null;
  crossed: { on: string; sites: { name: string; lowC: number }[] } | null;
};

export function lowsFactsOf(read: SentinelLowsRead | null | undefined): LowsFacts | null {
  if (read == null || read.state !== 'value') return null;
  return {
    opened: read.opened === null ? null : { fired: read.opened.sites.length, of: read.opened.of },
    crossed:
      read.imageryLine === null
        ? null
        : {
            on: read.imageryLine.on,
            sites: read.imageryLine.sites.map((s) => ({ name: s.name, lowC: s.lowC })),
          },
  };
}

/** One row of *How close each sentinel has come*. */
export type SentinelRow = {
  key: string;
  name: string;
  /** The last night's low, °C, or `null` when that night is a gap. */
  lastC: number | null;
  /** The coldest night so far, and when. */
  coldest: { c: number; on: string } | null;
  /** Nights at or below the watch's line, of the nights measured. */
  atOrBelow: number;
  measured: number;
  /** The coldest less the imagery line, °C: positive is short of it, zero or less is past it. */
  shortC: number | null;
};

/**
 * Each sentinel against the imagery line, from the lows the chart draws: its last night, its
 * coldest and when, how many measured nights reached the watch's line, and how far its coldest is
 * from the imagery line. A gap is a gap — never a zero.
 */
export function sentinelRows(read: SentinelLowsRead | null | undefined): SentinelRow[] {
  if (read == null || read.state !== 'value') return [];
  const value: LowsValue = read;
  return value.sentinels.map((s) => {
    let coldest: SentinelRow['coldest'] = null;
    let atOrBelow = 0;
    let measured = 0;
    s.lows.forEach((low, i) => {
      if (low === null) return;
      measured += 1;
      if (low <= value.lines.watchC) atOrBelow += 1;
      if (coldest === null || low < coldest.c)
        coldest = { c: low, on: addDaysIso(value.firstDate, i) };
    });
    const last = s.lows.length === 0 ? null : (s.lows[s.lows.length - 1] ?? null);
    const found = coldest as SentinelRow['coldest'];
    return {
      key: s.key,
      name: s.name,
      lastC: last,
      coldest: found,
      atOrBelow,
      measured,
      shortC: found === null ? null : found.c - value.lines.imageryC,
    };
  });
}

/** A °C difference as °F (a span, not a temperature): one decimal, never negative. */
export function fahrenheitSpan(c: number): string {
  const f = Math.round(Math.abs(c) * 1.8 * 10) / 10;
  return f.toFixed(1);
}
