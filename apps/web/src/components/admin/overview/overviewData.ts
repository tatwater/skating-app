/**
 * What each Home block draws, and the adapters from the reads that serve it:
 *
 * - `console.overview` → the Inbox and People cards (every lane counted through an index, capped);
 * - `waterBodies.reviewQueueCounts` and `console.corpusCounts` → the Corpus card;
 * - `machinery.overviewJobs` → the Machinery card (admins);
 * - `moderation.listActions` and `console.systemFeed` → the audit feed, people's and the machine's.
 *
 * What no read carries yet — cost, the feed's target names — stays `null`, drawn *Not recorded yet*.
 */
import type { api } from '@skating/convex/api';
import type { FunctionReturnType } from 'convex/server';
import { shortAge } from '@/lib/ages';
import { type AuditAction, type AuditTarget, actorWords } from '../shell/actionLabels';

import { type Count, DAY, feedWhen, sumCounts } from './overviewModel';

const HOUR = DAY / 24;

/** `console.overview`, as the server returns it. */
export type ConsoleOverview = FunctionReturnType<typeof api.console.overview>;
/** `waterBodies.reviewQueueCounts`, as the server returns it. */
export type ReviewQueueCounts = FunctionReturnType<typeof api.waterBodies.reviewQueueCounts>;
/** `console.corpusCounts`, as the server returns it. */
export type CorpusCounts = FunctionReturnType<typeof api.console.corpusCounts>;
/** One `moderation.listActions` row. */
export type ActionRow = FunctionReturnType<typeof api.moderation.listActions>[number];
/** One `console.systemFeed` row: something the machine did. */
export type SystemFeedRow = FunctionReturnType<typeof api.console.systemFeed>[number];
/** `machinery.overviewJobs` for an admin (a moderator's read is `null`). */
export type OverviewJobs = NonNullable<FunctionReturnType<typeof api.machinery.overviewJobs>>;

// ── Inbox ────────────────────────────────────────────────────────────────────────────────────

/** The Inbox's lanes, in the Inbox's own order (safety first). */
export const INBOX_LANES = [
  'safety',
  'accessReports',
  'requests',
  'placesAsked',
  'drawnBodies',
  'contentFlags',
  'support',
] as const;
export type InboxLane = (typeof INBOX_LANES)[number];

export const INBOX_LANE_LABEL: Record<InboxLane, string> = {
  safety: 'Safety',
  accessReports: 'Access reports',
  requests: 'Requests',
  placesAsked: 'Places asked',
  drawnBodies: 'Drawn bodies',
  contentFlags: 'Content flags',
  support: 'Support',
};

export interface InboxCardData {
  /** Each lane's count; `null` for a lane this viewer can't open (support, for a moderator). */
  lanes: Record<InboxLane, Count | null>;
  /** When the oldest open item was filed. */
  oldestOpenAt: number | null;
  /**
   * When the median open item was filed — aged on the reader's clock, so the foot keeps up between
   * reads. `null` with nothing open, or when the server's read of a lane stopped short.
   */
  medianOpenedAt: number | null;
  /** The Inbox's backfill hasn't concluded: the counts may be short, so the card draws none. */
  pending: boolean;
}

export function inboxFromOverview(inbox: ConsoleOverview['inbox']): InboxCardData {
  return {
    lanes: {
      safety: inbox.safety,
      accessReports: inbox.accessReports,
      requests: inbox.requests,
      placesAsked: inbox.placesAsked,
      drawnBodies: inbox.drawnBodies,
      contentFlags: inbox.contentFlags,
      support: inbox.support,
    },
    oldestOpenAt: inbox.oldestOpenAt,
    medianOpenedAt: inbox.medianOpenedAt,
    pending: inbox.pending,
  };
}

/** The heading's Inbox figure: the open total, `pending` while the backfill runs, 0 while loading. */
export function inboxHeadCount(data: InboxCardData | undefined): Count | 'pending' {
  if (data === undefined) return { count: 0, capped: false };
  return data.pending ? 'pending' : inboxTotal(data);
}

/** Everything open in the Inbox the viewer can see. */
export function inboxTotal(data: InboxCardData): Count {
  return sumCounts(INBOX_LANES.map((lane) => data.lanes[lane]));
}

// ── Corpus ───────────────────────────────────────────────────────────────────────────────────

export const CORPUS_TASKS = [
  'duplicates',
  'nameConflicts',
  'classConflicts',
  'contested',
  'orphanBays',
  'chordRefits',
  'placeNames',
  'preIcePass',
  'enrichment',
] as const;
export type CorpusTask = (typeof CORPUS_TASKS)[number];

/** The pre-ice pass is dated, not counted: not run this season, or done on a day. */
export type PreIcePass = { state: 'not-run' } | { state: 'done'; at: number };

export interface CorpusCardData {
  duplicates: Count;
  /** The Name conflicts lane's open tasks (`corpusTasks.lanes`): exact, as the lane counts them. */
  nameConflicts: Count;
  /** The Class conflicts lane's open tasks (`corpusTasks.lanes`): a `class-conflict` each. */
  classConflicts: Count;
  /**
   * The bodies a catalog says aren't lakes or ponds at all (`class-dissent`, on today's read): their
   * own row, opening the old review page until their lane is built.
   */
  contested: Count;
  orphanBays: Count;
  /** Chord re-fits (`mouthReview` / `mouthStale`); `null` until a read counts them across bodies. */
  chordRefits: Count | null;
  /** Place names from the email groups; `null` until a read counts them. */
  placeNames: Count | null;
  preIcePass: PreIcePass | null;
  /** Bodies awaiting elevation, wind or depth; `null` until a read counts them. */
  enrichment: Count | null;
  /** When the last corpus campaign ran. */
  campaignAt: number | null;
}

/** The parts of the Corpus card the intake reasons don't carry (`console.corpusCounts`). */
export type CorpusExtras = Pick<
  CorpusCardData,
  'duplicates' | 'chordRefits' | 'placeNames' | 'preIcePass' | 'enrichment' | 'campaignAt'
>;

const NO_EXTRAS: Omit<CorpusExtras, 'duplicates'> = {
  chordRefits: null,
  placeNames: null,
  preIcePass: null,
  enrichment: null,
  campaignAt: null,
};

/** The Corpus task lanes' open counts (`corpusTasks.lanes`), as the card takes them. */
export type CorpusTaskOpen = { nameConflicts: number; classConflicts: number };

/**
 * The intake reasons, folded into the Corpus card's tasks the way the Corpus mode lists them:
 * both duplicate reasons are one *Duplicates* lane, and the dissent bodies (`class-dissent`) are
 * *Contested as water*, their own row. A built lane counts from its tasks (`tasks`, the lanes read's
 * open counts — the same figures the Corpus sidebar draws); without them, the reason's rows.
 * `extras` is `console.corpusCounts` when it has landed: its *Duplicates* is the dedup queue's own
 * total (`dedupStatus` groups, as decisions), which replaces the intake reasons' sum. That is a
 * different population, not a finer count of the same rows; the intake sum is only what a caller
 * without that read gets (the Overview waits for every read).
 */
export function corpusFromReviewCounts(
  counts: ReviewQueueCounts,
  extras: Partial<CorpusExtras> = {},
  tasks: CorpusTaskOpen | null = null,
): CorpusCardData {
  const at = (reason: string): Count | null => counts[reason] ?? null;
  const exact = (count: number): Count => ({ count, capped: false });
  return {
    duplicates: sumCounts([at('duplicate-candidate'), at('same-source-duplicate')]),
    nameConflicts: tasks === null ? sumCounts([at('name-conflict')]) : exact(tasks.nameConflicts),
    classConflicts:
      tasks === null ? sumCounts([at('class-conflict')]) : exact(tasks.classConflicts),
    contested: sumCounts([at('class-dissent')]),
    orphanBays: sumCounts([at('bay-without-parent')]),
    ...NO_EXTRAS,
    ...extras,
  };
}

/** `console.corpusCounts` as the Corpus card's extras. */
export function corpusExtrasFrom(counts: CorpusCounts): CorpusExtras {
  return {
    duplicates: counts.duplicates,
    chordRefits: counts.chordRefits,
    placeNames: counts.placeNames,
    preIcePass: counts.preIcePass,
    enrichment: counts.enrichment,
    campaignAt: counts.campaignAt,
  };
}

// ── Machinery ────────────────────────────────────────────────────────────────────────────────

/**
 * A job's last word. Red won't recover without a person (stalled, failed); amber is late or
 * retrying; ok is the quiet state; `never` hasn't run this season.
 */
export type JobState = 'stalled' | 'failed' | 'late' | 'retried' | 'ok' | 'never';

export interface JobRow {
  id: string;
  name: string;
  state: JobState;
  /** When it last ran (`jobWhen` writes it); `null` if it never has. */
  at: number | null;
}

export interface MachineryCardData {
  /** The jobs that need a look first, then a few that don't. */
  jobs: JobRow[];
  /** How many more jobs the card leaves out. */
  more: number;
  /** Whether every job left out is ok. */
  moreAllOk: boolean;
}

/** `machinery.overviewJobs` as the card draws it. */
export function machineryFromJobs(read: OverviewJobs): MachineryCardData {
  return { jobs: read.jobs, more: read.more, moreAllOk: read.moreAllOk };
}

/**
 * When a job row says it last ran: minutes under an hour ("41 min", "3 min" — and for a stalled
 * run, how long it has been quiet), the clock today ("04:12"), the weekday and time this past week
 * ("Fri 22:14"), the date before that — in the reader's zone. A job that never ran says a dash.
 */
export function jobWhen(at: number | null, now: number): string {
  if (at === null) return '—';
  return now - at < HOUR ? shortAge(now - at) : feedWhen(at, now);
}

/**
 * Stalled and failed runs, for the heads row. Machinery unread, withheld or loading says no run is
 * stalled or failed — and none is said to be fine.
 */
export function machineryTrouble(data: MachineryCardData | 'withheld' | null | undefined): {
  stalled: number;
  failed: number;
} {
  if (!data || data === 'withheld') return { stalled: 0, failed: 0 };
  return {
    stalled: data.jobs.filter((j) => j.state === 'stalled').length,
    failed: data.jobs.filter((j) => j.state === 'failed').length,
  };
}

// ── People ───────────────────────────────────────────────────────────────────────────────────

export interface PeopleCardData {
  admins: Count;
  moderators: Count;
  newThisWeek: Count;
  suspended: Count;
  /** When the soonest live suspension ends. */
  nextSuspensionEnds: number | null;
  banned: Count;
  flaggedPeople: Count;
  /** Open appeals; `null` for a viewer who can't read support. */
  appealsOpen: Count | null;
  leaving: Count;
  /** Everyone with an account (the 6-hourly rollup); `null` until it has run. */
  totalUsers: Count | null;
  /**
   * The People backfills not yet finished after a deploy: while `rows` is, every figure but
   * `totalUsers` may be wrong (not merely a floor); while `flagSubjects` is, `flaggedPeople` may be.
   * The card says so instead of a number.
   */
  pending: ConsoleOverview['people']['pending'];
}

export function peopleFromOverview(people: ConsoleOverview['people']): PeopleCardData {
  return people;
}

// ── Cost ─────────────────────────────────────────────────────────────────────────────────────

export interface CostService {
  id: string;
  /** Who bills it ("Convex · Vercel · R2"). */
  label: string;
  /** What it has cost this season ("$70.00"), or `null` for a free tier. */
  amount: string | null;
  /** The sub-line ("R2 2.4 of 10 GB free"). */
  sub: string;
  /** How near its free tier's ceiling it runs. */
  meter?: { value: number; max: number; label: string };
}

export interface CostMonth {
  /** The month's first day (local), for its name and the hover plate. */
  at: number;
  hosting: number;
  ai: number;
  compute: number;
}

export interface CostData {
  /** This season so far ("$75.80"). */
  total: string;
  /** "$70.00 invoiced · $5.80 metered". */
  totalSub: string;
  services: CostService[];
  /** The last three full months and this one, oldest first. */
  months: CostMonth[];
}

/** "$25.00" — dollars, two places. */
export function dollars(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ── Audit feed ───────────────────────────────────────────────────────────────────────────────

/** Where a feed row's target lives, for the link the integrator renders. */
export interface FeedTarget {
  type: string;
  id: string;
  /** The target's name ("Mascoma Lake", "Rob Tremblay"); the type's word when no read names it. */
  label: string;
}

export interface FeedRow {
  id: string;
  at: number;
  /** Who did it; `null` for the machine. */
  actor: string | null;
  /** The script or agent they did it through, read "Teagan via seed-destinations" (D256). */
  via?: string;
  /** What was done, from the operator's side ("Declined request"). */
  action: string;
  target: FeedTarget;
}

/**
 * Every verb the audit table can hold, written as a person would say it, in the past tense. Typed
 * over the table's own union (as History's sentences are, `shell/actionLabels`), so a verb added on
 * the server without its words fails to compile rather than reaching the feed as "Grant ledger
 * editor".
 */
const ACTION_WORDS: Record<AuditAction, string> = {
  hide: 'Hid',
  remove: 'Removed',
  restore: 'Restored',
  author_delete: 'Deleted their own',
  overturn_verdict: 'Overturned verdict',
  erase: 'Erased',
  ban: 'Banned',
  suspend: 'Suspended',
  unban: 'Reinstated',
  merge_waterbody: 'Merged body',
  unmerge_waterbody: 'Unmerged body',
  approve_waterbody: 'Approved drawn body',
  reject_waterbody: 'Rejected drawn body',
  set_curated_boost: 'Set curated boost',
  set_reference_links: 'Set reference links',
  set_aliases: 'Set aliases',
  set_class: 'Set class',
  set_moderator_towns: 'Pinned towns',
  set_included_by_request: 'Changed kept by request',
  set_standing: 'Set standing',
  activate_body: 'Activated body',
  demote_body: 'Made body dormant',
  approve_request: 'Approved request',
  decline_request: 'Declined request',
  set_put_in: 'Placed put-in',
  resolve_flag: 'Actioned flag',
  dismiss_flag: 'Dismissed flag',
  grant_role: 'Granted role',
  revoke_role: 'Revoked role',
  grant_ledger_editor: 'Gave ledger editing',
  revoke_ledger_editor: 'Took ledger editing',
  set_posting_permission: 'Changed posting rights',
  promote_body_feature: 'Promoted hazard to feature',
  demote_body_feature: 'Demoted known feature',
  merge_hazards: 'Merged hazards',
  unmerge_hazards: 'Unmerged hazards',
  dismiss_duplicate: 'Kept bodies distinct',
  suppress_recurrence: 'Suppressed recurring hazard',
  unsuppress_recurrence: 'Brought back recurring hazard',
  promote_recurrence: 'Promoted recurring hazard',
  set_weather_sample_points: 'Set weather sample points',
  set_lake_depth: 'Set depth',
  choose_depth_source: 'Chose depth source',
  update_body_feature_shape: 'Redrew known feature',
  set_imagery_override: 'Called a satellite pass',
  create_sub_area: 'Drew sub-area',
  redraw_sub_area: 'Redrew sub-area',
  rename_sub_area: 'Renamed sub-area',
  set_water_body_name: 'Chose name',
  set_parking_area: 'Set parking area',
  set_approach_kind: 'Set approach',
  pin_access_alert: 'Pinned access alert',
  unpin_access_alert: 'Unpinned access alert',
  retract_access_alert: 'Retracted access alert',
  // The Inbox's inverses (B01-5); wording for the copy pass.
  reopen_flag: 'Reopened flag',
  reopen_request: 'Reopened request',
  return_to_review: 'Returned drawn body to review',
  unretract_access_alert: 'Restored access alert',
  // Support (B01-5f, D284): a reply's row says it was written, never that it reached anyone.
  support_note: 'Added staff note',
  remove_support_note: 'Removed staff note',
  support_reply: 'Wrote email reply',
  cancel_support_reply: 'Canceled email reply before it was sent',
  resolve_ticket: 'Resolved ticket',
  reopen_ticket: 'Reopened ticket',
  // T0 PLACEHOLDER (B01-5e): words for the copy pass; the photos slice's web builder settles it.
  purge_photo: 'Deleted photo file',
  author_resolve_access_alert: 'Said “It’s open” on their pinned alert',
  set_posted_access: 'Set posted rules',
  set_satellite_imagery: 'Set satellite link',
  set_public_access: 'Ruled public access',
  create_landmark: 'Named landmark',
  edit_landmark: 'Edited landmark',
  promote_landmark: 'Promoted landmark',
  // The Corpus tasks' Keep (B01-6a): a name or class kept as recorded, and its undo. Words for
  // the copy pass.
  settle_review_reason: 'Kept as it is',
  unsettle_review_reason: 'Reopened a kept question',
};

/**
 * `set_ice_color` → "Set ice color": the fallback for a verb this build has no words for — only a
 * server deployed ahead of the client can send one.
 */
export function verbWords(action: string): string {
  const words = action.replaceAll('_', ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function actionWords(action: string): string {
  return (ACTION_WORDS as Partial<Record<string, string>>)[action] ?? verbWords(action);
}

/** A target type's word, for a row no read names. Typed over the table's union, as the verbs are. */
const TARGET_WORDS: Record<AuditTarget, string> = {
  report: 'Report',
  post: 'Post',
  comment: 'Comment',
  photo: 'Photo',
  user: 'Person',
  waterbody: 'Body',
  contentFlag: 'Flag',
  hazard: 'Hazard',
  bodyFeature: 'Known feature',
  waterBodySubArea: 'Sub-area',
  hazardRecurrence: 'Recurring hazard',
  putIn: 'Put-in',
  parkingArea: 'Parking area',
  accessAlert: 'Access alert',
  waterBodyRequest: 'Request',
  bodyLandmark: 'Landmark',
  corpusPlaceName: 'Place name',
  supportTicket: 'Support ticket',
};

/**
 * Staff are named by first name (the boards' rule); a skater acting on their own — an
 * `author_delete`, or their "It's open" on their own pinned access alert — is named in full. The
 * rule is the audit's one (`actorWords`), shared with a body's history.
 */
function actorName(row: ActionRow): string | null {
  return actorWords(row.actor, row.action);
}

/**
 * The machine's rows (`console.systemFeed`): no actor, which the feed draws as *system*, the way it
 * draws an automatic action; the verb and the target's name come from the server.
 */
export function feedFromSystem(rows: readonly SystemFeedRow[]): FeedRow[] {
  return rows.map((row) => ({ ...row, target: { ...row.target } }));
}

/** People's rows and the machine's, newest first, at most `limit`. */
export function mergeFeed(
  people: readonly FeedRow[],
  system: readonly FeedRow[],
  limit: number,
): FeedRow[] {
  return [...people, ...system].sort((a, b) => b.at - a.at).slice(0, limit);
}

export function feedFromActions(rows: readonly ActionRow[]): FeedRow[] {
  return rows.map((row) => ({
    id: row.id,
    at: row.createdAt,
    actor: actorName(row),
    ...(row.via !== undefined ? { via: row.via } : {}),
    action: actionWords(row.action),
    target: {
      type: row.targetType,
      id: row.targetId,
      label:
        (TARGET_WORDS as Partial<Record<string, string>>)[row.targetType] ??
        verbWords(row.targetType),
    },
  }));
}

/** The Inbox card's foot: "Oldest open 4 d · median age 1.5 d", or nothing with nothing open. */
export function inboxFootAges(
  data: InboxCardData,
  now: number,
): { oldestMs: number; medianMs: number | null } | null {
  if (data.oldestOpenAt === null) return null;
  return {
    oldestMs: Math.max(0, now - data.oldestOpenAt),
    medianMs: data.medianOpenedAt === null ? null : Math.max(0, now - data.medianOpenedAt),
  };
}

/** The People card's suspension detail: one end date, or the soonest of several. */
export function suspensionDetail(
  suspended: Count,
  nextEnds: number | null,
  format: (at: number) => string,
): string | null {
  if (nextEnds === null || suspended.count === 0) return null;
  return suspended.count === 1 && !suspended.capped
    ? `until ${format(nextEnds)}`
    : `next ends ${format(nextEnds)}`;
}
