/**
 * **Machinery › Imagery's reads and writes** (D344, D346, D348, B01-8b-2): the season's live imagery
 * as the page draws it — its state, the head's stats, its three crons' cards, the granules, one
 * granule's attempts and an attempt's log — and the five writes in its floating bar.
 *
 * Reads are gated `machinery.read`; writes `machinery.imagery`, each one audit row (`writeAudit`,
 * target `imagerySeason`, its id the season), refusals thrown as sentences (toasts on the web).
 *
 * **PLACEHOLDER (B01-8b-2's seams, X2).** Every function here holds its contract: its arguments, its
 * gate and the shape it returns, so the web derives its types from `api` and builds against them.
 * The reads answer as an empty season would (no row, an empty page); the writes refuse. S3 builds
 * the bodies (the phase doc's *The reads* and *The writes*, B01-8b's *Imagery*); a field or type
 * here that changes is said in S3's report.
 */

import { type PaginationResult, paginationOptsValidator } from 'convex/server';
import { ConvexError, v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { mutation, query } from './_generated/server';
import { requireCapability } from './lib/auth';
import { literals } from './lib/validators';
import type { CronJobView } from './machineryCrons';
import type { PersonView, RunEventView } from './machineryRuns';

// ── The views ──────────────────────────────────────────────────────────────────────────────────

/**
 * The season's imagery as the page reads it: `noWatch` (no season row yet), `notStarted` (the watch
 * is waiting for cold, or crossed and ready to start), `running`, `paused`, `ended`.
 */
export type ImageryState = 'notStarted' | 'running' | 'paused' | 'ended' | 'noWatch';

/** The granule list's filters; `cutting` is the `spawned` status. */
export const GRANULE_FILTERS = ['all', 'queued', 'cutting', 'empty', 'failed'] as const;
export type GranuleFilter = (typeof GRANULE_FILTERS)[number];

/** The granule list's page; `failedFirst`'s bound. */
export const GRANULES_PAGE_SIZE = 25;
export const FAILED_FIRST_LIMIT = 50;
/** The attempts one granule's detail reads (`by_granule_attempt`). */
export const GRANULE_ATTEMPTS_LIMIT = 10;
/** An attempt log's page (as a cron run's). */
export const ATTEMPT_LOG_PAGE_SIZE = 200;

/**
 * The waiting and crossed states' facts, from the season watch's own reads: the season row, the
 * closest night to the imagery line so far, the line itself, and when the staff email went.
 */
export type WatchFacts = {
  season: string;
  /** When the watch's season row opened (the line crossed), or `null` while it waits for cold. */
  openedAt: number | null;
  /** The imagery line the watch decides on, °C. */
  lineC: number;
  /** The coldest sentinel night so far, or `null` before the first. */
  closestNight: { date: string; lowC: number; site: string } | null;
  /** When the *opened* staff email went (`emailsSent`), or `null`. */
  staffEmailAt: number | null;
};

/** The page's head and frame. */
export type ImageryPageView = {
  season: string;
  state: ImageryState;
  startedBy: PersonView | null;
  startedAt: number | null;
  /** The season's ledger (`imageryCounts`). */
  counts: { queued: number; spawned: number; landed: number; empty: number; failed: number };
  /** Machines live when the pump last listed them, of the cap; `null` before the first listing. */
  machines: { live: number | null; cap: number; at: number | null };
  /** The live index: built, its frame count, and when a stalled rebuild next re-reads. */
  index: { built: boolean; frames: number; retryAt: number | null };
  /** Fly this season, in machine-minutes only (ms); `countedFrom` when it began before 8b. */
  fly: { machineMs: number; countedFrom: number | null };
  /** The cutter image the pump spawns with, and when it first saw it. */
  image: { ref: string; seenAt: number } | null;
  /** The poll, the pump and the index, in that order (`machineryCrons.cronJobViews`). */
  crons: CronJobView[];
  backoffUntil: number | null;
  /** Whether Fly and R2 are configured on this deployment (names only, never values). */
  configured: boolean;
  watch: WatchFacts | null;
};

/** A row of the granule list. */
export type GranuleRowView = {
  id: Id<'imageryGranules'>;
  granuleId: string;
  mission: Doc<'imageryGranules'>['mission'];
  season: string;
  capturedAt: string;
  status: Doc<'imageryGranules'>['status'];
  attempts: number;
  refusals: number;
  queuedAt: number;
  spawnedAt: number | null;
  settledAt: number | null;
  /** When the catalog published the pass; `null` on rows queued before 8b. */
  catalogedAt: number | null;
  lastError: string | null;
  /** An empty cut's reason (the marker's), or `null`. */
  emptyReason: string | null;
};

/** One attempt, as the granule's *Attempts* and *What to check* read it. */
export type AttemptView = {
  id: Id<'imageryAttempts'>;
  attempt: number;
  machineName: string;
  machineId: string | null;
  image: string | null;
  spawnedAt: number;
  startedAt: number | null;
  exitedAt: number | null;
  exitCode: number | null;
  oomKilled: boolean | null;
  verdict: Doc<'imageryAttempts'>['verdict'];
  error: string | null;
  machineMs: number | null;
  machineMsFrom: Doc<'imageryAttempts'>['machineMsFrom'] | null;
  log: Doc<'imageryAttempts'>['log'];
  settledAt: number | null;
};

/** A granule's detail. `before8b`: queued before attempts were recorded. */
export type GranuleView = { row: GranuleRowView; attempts: AttemptView[]; before8b: boolean };

/** A line of an attempt's log: a run's line, and who wrote it. */
export type AttemptLogLineView = RunEventView & { origin: Doc<'runEvents'>['origin'] | null };

/** Every write's receipt: the audit row it wrote. */
export type ImageryReceipt = { actionId: Id<'moderationActions'> };

/** PLACEHOLDER: what every write says until S3 builds it. */
const NOT_BUILT = 'This isn’t built yet.';

// ── The reads ──────────────────────────────────────────────────────────────────────────────────

/** The page's head, crons and waiting facts for the current season; `null` with no season. */
export const page = query({
  args: { now: v.optional(v.number()) },
  handler: async (ctx, _args): Promise<ImageryPageView | null> => {
    await requireCapability(ctx, 'machinery.read');
    // PLACEHOLDER (S3)
    return null;
  },
});

/** The season's granules, newest first, 25 a page (failed ones are `failedFirst`'s). */
export const granules = query({
  args: { filter: literals(GRANULE_FILTERS), paginationOpts: paginationOptsValidator },
  handler: async (ctx, _args): Promise<PaginationResult<GranuleRowView>> => {
    await requireCapability(ctx, 'machinery.read');
    // PLACEHOLDER (S3)
    return { page: [], isDone: true, continueCursor: '' };
  },
});

/** The season's failed granules, newest first, at most 50: drawn above the list. */
export const failedFirst = query({
  args: {},
  handler: async (ctx): Promise<GranuleRowView[]> => {
    await requireCapability(ctx, 'machinery.read');
    // PLACEHOLDER (S3)
    return [];
  },
});

/** One granule, its attempts (at most 10) and whether it predates them; `null` when gone. */
export const granule = query({
  args: { id: v.id('imageryGranules') },
  handler: async (ctx, _args): Promise<GranuleView | null> => {
    await requireCapability(ctx, 'machinery.read');
    // PLACEHOLDER (S3)
    return null;
  },
});

/** An attempt's log, newest first, 200 a page; the web reverses each page. */
export const attemptLog = query({
  args: { attemptId: v.id('imageryAttempts'), paginationOpts: paginationOptsValidator },
  handler: async (ctx, _args): Promise<PaginationResult<AttemptLogLineView>> => {
    await requireCapability(ctx, 'machinery.read');
    // PLACEHOLDER (S3)
    return { page: [], isDone: true, continueCursor: '' };
  },
});

// ── The writes ─────────────────────────────────────────────────────────────────────────────────

/** Start the season's imagery (moved from `seasonWatch.startImagery`); undone by `pauseImagery`. */
export const startImagery = mutation({
  args: { season: v.string() },
  handler: async (ctx, _args): Promise<ImageryReceipt> => {
    await requireCapability(ctx, 'machinery.imagery');
    // PLACEHOLDER (S3)
    throw new ConvexError(NOT_BUILT);
  },
});

/** Pause the season's imagery (moved); undone by `startImagery` (*Resume*). */
export const pauseImagery = mutation({
  args: { season: v.string() },
  handler: async (ctx, _args): Promise<ImageryReceipt> => {
    await requireCapability(ctx, 'machinery.imagery');
    // PLACEHOLDER (S3)
    throw new ConvexError(NOT_BUILT);
  },
});

/** Check the catalogs now: the poll's dispatcher, `trigger: 'manual'`. No inverse. */
export const pollNow = mutation({
  args: {},
  handler: async (ctx): Promise<ImageryReceipt> => {
    await requireCapability(ctx, 'machinery.imagery');
    // PLACEHOLDER (S3)
    throw new ConvexError(NOT_BUILT);
  },
});

/** Send the season's failed cuts back in line (moved); the receipt says how many. No inverse. */
export const retryFailed = mutation({
  args: {},
  handler: async (ctx): Promise<ImageryReceipt & { requeued: number }> => {
    await requireCapability(ctx, 'machinery.imagery');
    // PLACEHOLDER (S3)
    throw new ConvexError(NOT_BUILT);
  },
});

/** Lift the pump's backoff and the index's wait (moved). No inverse. */
export const tryAgainNow = mutation({
  args: {},
  handler: async (ctx): Promise<ImageryReceipt> => {
    await requireCapability(ctx, 'machinery.imagery');
    // PLACEHOLDER (S3)
    throw new ConvexError(NOT_BUILT);
  },
});
