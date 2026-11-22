/**
 * **The dev inbox seed** (D287, B01-5): dev's Inbox filled with realistic work, safely, repeatably
 * and removably. Driven by `scripts/seed-inbox`; every function here refuses on any deployment that
 * isn't dev (`assertSeedDeployment`, by the deployment's own URL).
 *
 * - **`ensurePeople`** inserts the eight fake people of `lib/seedPeople` (no Clerk account, every
 *   toggle and channel off, no email, no push token) with their People rows.
 * - **`state`** is the plan, read against what the deployment holds: every step below is *done* (the
 *   row it files exists — found by a stable seed key, never by counting), *ready* (its inputs exist;
 *   returned with its arguments resolved, for the script to file through the real public mutation as
 *   the person it names), *waiting* on an earlier step, or *unavailable* here (dev has no body of the
 *   kind it needs). The script files the ready steps, then asks again, until nothing is ready — so a
 *   second run files nothing new.
 * - **`clear`** removes every row a fake person wrote or that is about one, then the people, a byte
 *   budget at a time (see its doc).
 *
 * **Every seeded row goes through the same writers as real use.** A flag, a request, a ticket, a
 * report, a comment, a hazard, an alert, a drawn body, a rating, a vote and every moderator act is
 * filed through its public mutation by `convex run --identity` — the fake person's for what a skater
 * does, the operator's (`CONVEX_RUN_AS`) for what a moderator does — so each writes its own audit
 * rows and files or moves its own Inbox item. The two things no public mutation can write are
 * written here, as the design says: the profiles themselves, and the recorded tracks a drawn body is
 * derived from (`ensureActivity`; a skater's phone uploads them, and an uploaded track over a known
 * lake resolves to it, so `waterBodies.create` would refuse the overlap the Inbox needs to show).
 *
 * **Content and D3.** Every word below is a skater's plausible observation — what they saw, measured
 * or did — and none says or implies the ice is safe, skateable or good to go.
 */

import {
  allLevels,
  cellForPoint,
  type LatLng,
  NOTIFICATION_PREF_KEYS,
  nameSortKey,
  pointInPolygon,
  RISK_ACK_VERSION,
  representativePoint,
  SCOPE_ALL,
  standingOf,
} from '@skating/core';
import { ConvexError, v } from 'convex/values';
import type { LineString, MultiPolygon, Polygon } from 'geojson';
import { internal } from './_generated/api';
import type { Doc, Id, TableNames } from './_generated/dataModel';
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from './_generated/server';
import { queueLibraryRefresh, refreshBodyLibrary } from './lib/bodyLibrary';
import { dropBodyNames } from './lib/bodyNames';
import { queueSummaryRefresh } from './lib/bodySummary';
import { ADMIN_AREA_LADDER } from './lib/cellIndex';
import { bumpContributionCount, visibleDelta } from './lib/contributionCounts';
import {
  bodySource,
  flagSource,
  type InboxSource,
  leaveMember,
  MAX_MEMBERS,
  requestSource,
  ticketSource,
} from './lib/inboxItems';
import { liveSurvivorOf } from './lib/inboxRules';
import { isListed } from './lib/listing';
import { refreshPersonRow } from './lib/peopleRows';
import { DOC_MAX, ReadBudget, ROW_MAX, type RowKind, TX_BUDGET } from './lib/readBudget';
import { bumpBountyPoints, bumpReputation } from './lib/reputation';
import {
  assertSeedDeployment,
  hasTestSurname,
  SEED_CAST,
  SEED_PERSON_KEYS,
  SEED_VIA,
  type SeedPersonKey,
  seedPerson,
} from './lib/seedPeople';
import { literals } from './lib/validators';
import { dropWithdrawal, WITHDRAWAL_DROP_COST } from './lib/withdrawals';

// ── The plan's vocabulary ────────────────────────────────────────────────────────────────────────

/** Who files a step: a fake person, the operator (`CONVEX_RUN_AS`), or a bare internal call. */
export type SeedActor = SeedPersonKey | 'operator' | 'bare';

/** The bodies the plan files against: five real dev bodies by name, and four by standing. */
export const SEED_NAMED_BODIES = {
  mascoma: 'Mascoma Lake',
  caspian: 'Caspian Lake',
  morey: 'Lake Morey',
  tomhannock: 'Tomhannock Reservoir',
  newfound: 'Newfound Lake',
} as const;
type NamedRole = keyof typeof SEED_NAMED_BODIES;
/**
 * The real bodies the seed files *about* — reports, a pin, access reports, a bay and a takedown ask,
 * landmark asks — and nothing more: every body an ask or an operator act needs in some state (dormant,
 * ruled closed, removed, ruled accessible) is one the seed drew, approved and put in that state
 * itself, so the plan is complete on any dev. Each role is pinned to the body the seed's own first row
 * on it names, so a role is never filed again on another body.
 */
export type SeedBodyRole = NamedRole;

/** One step ready to file: the public function, its resolved arguments and who it is filed as. */
export interface SeedCall {
  key: string;
  label: string;
  as: SeedActor;
  /** The Clerk subject a fake person's step goes out as (`--identity`); absent otherwise. */
  clerkUserId?: string;
  fn: string;
  args: Record<string, unknown>;
}

/** A required input the deployment doesn't hold (yet, or at all). */
class Missing extends Error {
  constructor(
    readonly what: string,
    readonly waiting: boolean,
  ) {
    super(what);
  }
}

interface Refs {
  now: number;
  person(key: SeedPersonKey): Id<'profiles'>;
  body(role: SeedBodyRole): Doc<'waterBodies'>;
  /** What an earlier step filed (its row's id). */
  out(stepKey: string): string;
  /** A live launch on Caspian Lake, for the access alerts. */
  launch(): Id<'putIns'>;
  /** The Inbox item an earlier step's flag is a member of, for the Inbox's own writes. */
  item(flagStepKey: string): Promise<string>;
  /**
   * The merge-proof drawing's live survivor (B01-5d) — read from the drawing
   * `waterBodies.create` ranked, as the Inbox reads it (`liveSurvivorOf`), so the survivor side's
   * rows land on the body a merge would keep.
   */
  survivor(drawnStepKey: string): Promise<Id<'waterBodies'>>;
  /** The loaded town under a point, by its boundary key — what a moderator's pin names. */
  townAt(point: LatLng): Promise<string>;
}

interface StepDef {
  key: string;
  label: string;
  as: SeedActor;
  fn: string;
  /** Steps that must be done before this one (beyond those its `args` read through `out`). */
  after?: readonly string[];
  args(r: Refs): Record<string, unknown> | Promise<Record<string, unknown>>;
  /** The id of the row this step filed, or `'done'`, or `null` while it isn't filed. */
  find(ctx: QueryCtx, r: Refs): Promise<string | null>;
}

/** The idempotency key a seeded report, hazard or alert carries: the step's own key. */
export const seedKey = (stepKey: string) => `${SEED_VIA}:${stepKey}`;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// ── Geometry helpers ─────────────────────────────────────────────────────────────────────────────

/** A point inside the body (never its stored `centroid`, which can sit on the shore). */
function pointOf(body: Doc<'waterBodies'>): LatLng {
  return (
    body.representativePoint ??
    representativePoint(body.polygon as unknown as Polygon | MultiPolygon)
  );
}

/** `p` moved `north` and `east` meters. */
export function offset(p: LatLng, north: number, east: number): LatLng {
  const lat = p.lat + north / 111_320;
  const lng = p.lng + east / (111_320 * Math.cos((p.lat * Math.PI) / 180));
  return { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 };
}

/** A recorded loop of `radius` meters around `center`: twelve fixes, closed. */
export function loopPath(center: LatLng, radius: number): LineString {
  const coordinates: [number, number][] = [];
  for (let i = 0; i <= 12; i++) {
    const a = (i / 12) * 2 * Math.PI;
    const p = offset(center, radius * Math.sin(a), radius * Math.cos(a));
    coordinates.push([p.lng, p.lat]);
  }
  return { type: 'LineString', coordinates };
}

/** A square of half-side `half` meters around `p`, as an operator draws a bay. */
function squareAround(p: LatLng, half: number): Polygon {
  const corner = (n: number, e: number) => {
    const c = offset(p, n, e);
    return [c.lng, c.lat];
  };
  return {
    type: 'Polygon',
    coordinates: [
      [
        corner(-half, -half),
        corner(half, -half),
        corner(half, half),
        corner(-half, half),
        corner(-half, -half),
      ],
    ],
  };
}

/** The town boundary containing `point`, by the boundary index, as a report's place is found. */
async function townContaining(ctx: QueryCtx, point: LatLng): Promise<Doc<'adminAreas'> | null> {
  for (const z of allLevels(ADMIN_AREA_LADDER)) {
    const cell = cellForPoint(point, z);
    const rows = await ctx.db
      .query('adminAreaCells')
      .withIndex('by_cell', (q) =>
        q.eq('z', cell.z).eq('x', cell.x).eq('y', cell.y).eq('level', 'town'),
      )
      .take(16);
    for (const row of rows) {
      const area = await ctx.db.get(row.adminAreaId);
      if (
        area?.polygon &&
        pointInPolygon(point, area.polygon as unknown as Polygon | MultiPolygon)
      ) {
        return area;
      }
    }
  }
  return null;
}

/** Where each of the seed's own drawn bodies sits — the track and every ask about it share it. */
const newCenter = (r: Refs) => offset(pointOf(r.body('newfound')), 7_000, 7_000);
const dormantCenter = (r: Refs) => offset(pointOf(r.body('caspian')), 6_000, -6_000);
const closedCenter = (r: Refs) => offset(pointOf(r.body('caspian')), -6_000, -9_000);
/** The merge-proof pair's water (B01-5d): two seed lakes and a drawing inside both. */
const proofCenter = (r: Refs) => offset(pointOf(r.body('caspian')), 6_000, 6_000);

// ── The finders: each step's stable seed key ────────────────────────────────────────────────────

async function reportByKey(ctx: QueryCtx, stepKey: string) {
  return (
    (
      await ctx.db
        .query('reports')
        .withIndex('by_idempotency_key', (q) => q.eq('idempotencyKey', seedKey(stepKey)))
        .first()
    )?._id ?? null
  );
}

async function hazardByKey(ctx: QueryCtx, stepKey: string) {
  return (
    (
      await ctx.db
        .query('hazards')
        .withIndex('by_idempotency_key', (q) => q.eq('idempotencyKey', seedKey(stepKey)))
        .first()
    )?._id ?? null
  );
}

async function alertByKey(ctx: QueryCtx, stepKey: string) {
  return (
    (
      await ctx.db
        .query('accessAlerts')
        .withIndex('by_idempotency_key', (q) => q.eq('idempotencyKey', seedKey(stepKey)))
        .first()
    )?._id ?? null
  );
}

/** The flag this person filed on this target with this reason, in any status. */
async function flagBy(
  ctx: QueryCtx,
  flaggerId: Id<'profiles'>,
  targetType: Doc<'contentFlags'>['targetType'],
  targetId: string,
  reason: Doc<'contentFlags'>['reason'],
) {
  const rows = await ctx.db
    .query('contentFlags')
    .withIndex('by_target', (q) => q.eq('targetType', targetType).eq('targetId', targetId))
    .filter((q) => q.eq(q.field('flaggerId'), flaggerId))
    .take(20);
  return rows.find((f) => f.reason === reason)?._id ?? null;
}

/** The ask this person filed, in any status, matched by `match`. */
async function requestBy(
  ctx: QueryCtx,
  requesterId: Id<'profiles'>,
  match: (r: Doc<'waterBodyRequests'>) => boolean,
) {
  const rows = await ctx.db
    .query('waterBodyRequests')
    .withIndex('by_requester_created', (q) => q.eq('requesterId', requesterId))
    .take(50);
  return rows.find(match)?._id ?? null;
}

async function actionOn(
  ctx: QueryCtx,
  targetType: Doc<'moderationActions'>['targetType'],
  targetId: string,
  action: Doc<'moderationActions'>['action'],
) {
  const row = await ctx.db
    .query('moderationActions')
    .withIndex('by_target_action', (q) =>
      q.eq('targetType', targetType).eq('targetId', targetId).eq('action', action),
    )
    .first();
  return row ? 'done' : null;
}

async function activityByKey(ctx: QueryCtx, stepKey: string) {
  return ctx.db
    .query('gpsActivities')
    .withIndex('by_provider_activity', (q) =>
      q.eq('provider', 'gpx').eq('providerActivityId', seedKey(stepKey)),
    )
    .first();
}

/**
 * A body this fake person drew, by its name — found through the Inbox member its drawing filed (its
 * filer is the drawer, and no decision, merge or unmerge moves it), never through the skate it was
 * drawn from, which a merge moves to the survivor (B01-5d).
 */
async function drawnBy(
  ctx: QueryCtx,
  personId: Id<'profiles'>,
  name: string,
): Promise<string | null> {
  for (const m of await drawingMembers(ctx, personId)) {
    const body = await ctx.db.get(m.sourceId as Id<'waterBodies'>);
    if (body?.name === name && body.createdByUserId === personId) return body._id;
  }
  return null;
}

/** The Inbox members a person's drawings filed — a fake person draws a handful. */
function drawingMembers(ctx: QueryCtx, personId: Id<'profiles'>) {
  return ctx.db
    .query('inboxItemMembers')
    .withIndex('by_filer_source_status', (q) =>
      q.eq('filedByUserId', personId).eq('sourceTable', 'waterBodies'),
    )
    .take(50);
}

// ── The steps ────────────────────────────────────────────────────────────────────────────────────

const report = (
  key: string,
  as: SeedPersonKey,
  role: SeedBodyRole,
  label: string,
  content: (r: Refs) => Record<string, unknown>,
  hoursAgo: number,
): StepDef => ({
  key,
  label,
  as,
  fn: 'reports:create',
  args: (r) => ({
    waterBodyId: r.body(role)._id,
    idempotencyKey: seedKey(key),
    skateEndTime: r.now - hoursAgo * HOUR,
    // The skater's own conditions, so no report schedules the weather auto-fill (a metered call).
    conditions: { airTempC: -7, windSpeedKph: 8 },
    ...content(r),
  }),
  find: (ctx) => reportByKey(ctx, key),
});

const flag = (
  key: string,
  as: SeedPersonKey,
  targetType: Doc<'contentFlags'>['targetType'],
  target: (r: Refs) => string,
  reason: Doc<'contentFlags'>['reason'],
  label: string,
  note?: string,
  after?: readonly string[],
): StepDef => ({
  key,
  label,
  as,
  fn: 'contentFlags:flag',
  ...(after ? { after } : {}),
  args: (r) => ({ targetType, targetId: target(r), reason, ...(note ? { note } : {}) }),
  find: (ctx, r) => flagBy(ctx, r.person(as), targetType, target(r), reason),
});

const ask = (
  key: string,
  as: SeedPersonKey,
  kind: Doc<'waterBodyRequests'>['kind'],
  label: string,
  where: (r: Refs) => { waterBodyId?: Id<'waterBodies'>; coord: LatLng },
  extra: { note?: string; name?: string } = {},
  after?: readonly string[],
): StepDef => ({
  key,
  label,
  as,
  fn: 'corpusRequests:create',
  ...(after ? { after } : {}),
  args: (r) => ({ kind, ...where(r), ...extra }),
  find: (ctx, r) => {
    const w = where(r);
    return requestBy(
      ctx,
      r.person(as),
      (q) =>
        q.kind === kind &&
        (w.waterBodyId === undefined
          ? q.coord.lat === w.coord.lat && q.coord.lng === w.coord.lng
          : q.waterBodyId === w.waterBodyId) &&
        (extra.name === undefined || q.name === extra.name),
    );
  },
});

const ticket = (
  key: string,
  as: SeedPersonKey,
  category: Doc<'supportTickets'>['category'],
  body: string,
  after?: readonly string[],
): StepDef => ({
  key,
  label: `a ${category} ticket`,
  as,
  fn: 'support:create',
  ...(after ? { after } : {}),
  args: () => ({ category, body }),
  find: async (ctx) => {
    const rows = await ctx.db
      .query('supportTickets')
      .withIndex('by_clerk_user_created', (q) => q.eq('clerkUserId', seedPerson(as).clerkUserId))
      .take(20);
    return rows.find((t) => t.body === body)?._id ?? null;
  },
});

const rate = (key: string, as: SeedPersonKey, reportStep: string): StepDef => ({
  key,
  label: `an unhelpful thumb on ${reportStep}`,
  as,
  fn: 'ratings:rate',
  args: (r) => ({ targetType: 'report', targetId: r.out(reportStep), verdict: 'unhelpful' }),
  find: async (ctx, r) =>
    (
      await ctx.db
        .query('reportRatings')
        .withIndex('by_rater_target', (q) =>
          q
            .eq('raterId', r.person(as))
            .eq('targetType', 'report')
            .eq('targetId', r.out(reportStep)),
        )
        .first()
    )?._id ?? null,
});

const neverThere = (key: string, as: SeedPersonKey): StepDef => ({
  key,
  label: 'a vote that the hazard was never there',
  as,
  fn: 'hazardConfirmations:confirm',
  args: (r) => ({ hazardId: r.out('h-crack'), verdict: 'never_existed', via: 'app_open_nearby' }),
  find: async (ctx, r) =>
    (
      await ctx.db
        .query('hazardConfirmations')
        .withIndex('by_hazard_and_user', (q) =>
          q.eq('hazardId', r.out('h-crack') as Id<'hazards'>).eq('userId', r.person(as)),
        )
        .first()
    )?._id ?? null,
});

/** Every step a fake person files, for the steps that must come after all of them. */
const filedBy = (steps: readonly StepDef[], who: SeedPersonKey) =>
  steps.filter((s) => s.as === who).map((s) => s.key);

/**
 * **The plan.** In filing order; `state` returns each step once its inputs exist. What it files, by
 * lane: Safety (a report three people flag as a false claim; a hazard two people say was never
 * there), Access reports (three reports on one body; two disputing a ruling), Requests (all five
 * body kinds, siblings on `activate` and `admit`), Places asked (a bay three people ask for; a
 * landmark two people name as one place, and a lookalike by name elsewhere), Drawn bodies (one over a
 * known body, one over new water), Content flags (spam with an automatic flag counted three times,
 * a rude comment, a person, a pinned access alert, and the decided history), Support (every
 * category, an appeal from a suspended person). Decided, by the operator on what a fake person filed (D289),
 * through the Inbox's own writes and the ask's and drawing's mutations: hidden, removed, dismissed, unpinned,
 * restored, an ask approved and one declined, a drawing approved and one rejected. And for People: a suspension with terms, a ban, a
 * lifted suspension, a posting restriction, a hidden and a removed report, and a report its author
 * deleted, kept on the record.
 */
export function seedSteps(): StepDef[] {
  const content: StepDef[] = [
    report(
      'r-black-ice',
      'ada',
      'mascoma',
      'a black-ice report three people flag as a false claim',
      () => ({
        iceTypes: ['black_ice'],
        skateQuality: 'good',
        iceThickness: { readings: [{ valueCm: 9, method: 'measured' }] },
        notes:
          'Black ice off the north launch. Drilled two holes near the launch, 9 and 10 cm. Kept to the east shore.',
      }),
      5,
    ),
    report(
      'r-sharpening',
      'ben',
      'mascoma',
      'a report that is an advertisement',
      () => ({
        surfaceTags: ['smooth'],
        skateQuality: 'fair',
        notes: 'Skate sharpening this weekend, cheap rates. Message me.',
      }),
      7,
    ),
    report(
      'r-caspian',
      'cleo',
      'caspian',
      'a report a moderator hides',
      () => ({
        surfaceTags: ['bumpy'],
        skateQuality: 'poor',
        notes: 'Bumpy and snow-crusted along the west side, lots of old tracks frozen in.',
      }),
      9,
    ),
    report(
      'r-morey',
      'dev',
      'morey',
      'a report a moderator removes',
      () => ({
        surfaceTags: ['rough'],
        skateQuality: 'fair',
        notes: 'Rough surface with wind-packed snow in patches near the inn.',
      }),
      11,
    ),
    report(
      'r-newfound',
      'elin',
      'newfound',
      'a report its author deletes after it is flagged',
      () => ({
        surfaceTags: ['rough'],
        skateQuality: 'fair',
        notes:
          'Pressure crack running out from the point. Went around it. Some people here need to learn to share the ice.',
      }),
      13,
    ),
    report(
      'r-loon-1',
      'cleo',
      'newfound',
      'a report naming a spot no map has (a landmark ask)',
      (r) => ({
        skateQuality: 'fair',
        surfaceTags: [
          {
            type: 'rough',
            where: {
              point: {
                coord: offset(pointOf(r.body('newfound')), 300, 0),
                radiusMeters: 50,
                name: 'Loon Rock',
              },
            },
          },
        ],
        notes: 'Rough ice by Loon Rock.',
      }),
      15,
    ),
    report(
      'r-loon-2',
      'dev',
      'newfound',
      'a second report naming the same spot (one place, two askers)',
      (r) => ({
        skateQuality: 'fair',
        surfaceTags: [
          {
            type: 'rough',
            where: {
              point: {
                coord: offset(pointOf(r.body('newfound')), 320, 10),
                radiusMeters: 50,
                name: 'Loon Rock',
              },
            },
          },
        ],
        notes: 'Chunky refrozen slush around Loon Rock.',
      }),
      16,
    ),
    report(
      'r-loon-3',
      'finn',
      'newfound',
      'a report naming a spot by the same name elsewhere (a lookalike)',
      (r) => ({
        skateQuality: 'fair',
        surfaceTags: [
          {
            type: 'bumpy',
            where: {
              point: {
                coord: offset(pointOf(r.body('newfound')), -900, 400),
                radiusMeters: 50,
                name: 'Loon Rock',
              },
            },
          },
        ],
        notes: 'Bumpy past Loon Rock on the south end.',
      }),
      17,
    ),
    {
      key: 'c-rude',
      label: 'a rude comment',
      as: 'finn',
      fn: 'comments:create',
      args: (r) => ({
        reportId: r.out('r-black-ice'),
        body: 'Nobody asked you. Stay off our lake.',
      }),
      find: async (ctx, r) => {
        const rows = await ctx.db
          .query('comments')
          .withIndex('by_report', (q) => q.eq('reportId', r.out('r-black-ice') as Id<'reports'>))
          .take(50);
        return rows.find((c) => c.authorId === r.person('finn'))?._id ?? null;
      },
    },
    {
      key: 'h-crack',
      label: 'a hazard two people say was never there',
      as: 'gus',
      fn: 'hazards:create',
      args: (r) => {
        const p = offset(pointOf(r.body('tomhannock')), 200, 0);
        return {
          waterBodyId: r.body('tomhannock')._id,
          idempotencyKey: seedKey('h-crack'),
          type: 'wet_crack',
          geometryKind: 'point_radius',
          geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
          radiusMeters: 40,
          description: 'Wet crack across the north arm.',
        };
      },
      find: (ctx) => hazardByKey(ctx, 'h-crack'),
    },
    {
      key: 'a-gate',
      label: 'an access alert on a launch, later pinned',
      as: 'hana',
      fn: 'accessAlerts:create',
      args: (r) => ({
        targetType: 'put_in',
        putInId: r.launch(),
        reason: 'gate_locked',
        note: 'Gate at the boat launch locked, new sign up.',
        idempotencyKey: seedKey('a-gate'),
      }),
      find: (ctx) => alertByKey(ctx, 'a-gate'),
    },
    {
      key: 'a-plank',
      label: 'a second access alert, flagged and left open',
      as: 'hana',
      fn: 'accessAlerts:create',
      args: (r) => ({
        targetType: 'put_in',
        putInId: r.launch(),
        reason: 'plank_needed',
        note: 'Open lead along the shore at the launch; bring a plank.',
        idempotencyKey: seedKey('a-plank'),
      }),
      find: (ctx) => alertByKey(ctx, 'a-plank'),
    },
    report(
      'r-restore',
      'hana',
      'caspian',
      'a report hidden from the record sheet, then restored from the Inbox',
      () => ({
        surfaceTags: ['smooth'],
        skateQuality: 'fair',
        notes: 'Snow cleared in a strip off the public ramp. Stayed inside the strip.',
      }),
      19,
    ),
  ];

  const flags: StepDef[] = [
    flag(
      'f-false-ben',
      'ben',
      'report',
      (r) => r.out('r-black-ice'),
      'unsafe_false_report',
      'a safety flag on the black-ice report',
      'Open water 50 m from where the holes were. I was there the same afternoon.',
    ),
    flag(
      'f-false-cleo',
      'cleo',
      'report',
      (r) => r.out('r-black-ice'),
      'unsafe_false_report',
      'a second safety flag on it',
      'Measured 4 cm at the same launch an hour later.',
    ),
    flag(
      'f-false-dev',
      'dev',
      'report',
      (r) => r.out('r-black-ice'),
      'unsafe_false_report',
      'a third safety flag on it',
    ),
    flag('f-spam', 'ada', 'report', (r) => r.out('r-sharpening'), 'spam', 'a spam flag'),
    flag(
      'f-inappropriate',
      'elin',
      'report',
      (r) => r.out('r-caspian'),
      'inappropriate',
      'an inappropriate flag, later actioned',
      'Photo of someone’s house in the background.',
    ),
    flag(
      'f-other-morey',
      'hana',
      'report',
      (r) => r.out('r-morey'),
      'other',
      'a flag, later actioned with a removal',
      'Copied word for word from an older post.',
    ),
    flag(
      'f-rude',
      'ada',
      'comment',
      (r) => r.out('c-rude'),
      'harassment',
      'a harassment flag on a comment',
    ),
    flag(
      'f-person',
      'cleo',
      'user',
      (r) => r.person('finn'),
      'harassment',
      'a flag on a person',
      'Rude in the comments on three reports this week.',
    ),
    flag(
      'f-alert',
      'finn',
      'accessAlert',
      (r) => r.out('a-gate'),
      'other',
      'a flag on the pinned access alert',
      'The gate has been open all week.',
      ['pin-gate'],
    ),
    flag(
      'f-plank',
      'elin',
      'accessAlert',
      (r) => r.out('a-plank'),
      'other',
      'a flag on an access alert, left open',
      'Walked out from that launch yesterday and saw no gap at the shore.',
    ),
    flag(
      'f-restore',
      'gus',
      'report',
      (r) => r.out('r-restore'),
      'inappropriate',
      'a flag on a report hidden before anyone ruled on it (restored and dismissed)',
      'Is the plate on that truck readable?',
    ),
    flag(
      'f-harass-newfound',
      'gus',
      'report',
      (r) => r.out('r-newfound'),
      'harassment',
      'a harassment flag on a report its author then deletes',
      'The last line is aimed at the group from the north shore.',
    ),
    flag(
      'f-dismissed',
      'ben',
      'report',
      (r) => r.out('r-loon-1'),
      'other',
      'a flag, later dismissed',
      'Not sure this is the right lake.',
    ),
  ];

  const automatic: StepDef[] = [
    rate('rate-cleo', 'cleo', 'r-sharpening'),
    rate('rate-dev', 'dev', 'r-sharpening'),
    rate('rate-elin', 'elin', 'r-sharpening'),
    rate('rate-finn', 'finn', 'r-sharpening'),
    rate('rate-gus', 'gus', 'r-sharpening'),
    neverThere('never-ada', 'ada'),
    neverThere('never-ben', 'ben'),
  ];

  const access: StepDef[] = [
    flag(
      'acc-ada',
      'ada',
      'waterbody',
      (r) => r.body('tomhannock')._id,
      'no_public_access',
      'an access report',
      'Posted: water supply, no trespassing.',
    ),
    flag(
      'acc-ben',
      'ben',
      'waterbody',
      (r) => r.body('tomhannock')._id,
      'no_public_access',
      'a second access report',
    ),
    flag(
      'acc-cleo',
      'cleo',
      'waterbody',
      (r) => r.body('tomhannock')._id,
      'no_public_access',
      'a third access report',
      'Every pull-off has a city sign.',
    ),
    flag(
      'dispute-dev',
      'dev',
      'waterbody',
      (r) => r.out('drawn-beach'),
      'no_public_access',
      'a report disputing the ruling on a body the seed drew',
      'The town put a no-trespassing sign on the beach lot this month.',
      ['rule-beach'],
    ),
    flag(
      'dispute-elin',
      'elin',
      'waterbody',
      (r) => r.out('drawn-beach'),
      'no_public_access',
      'a second report disputing it',
      'The beach lot is chained off now.',
      ['rule-beach'],
    ),
  ];

  const mascomaCove = (r: Refs) => ({
    waterBodyId: r.body('mascoma')._id,
    coord: offset(pointOf(r.body('mascoma')), 1_200, -300),
  });
  const admitHere = (r: Refs) => ({ coord: offset(pointOf(r.body('mascoma')), 5_500, 2_500) });
  // The seed's own bodies each ask is about — drawn, approved and put in the state the ask needs by
  // the operator, so no ask depends on dev holding a real body in that state.
  const onSeedBody = (step: string, center: (r: Refs) => LatLng) => (r: Refs) => ({
    waterBodyId: r.out(step) as Id<'waterBodies'>,
    coord: center(r),
  });
  const requests: StepDef[] = [
    ask(
      'req-activate-ada',
      'ada',
      'activate',
      'an ask to bring back a body the seed drew and shelved',
      onSeedBody('drawn-dormant', dormantCenter),
      { note: 'Skated it every weekend last winter.' },
      ['shelve-dormant'],
    ),
    ask(
      'req-activate-ben',
      'ben',
      'activate',
      'a sibling ask on the same body',
      onSeedBody('drawn-dormant', dormantCenter),
      {},
      ['shelve-dormant'],
    ),
    ask('req-admit-cleo', 'cleo', 'admit', 'an ask to add water we do not know', admitHere, {
      note: 'Beaver pond behind the trailhead lot.',
    }),
    ask('req-admit-dev', 'dev', 'admit', 'a sibling ask at the same spot', admitHere),
    ask(
      'req-admit-elin',
      'elin',
      'admit',
      'an ask where there is no water (later declined)',
      (r) => ({ coord: offset(pointOf(r.body('newfound')), 8_000, -6_000) }),
    ),
    ask(
      'req-restore-finn',
      'finn',
      'restore',
      'an ask to put back the drawing the approved takedown removed',
      onSeedBody('drawn-new', newCenter),
      { note: 'People still skate here every winter.' },
      ['approve-takedown'],
    ),
    ask(
      'req-contest-gus',
      'gus',
      'contest_access',
      'an ask contesting a no-access ruling on a body the seed drew',
      onSeedBody('drawn-closed', closedCenter),
      { note: 'There is a public launch on the east side now.' },
      ['rule-closed'],
    ),
    ask(
      'req-takedown-hana',
      'hana',
      'takedown',
      'an ask to take a body down',
      (r) => ({ waterBodyId: r.body('caspian')._id, coord: pointOf(r.body('caspian')) }),
      { note: 'Private shore; the owner asks people not to cross.' },
    ),
    ask('req-bay-ada', 'ada', 'name_bay', 'a bay ask', mascomaCove, { name: 'North Cove' }),
    ask('req-bay-ben', 'ben', 'name_bay', 'a second asker for the bay', mascomaCove, {
      name: 'North Cove',
    }),
    ask('req-bay-cleo', 'cleo', 'name_bay', 'a third asker for the bay', mascomaCove, {
      name: 'North Cove',
    }),
  ];

  const drawn: StepDef[] = [
    {
      key: 'track-overlap',
      label: 'a recorded loop over a known body',
      as: 'bare',
      fn: 'inboxSeed:ensureActivity',
      args: (r) => ({
        person: 'finn',
        key: 'track-overlap',
        path: loopPath(pointOf(r.body('morey')), 180),
        startTime: r.now - 30 * HOUR,
      }),
      find: async (ctx) => (await activityByKey(ctx, 'track-overlap'))?._id ?? null,
    },
    {
      key: 'track-new',
      label: 'a recorded loop over water no map has',
      as: 'bare',
      fn: 'inboxSeed:ensureActivity',
      args: (r) => ({
        person: 'gus',
        key: 'track-new',
        path: loopPath(newCenter(r), 160),
        startTime: r.now - 28 * HOUR,
      }),
      find: async (ctx) => (await activityByKey(ctx, 'track-new'))?._id ?? null,
    },
    {
      key: 'track-beach',
      label: 'a recorded loop off a town beach',
      as: 'bare',
      fn: 'inboxSeed:ensureActivity',
      args: (r) => ({
        person: 'elin',
        key: 'track-beach',
        path: loopPath(offset(pointOf(r.body('newfound')), -7_000, 7_000), 150),
        startTime: r.now - 32 * HOUR,
      }),
      find: async (ctx) => (await activityByKey(ctx, 'track-beach'))?._id ?? null,
    },
    {
      key: 'drawn-beach',
      label: 'a body drawn off a town beach (approved, then ruled accessible, then disputed)',
      as: 'elin',
      fn: 'waterBodies:create',
      args: (r) => ({
        name: 'Town Beach Pond',
        type: 'lakePond',
        activityId: r.out('track-beach'),
        confirmedNew: true,
      }),
      find: (ctx, r) => drawnBy(ctx, r.person('elin'), 'Town Beach Pond'),
    },
    {
      key: 'track-dormant',
      label: 'a recorded loop on a quiet pond',
      as: 'bare',
      fn: 'inboxSeed:ensureActivity',
      args: (r) => ({
        person: 'cleo',
        key: 'track-dormant',
        path: loopPath(dormantCenter(r), 140),
        startTime: r.now - 34 * HOUR,
      }),
      find: async (ctx) => (await activityByKey(ctx, 'track-dormant'))?._id ?? null,
    },
    {
      key: 'drawn-dormant',
      label: 'a body drawn on a quiet pond (approved, then shelved, then asked back)',
      as: 'cleo',
      fn: 'waterBodies:create',
      args: (r) => ({
        name: 'Quiet Hollow Pond',
        type: 'lakePond',
        activityId: r.out('track-dormant'),
        confirmedNew: true,
      }),
      find: (ctx, r) => drawnBy(ctx, r.person('cleo'), 'Quiet Hollow Pond'),
    },
    {
      key: 'track-closed',
      label: 'a recorded loop on a posted pond',
      as: 'bare',
      fn: 'inboxSeed:ensureActivity',
      args: (r) => ({
        person: 'dev',
        key: 'track-closed',
        path: loopPath(closedCenter(r), 140),
        startTime: r.now - 36 * HOUR,
      }),
      find: async (ctx) => (await activityByKey(ctx, 'track-closed'))?._id ?? null,
    },
    {
      key: 'drawn-closed',
      label: 'a body drawn on a posted pond (approved, ruled no public access, then contested)',
      as: 'dev',
      fn: 'waterBodies:create',
      args: (r) => ({
        name: 'Posted Farm Pond',
        type: 'lakePond',
        activityId: r.out('track-closed'),
        confirmedNew: true,
      }),
      find: (ctx, r) => drawnBy(ctx, r.person('dev'), 'Posted Farm Pond'),
    },
    {
      key: 'track-reject',
      label: 'a recorded loop over a parking lot',
      as: 'bare',
      fn: 'inboxSeed:ensureActivity',
      args: (r) => ({
        person: 'hana',
        key: 'track-reject',
        path: loopPath(offset(pointOf(r.body('caspian')), -6_000, 5_000), 120),
        startTime: r.now - 26 * HOUR,
      }),
      find: async (ctx) => (await activityByKey(ctx, 'track-reject'))?._id ?? null,
    },
    {
      key: 'drawn-reject',
      label: 'a body drawn over dry land (later rejected)',
      as: 'hana',
      fn: 'waterBodies:create',
      args: (r) => ({
        name: 'Trailhead Lot Pond',
        type: 'lakePond',
        activityId: r.out('track-reject'),
        confirmedNew: true,
      }),
      find: (ctx, r) => drawnBy(ctx, r.person('hana'), 'Trailhead Lot Pond'),
    },
    {
      key: 'drawn-overlap',
      label: 'a body drawn over a known body',
      as: 'finn',
      fn: 'waterBodies:create',
      args: (r) => ({
        name: 'Morey East Bay',
        type: 'lakePond',
        activityId: r.out('track-overlap'),
        confirmedNew: true,
      }),
      find: (ctx, r) => drawnBy(ctx, r.person('finn'), 'Morey East Bay'),
    },
    {
      key: 'drawn-new',
      label: 'a body drawn over new water',
      as: 'gus',
      fn: 'waterBodies:create',
      args: (r) => ({
        name: 'Beaver Flowage',
        type: 'lakePond',
        activityId: r.out('track-new'),
        confirmedNew: true,
      }),
      find: (ctx, r) => drawnBy(ctx, r.person('gus'), 'Beaver Flowage'),
    },
  ];

  const tickets: StepDef[] = [
    ticket(
      't-bug',
      'ada',
      'bug',
      'The map stays blank after I switch to the satellite layer on my phone.',
    ),
    ticket(
      't-safety',
      'gus',
      'safety',
      'A hazard pin on Tomhannock looks like it is on the wrong arm of the reservoir.',
    ),
    ticket('t-other', 'hana', 'other', 'Is there a way to export my reports as a spreadsheet?'),
  ];

  const filed = [
    ...content,
    ...flags,
    ...automatic,
    ...access,
    ...requests,
    ...drawn,
    ...mergeProofSteps(),
    ...tickets,
  ];

  const moderated: StepDef[] = [
    {
      key: 'pin-gate',
      label: 'the access alert pinned',
      as: 'operator',
      fn: 'accessAlerts:setOfficial',
      args: (r) => ({
        accessAlertId: r.out('a-gate'),
        official: true,
        reason: 'Confirmed with the town.',
      }),
      find: (ctx, r) => actionOn(ctx, 'accessAlert', r.out('a-gate'), 'pin_access_alert'),
    },
    {
      key: 'unpin-gate',
      label: 'the pinned alert unpinned from the Inbox',
      as: 'operator',
      fn: 'inboxWrites:alertVerdict',
      after: ['pin-gate'],
      args: async (r) => ({
        itemId: await r.item('f-alert'),
        verb: 'unpin',
        reason: 'The town reopened the gate.',
      }),
      find: (ctx, r) => actionOn(ctx, 'accessAlert', r.out('a-gate'), 'unpin_access_alert'),
    },
    {
      key: 'hide-caspian',
      label: 'a flagged report hidden from the Inbox',
      as: 'operator',
      fn: 'inboxWrites:takeDown',
      args: async (r) => ({
        itemId: await r.item('f-inappropriate'),
        status: 'hidden',
        reason: 'A private home in the photo.',
      }),
      find: (ctx, r) => actionOn(ctx, 'report', r.out('r-caspian'), 'hide'),
    },
    {
      key: 'remove-morey',
      label: 'a flagged report removed from the Inbox',
      as: 'operator',
      fn: 'inboxWrites:takeDown',
      args: async (r) => ({
        itemId: await r.item('f-other-morey'),
        status: 'removed',
        reason: 'Copied from another member’s post.',
      }),
      find: (ctx, r) => actionOn(ctx, 'report', r.out('r-morey'), 'remove'),
    },
    {
      key: 'dismiss-loon',
      label: 'a flag dismissed from the Inbox',
      as: 'operator',
      fn: 'inboxWrites:dismissFlags',
      args: async (r) => ({
        itemId: await r.item('f-dismissed'),
        reason: 'The report is on the right lake.',
      }),
      find: async (ctx, r) =>
        (await ctx.db.get(r.out('f-dismissed') as Id<'contentFlags'>))?.status === 'dismissed'
          ? 'done'
          : null,
    },
    {
      key: 'hide-restore',
      label: 'a flagged report hidden from the record sheet, its flag still open',
      as: 'operator',
      fn: 'moderation:setModerationStatus',
      after: ['f-restore'],
      args: (r) => ({
        targetType: 'report',
        targetId: r.out('r-restore'),
        status: 'hidden',
        reason: 'Checking the photo.',
      }),
      find: (ctx, r) => actionOn(ctx, 'report', r.out('r-restore'), 'hide'),
    },
    {
      key: 'restore-dismiss',
      label: 'the hidden report restored and its flag dismissed, from the Inbox',
      as: 'operator',
      fn: 'inboxWrites:restoreAndDismiss',
      after: ['hide-restore'],
      args: async (r) => ({
        itemId: await r.item('f-restore'),
        reason: 'Nothing readable in the photo.',
      }),
      find: (ctx, r) => actionOn(ctx, 'report', r.out('r-restore'), 'restore'),
    },
    {
      key: 'approve-drawn',
      label: 'a drawing approved',
      as: 'operator',
      fn: 'waterBodies:approve',
      args: (r) => ({ waterBodyId: r.out('drawn-new') }),
      find: async (ctx, r) =>
        (await ctx.db.get(r.out('drawn-new') as Id<'waterBodies'>))?.reviewStatus === 'approved'
          ? 'done'
          : null,
    },
    {
      key: 'approve-beach',
      label: 'the beach drawing approved',
      as: 'operator',
      fn: 'waterBodies:approve',
      args: (r) => ({ waterBodyId: r.out('drawn-beach') }),
      find: async (ctx, r) =>
        (await ctx.db.get(r.out('drawn-beach') as Id<'waterBodies'>))?.reviewStatus === 'approved'
          ? 'done'
          : null,
    },
    {
      key: 'rule-beach',
      label: 'the ruling the dispute is about — on the body the seed drew, never a real one',
      as: 'operator',
      fn: 'waterBodies:setPublicAccess',
      after: ['approve-beach'],
      args: (r) => ({
        waterBodyId: r.out('drawn-beach'),
        verdict: 'open',
        note: 'Town beach launch, open in winter.',
      }),
      find: async (ctx, r) =>
        (await ctx.db.get(r.out('drawn-beach') as Id<'waterBodies'>))?.publicAccess?.verdict ===
        'open'
          ? 'done'
          : null,
    },
    {
      key: 'approve-dormant',
      label: 'the quiet-pond drawing approved',
      as: 'operator',
      fn: 'waterBodies:approve',
      args: (r) => ({ waterBodyId: r.out('drawn-dormant') }),
      find: async (ctx, r) =>
        (await ctx.db.get(r.out('drawn-dormant') as Id<'waterBodies'>))?.reviewStatus === 'approved'
          ? 'done'
          : null,
    },
    {
      key: 'shelve-dormant',
      label:
        'the quiet pond shelved by hand (dormant), so an activate ask has a body of the seed’s',
      as: 'operator',
      fn: 'standing:setStanding',
      after: ['approve-dormant'],
      args: (r) => ({
        waterBodyId: r.out('drawn-dormant'),
        standing: 'dormant',
        note: 'Shelved until someone reports it again.',
      }),
      find: (ctx, r) => actionOn(ctx, 'waterbody', r.out('drawn-dormant'), 'set_standing'),
    },
    {
      key: 'approve-closed',
      label: 'the posted-pond drawing approved',
      as: 'operator',
      fn: 'waterBodies:approve',
      args: (r) => ({ waterBodyId: r.out('drawn-closed') }),
      find: async (ctx, r) =>
        (await ctx.db.get(r.out('drawn-closed') as Id<'waterBodies'>))?.reviewStatus === 'approved'
          ? 'done'
          : null,
    },
    {
      key: 'rule-closed',
      label:
        'the posted pond ruled to have no public access — a body the seed drew, never a real one',
      as: 'operator',
      fn: 'waterBodies:setPublicAccess',
      after: ['approve-closed'],
      args: (r) => ({
        waterBodyId: r.out('drawn-closed'),
        verdict: 'none',
        note: 'Farm land on every side; posted.',
      }),
      find: (ctx, r) => actionOn(ctx, 'waterbody', r.out('drawn-closed'), 'set_public_access'),
    },
    {
      key: 'reject-drawn',
      label: 'a drawing rejected',
      as: 'operator',
      fn: 'waterBodies:reject',
      args: (r) => ({ waterBodyId: r.out('drawn-reject'), reason: 'A parking lot, not water.' }),
      find: async (ctx, r) =>
        (await ctx.db.get(r.out('drawn-reject') as Id<'waterBodies'>))?.reviewStatus === 'rejected'
          ? 'done'
          : null,
    },
    {
      key: 'req-takedown-drawn',
      label: 'an ask to take the approved drawing down (later approved)',
      as: 'ada',
      fn: 'corpusRequests:create',
      after: ['approve-drawn'],
      args: (r) => ({
        kind: 'takedown',
        waterBodyId: r.out('drawn-new'),
        coord: offset(pointOf(r.body('newfound')), 7_000, 7_000),
        note: 'That is a beaver flowage that floods the trail; nobody skates it.',
      }),
      find: (ctx, r) =>
        requestBy(
          ctx,
          r.person('ada'),
          (q) => q.kind === 'takedown' && q.waterBodyId === r.out('drawn-new'),
        ),
    },
    {
      key: 'approve-takedown',
      label: 'the takedown ask approved',
      as: 'operator',
      fn: 'corpusRequests:approve',
      args: (r) => ({ requestId: r.out('req-takedown-drawn'), note: 'Taken down; thanks.' }),
      find: async (ctx, r) =>
        (await ctx.db.get(r.out('req-takedown-drawn') as Id<'waterBodyRequests'>))?.status ===
        'approved'
          ? 'done'
          : null,
    },
    {
      key: 'delete-newfound',
      label: 'a flagged report deleted by its author',
      as: 'elin',
      fn: 'reports:remove',
      after: ['f-harass-newfound'],
      args: (r) => ({ reportId: r.out('r-newfound') }),
      find: async (ctx, r) =>
        (await ctx.db.get(r.out('r-newfound') as Id<'reports'>))?.authorDeletedAt !== undefined
          ? 'done'
          : null,
    },
    {
      key: 'keep-newfound',
      label: 'the deleted report kept on the record',
      as: 'operator',
      fn: 'moderation:keepOnRecord',
      after: ['delete-newfound'],
      args: (r) => ({
        targetType: 'report',
        targetId: r.out('r-newfound'),
        reason: 'Aimed at other skaters; kept with the flag.',
      }),
      find: async (ctx, r) =>
        (await ctx.db
          .query('contentVerdicts')
          .withIndex('by_target_at', (q) =>
            q.eq('targetType', 'report').eq('targetId', r.out('r-newfound')),
          )
          .first())
          ? 'done'
          : null,
    },
    {
      key: 'decline-admit',
      label: 'the no-water ask declined',
      as: 'operator',
      fn: 'corpusRequests:decline',
      args: (r) => ({
        requestId: r.out('req-admit-elin'),
        note: 'No water at that spot on the imagery.',
      }),
      find: async (ctx, r) =>
        (await ctx.db.get(r.out('req-admit-elin') as Id<'waterBodyRequests'>))?.status ===
        'declined'
          ? 'done'
          : null,
    },
    {
      key: 'restrict-cleo',
      label: 'a posting restriction',
      as: 'operator',
      fn: 'moderation:setPostingPermission',
      after: filedBy(filed, 'cleo'),
      args: (r) => ({
        userId: r.person('cleo'),
        permission: 'comments',
        allowed: false,
        reason: 'A heated comment thread; a week to cool off.',
      }),
      find: (ctx, r) => actionOn(ctx, 'user', r.person('cleo'), 'set_posting_permission'),
    },
  ];

  // Discipline last, each after everything its person files (a suspended or banned person can't).
  const discipline: StepDef[] = [
    {
      key: 'suspend-finn',
      label: 'a suspension with terms',
      as: 'operator',
      fn: 'moderation:suspendUser',
      after: filedBy(filed, 'finn'),
      args: (r) => ({
        userId: r.person('finn'),
        reason: 'Repeated rude comments toward other skaters.',
        suspendedUntil: r.now + 14 * DAY,
      }),
      find: (ctx, r) => actionOn(ctx, 'user', r.person('finn'), 'suspend'),
    },
    ticket(
      't-appeal',
      'finn',
      'account',
      'I was suspended for comments I did not think were rude. Could someone look again?',
      ['suspend-finn'],
    ),
    {
      key: 'suspend-dev',
      label: 'a suspension, later lifted',
      as: 'operator',
      fn: 'moderation:suspendUser',
      after: filedBy(filed, 'dev'),
      args: (r) => ({
        userId: r.person('dev'),
        reason: 'Flagging in bulk without notes.',
        suspendedUntil: r.now + 7 * DAY,
      }),
      find: (ctx, r) => actionOn(ctx, 'user', r.person('dev'), 'suspend'),
    },
    {
      key: 'lift-dev',
      label: 'the suspension lifted',
      as: 'operator',
      fn: 'moderation:unbanUser',
      after: ['suspend-dev'],
      args: (r) => ({ userId: r.person('dev'), reason: 'Appeal accepted.' }),
      find: (ctx, r) => actionOn(ctx, 'user', r.person('dev'), 'unban'),
    },
    {
      key: 'ban-ben',
      label: 'a ban',
      as: 'operator',
      fn: 'moderation:banUser',
      after: filedBy(filed, 'ben'),
      args: (r) => ({
        userId: r.person('ben'),
        reason: 'Advertising across reports after a warning.',
      }),
      find: (ctx, r) => actionOn(ctx, 'user', r.person('ben'), 'ban'),
    },
  ];

  return [...filed, ...moderated, ...discipline];
}

// ── The merge-proof pair (B01-5d) ───────────────────────────────────────────────────────────────

/** A seed body read by its step: the row `drawn` filed. */
const bodyOf = (ctx: QueryCtx, r: Refs, stepKey: string) =>
  ctx.db.get(r.out(stepKey) as Id<'waterBodies'>);

/** A merge-proof row found by its body and name, in a table read by body. */
async function namedOn<T extends 'waterBodySubAreas' | 'bodyLandmarks'>(
  ctx: QueryCtx,
  table: T,
  waterBodyId: Id<'waterBodies'>,
  name: string,
): Promise<string | null> {
  const rows =
    table === 'waterBodySubAreas'
      ? await ctx.db
          .query('waterBodySubAreas')
          .withIndex('by_parent', (q) => q.eq('waterBodyId', waterBodyId))
          .take(50)
      : await ctx.db
          .query('bodyLandmarks')
          .withIndex('by_water_body', (q) => q.eq('waterBodyId', waterBodyId))
          .take(50);
  return rows.find((row) => row.name === name)?._id ?? null;
}

async function favoriteOf(ctx: QueryCtx, userId: Id<'profiles'>, waterBodyId: Id<'waterBodies'>) {
  const row = await ctx.db
    .query('waterBodyFavorites')
    .withIndex('by_user_water_body_sub_area', (q) =>
      q.eq('userId', userId).eq('waterBodyId', waterBodyId).eq('subAreaId', undefined),
    )
    .first();
  return row?._id ?? null;
}

/**
 * **The merge-proof pair** (B01-5d, *The dev proof*; the governor's ruling (3), 2026-11-22): a
 * skater's drawing — *Merge Proof Cove* — inside two lakes the seed drew and approved itself, *Merge
 * Proof Pond* and *Merge Proof Pond West*, so the drawing's live survivor is one and the other is its
 * partner, and every row a merge moves sits on one side or the other — never on a real body (D287):
 *
 * - on the drawing: a report, a hazard, a bounty, a put-in, an open bay ask, an open place name, an
 *   open access report, and a second from a person who already reported the survivor (the flag a
 *   merge leaves behind);
 * - favorites: one person favoriting the drawing only, and one favoriting both (the dropped twin);
 * - bays: one of its own on the drawing, and one on each body sharing a name (the merge delists it);
 * - landmarks: a twin across the two (the merge folds it);
 * - moderator lists: an alias, a pin and a link on each.
 *
 * The seed leaves it unmerged: the proof merges it from the Inbox and unmerges it from History.
 * *Morey East Bay* over Lake Morey stays as it was — the item that looks like board 2.5.
 */
function mergeProofSteps(): StepDef[] {
  const track = (key: string, person: SeedPersonKey, radius: number, east = 0): StepDef => ({
    key,
    label: `a recorded loop for the merge-proof pair (${key})`,
    as: 'bare',
    fn: 'inboxSeed:ensureActivity',
    args: (r) => ({
      person,
      key,
      path: loopPath(offset(proofCenter(r), 0, east), radius),
      startTime: r.now - 40 * HOUR,
    }),
    find: async (ctx) => (await activityByKey(ctx, key))?._id ?? null,
  });
  const draw = (
    key: string,
    as: SeedPersonKey,
    trackKey: string,
    name: string,
    after?: readonly string[],
  ): StepDef => ({
    key,
    label: `${name} drawn (the merge-proof pair)`,
    as,
    fn: 'waterBodies:create',
    ...(after ? { after } : {}),
    args: (r) => ({ name, type: 'lakePond', activityId: r.out(trackKey), confirmedNew: true }),
    find: (ctx, r) => drawnBy(ctx, r.person(as), name),
  });
  const approve = (key: string, drawnKey: string): StepDef => ({
    key,
    label: `${drawnKey} approved`,
    as: 'operator',
    fn: 'waterBodies:approve',
    args: (r) => ({ waterBodyId: r.out(drawnKey) }),
    find: async (ctx, r) =>
      (await bodyOf(ctx, r, drawnKey))?.reviewStatus === 'approved' ? 'done' : null,
  });
  type Side = 'cove' | 'survivor';
  const on = async (r: Refs, side: Side): Promise<Id<'waterBodies'>> =>
    side === 'cove' ? (r.out('mp-cove') as Id<'waterBodies'>) : r.survivor('mp-cove');
  /**
   * Where a side's row is found: the cove's own rows on the cove, or — once the cove is merged — on
   * the body it went into, so a seed applied again after a merge finds them all (B01-5d).
   */
  const sidesOf = async (ctx: QueryCtx, r: Refs, side: Side): Promise<Id<'waterBodies'>[]> => {
    const id = await on(r, side);
    if (side !== 'cove') return [id];
    const merged = (await ctx.db.get(id))?.mergedIntoId;
    return merged === undefined ? [id] : [id, merged];
  };
  /** The first id `look` finds on any of a side's bodies. */
  const findOn = async (
    ctx: QueryCtx,
    r: Refs,
    side: Side,
    look: (waterBodyId: Id<'waterBodies'>) => Promise<string | null>,
  ): Promise<string | null> => {
    for (const id of await sidesOf(ctx, r, side)) {
      const found = await look(id);
      if (found !== null) return found;
    }
    return null;
  };
  const bay = (key: string, side: Side, name: string, north: number, east: number): StepDef => ({
    key,
    label: `a bay "${name}" on the merge-proof ${side}`,
    as: 'operator',
    fn: 'subAreas:create',
    after: ['mp-cove'],
    args: async (r) => ({
      waterBodyId: await on(r, side),
      name,
      polygon: squareAround(offset(proofCenter(r), north, east), 50),
    }),
    find: (ctx, r) => findOn(ctx, r, side, (id) => namedOn(ctx, 'waterBodySubAreas', id, name)),
  });
  const landmark = (key: string, side: Side): StepDef => ({
    key,
    label: `the twin landmark on the merge-proof ${side}`,
    as: 'operator',
    fn: 'landmarks:create',
    after: ['mp-cove'],
    args: async (r) => ({
      waterBodyId: await on(r, side),
      name: 'Proof Rock',
      kind: 'point',
      point: offset(proofCenter(r), 120, 0),
    }),
    find: (ctx, r) => findOn(ctx, r, side, (id) => namedOn(ctx, 'bodyLandmarks', id, 'Proof Rock')),
  });
  const alias = (key: string, side: Side, alias: string): StepDef => ({
    key,
    label: `an alias on the merge-proof ${side}`,
    as: 'operator',
    fn: 'waterBodies:setAliases',
    after: ['mp-cove'],
    args: async (r) => ({ waterBodyId: await on(r, side), aliases: [alias] }),
    find: (ctx, r) =>
      findOn(ctx, r, side, async (id) =>
        (await ctx.db.get(id))?.moderatorAliases?.includes(alias) ? 'done' : null,
      ),
  });
  const pin = (key: string, side: Side): StepDef => ({
    key,
    label: `a pinned town on the merge-proof ${side}`,
    as: 'operator',
    fn: 'waterBodies:setModeratorTowns',
    after: ['mp-cove'],
    args: async (r) => ({
      waterBodyId: await on(r, side),
      townKeys: [await r.townAt(proofCenter(r))],
    }),
    find: (ctx, r) =>
      findOn(ctx, r, side, async (id) =>
        ((await ctx.db.get(id))?.moderatorTownKeys?.length ?? 0) > 0 ? 'done' : null,
      ),
  });
  const link = (key: string, side: Side): StepDef => ({
    key,
    label: `a reference link on the merge-proof ${side}`,
    as: 'operator',
    fn: 'waterBodies:setReferenceLinks',
    after: ['mp-cove'],
    args: async (r) => ({
      waterBodyId: await on(r, side),
      links: [{ label: `Merge proof ${side}`, url: `https://example.org/seed-inbox/${side}` }],
    }),
    find: (ctx, r) =>
      findOn(ctx, r, side, async (id) =>
        (await ctx.db.get(id))?.referenceLinks?.some((l) => l.url.endsWith(`/seed-inbox/${side}`))
          ? 'done'
          : null,
      ),
  });
  const favorite = (key: string, as: SeedPersonKey, side: Side): StepDef => ({
    key,
    label: `a favorite of the merge-proof ${side}`,
    as,
    fn: 'waterBodyFavorites:toggle',
    after: ['mp-cove'],
    args: async (r) => ({ waterBodyId: await on(r, side) }),
    find: (ctx, r) => findOn(ctx, r, side, (id) => favoriteOf(ctx, r.person(as), id)),
  });
  const accessReport = (
    key: string,
    as: SeedPersonKey,
    side: Side,
    after: readonly string[] = ['mp-cove'],
  ): StepDef => ({
    key,
    label: `an access report on the merge-proof ${side}`,
    as,
    fn: 'contentFlags:flag',
    after,
    args: async (r) => ({
      targetType: 'waterbody',
      targetId: await on(r, side),
      reason: 'no_public_access',
      note: 'A new gate across the only road in.',
    }),
    find: (ctx, r) =>
      findOn(ctx, r, side, (id) => flagBy(ctx, r.person(as), 'waterbody', id, 'no_public_access')),
  });
  const cove = (r: Refs) => r.out('mp-cove') as Id<'waterBodies'>;

  return [
    track('mp-track-pond', 'ada', 420),
    draw('mp-pond', 'ada', 'mp-track-pond', 'Merge Proof Pond'),
    approve('mp-approve-pond', 'mp-pond'),
    track('mp-track-west', 'gus', 380, -40),
    draw('mp-west', 'gus', 'mp-track-west', 'Merge Proof Pond West', ['mp-approve-pond']),
    approve('mp-approve-west', 'mp-west'),
    track('mp-track-cove', 'hana', 240),
    draw('mp-cove', 'hana', 'mp-track-cove', 'Merge Proof Cove', [
      'mp-approve-pond',
      'mp-approve-west',
    ]),
    // The bounty first: a fresh report on the drawing would answer it before it was asked.
    {
      key: 'mp-bounty',
      label: 'a bounty on the merge-proof drawing',
      as: 'elin',
      fn: 'bounties:createChecked',
      args: (r) => ({ waterBodyId: cove(r), weatherReopenedReports: [] }),
      find: (ctx, r) =>
        findOn(
          ctx,
          r,
          'cove',
          async (id) =>
            (
              await ctx.db
                .query('bounties')
                .withIndex('by_water_body_status', (q) => q.eq('waterBodyId', id))
                .first()
            )?._id ?? null,
        ),
    },
    {
      key: 'mp-report',
      label: 'a report on the merge-proof drawing',
      as: 'ada',
      fn: 'reports:create',
      after: ['mp-bounty'],
      args: (r) => ({
        waterBodyId: cove(r),
        idempotencyKey: seedKey('mp-report'),
        skateEndTime: r.now - 6 * HOUR,
        conditions: { airTempC: -9, windSpeedKph: 5 },
        surfaceTags: ['smooth'],
        skateQuality: 'good',
        notes: 'Smooth gray ice across the cove; skated the east shore loop twice.',
      }),
      find: (ctx) => reportByKey(ctx, 'mp-report'),
    },
    {
      key: 'mp-hazard',
      label: 'a hazard on the merge-proof drawing',
      as: 'gus',
      fn: 'hazards:create',
      after: ['mp-cove'],
      args: (r) => {
        const p = offset(proofCenter(r), -100, 0);
        return {
          waterBodyId: cove(r),
          idempotencyKey: seedKey('mp-hazard'),
          type: 'open_water',
          geometryKind: 'point_radius',
          geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
          radiusMeters: 25,
          description: 'An open lead off the inlet.',
        };
      },
      find: (ctx) => hazardByKey(ctx, 'mp-hazard'),
    },
    {
      key: 'mp-put-in',
      label: 'a launch on the merge-proof drawing',
      as: 'operator',
      fn: 'putIns:setOfficial',
      after: ['mp-cove'],
      args: (r) => ({
        waterBodyId: cove(r),
        coord: offset(proofCenter(r), 0, 240),
        name: 'Proof Launch',
      }),
      find: (ctx, r) =>
        findOn(
          ctx,
          r,
          'cove',
          async (id) =>
            (
              await ctx.db
                .query('putIns')
                .withIndex('by_water_body', (q) => q.eq('waterBodyId', id))
                .take(20)
            ).find((p) => p.name === 'Proof Launch')?._id ?? null,
        ),
    },
    {
      ...ask(
        'mp-ask-bay',
        'elin',
        'name_bay',
        'a bay ask on the merge-proof drawing',
        (r) => ({ waterBodyId: cove(r), coord: offset(proofCenter(r), 0, -150) }),
        { name: 'Proof Narrows' },
        ['mp-cove'],
      ),
      // A merge re-targets the ask to the survivor: found by its asker and name, wherever it is.
      find: (ctx, r) =>
        findOn(ctx, r, 'cove', (id) =>
          requestBy(
            ctx,
            r.person('elin'),
            (q) => q.kind === 'name_bay' && q.waterBodyId === id && q.name === 'Proof Narrows',
          ),
        ),
    },
    {
      key: 'mp-place-name',
      label: 'an open place name on the merge-proof drawing',
      as: 'bare',
      fn: 'corpusPlaceNames:importBatch',
      after: ['mp-cove'],
      args: (r) => ({
        names: [
          {
            name: 'Proof Point',
            aliases: [],
            messages: 2,
            skatedMessages: 1,
            states: ['VT'],
            waterBodyId: cove(r),
          },
        ],
        dryRun: false,
      }),
      find: (ctx, r) =>
        findOn(
          ctx,
          r,
          'cove',
          async (id) =>
            (
              await ctx.db
                .query('corpusPlaceNames')
                .withIndex('by_water_body_status', (q) => q.eq('waterBodyId', id))
                .take(20)
            ).find((n) => n.name === 'Proof Point')?._id ?? null,
        ),
    },
    favorite('mp-fav-cove', 'elin', 'cove'),
    favorite('mp-fav-both-cove', 'cleo', 'cove'),
    favorite('mp-fav-both-pond', 'cleo', 'survivor'),
    accessReport('mp-flag-cove', 'ada', 'cove'),
    accessReport('mp-flag-pond', 'gus', 'survivor'),
    // Gus reported the survivor first: on a merge this one stays behind.
    accessReport('mp-flag-cove-gus', 'gus', 'cove', ['mp-flag-pond']),
    bay('mp-bay-cove', 'cove', 'Proof Inlet', 0, -150),
    bay('mp-bay-clash-cove', 'cove', 'Proof Bay', 0, 150),
    bay('mp-bay-clash-pond', 'survivor', 'Proof Bay', 0, 150),
    landmark('mp-landmark-cove', 'cove'),
    landmark('mp-landmark-pond', 'survivor'),
    alias('mp-alias-cove', 'cove', 'Proof Cove Test-Alias'),
    alias('mp-alias-pond', 'survivor', 'Proof Pond Test-Alias'),
    pin('mp-pin-cove', 'cove'),
    pin('mp-pin-pond', 'survivor'),
    link('mp-link-cove', 'cove'),
    link('mp-link-pond', 'survivor'),
  ];
}

// ── The bodies ───────────────────────────────────────────────────────────────────────────────────

/**
 * The body a seed row already names for each role — the role's pin. A role is resolved from live
 * state only until the seed files its first row on it; after that it is that row's body, wherever
 * that body's standing has since moved (an activate ask approved wakes the dormant body, and the next
 * dormant one in the index must never be asked about).
 */
async function pinnedBodies(
  ctx: QueryCtx,
): Promise<Partial<Record<SeedBodyRole, Id<'waterBodies'>>>> {
  const out: Partial<Record<SeedBodyRole, Id<'waterBodies'>>> = {};
  const reportBody = async (stepKey: string) => {
    const id = await reportByKey(ctx, stepKey);
    return id ? (await ctx.db.get(id))?.waterBodyId : undefined;
  };
  const pins: [SeedBodyRole, () => Promise<Id<'waterBodies'> | undefined>][] = [
    ['mascoma', () => reportBody('r-black-ice')],
    ['caspian', () => reportBody('r-caspian')],
    ['morey', () => reportBody('r-morey')],
    ['newfound', () => reportBody('r-newfound')],
    [
      'tomhannock',
      async () => {
        const id = await hazardByKey(ctx, 'h-crack');
        return id ? (await ctx.db.get(id))?.waterBodyId : undefined;
      },
    ],
  ];
  for (const [role, read] of pins) {
    const id = await read();
    if (id !== undefined) out[role] = id;
  }
  return out;
}

/** How many library rows a role's light lookup reads, at most. */
const LIBRARY_PROBE = 8;

/**
 * A body for a role, found through the Bodies library's rows — names, lanes, areas; never an
 * outline — and only then the one body document it chose. `keep` is the check on that document.
 */
async function libraryPick(
  ctx: QueryCtx,
  rows: Promise<Doc<'bodyLibraryRows'>[]>,
  keep: (b: Doc<'waterBodies'>) => boolean,
): Promise<Doc<'waterBodies'> | null> {
  const ordered = [...(await rows)].sort((a, b) => (b.areaSqM ?? 0) - (a.areaSqM ?? 0));
  for (const row of ordered) {
    const body = await ctx.db.get(row.waterBodyId);
    if (body && isListed(body) && body.source !== 'user' && keep(body)) return body;
  }
  return null;
}

/**
 * The bodies the plan files against: each role's pin when the seed has filed on it, else a light
 * lookup — a named body by its library row's name key, a dormant, closed or removed one by its lane
 * — reading at most {@link LIBRARY_PROBE} library rows a role and one body document each.
 */
async function seedBodies(
  ctx: QueryCtx,
): Promise<Partial<Record<SeedBodyRole, Doc<'waterBodies'>>>> {
  const out: Partial<Record<SeedBodyRole, Doc<'waterBodies'>>> = {};
  const pins = await pinnedBodies(ctx);
  for (const [role, id] of Object.entries(pins) as [SeedBodyRole, Id<'waterBodies'>][]) {
    const body = await ctx.db.get(id);
    if (body) out[role] = body;
  }
  for (const [role, name] of Object.entries(SEED_NAMED_BODIES) as [NamedRole, string][]) {
    if (out[role]) continue;
    const body = await libraryPick(
      ctx,
      ctx.db
        .query('bodyLibraryRows')
        .withIndex('by_scope_name', (q) =>
          q.eq('scope', SCOPE_ALL).eq('nameKey', nameSortKey(name)),
        )
        .take(LIBRARY_PROBE),
      (b) => standingOf(b).standing === 'active',
    );
    if (body) out[role] = body;
  }
  return out;
}

// ── The people ───────────────────────────────────────────────────────────────────────────────────

const PREFS_OFF = Object.fromEntries(NOTIFICATION_PREF_KEYS.map((k) => [k, false])) as Record<
  (typeof NOTIFICATION_PREF_KEYS)[number],
  boolean
>;

async function seedProfiles(ctx: QueryCtx) {
  const out: Partial<Record<SeedPersonKey, Doc<'profiles'>>> = {};
  for (const p of SEED_CAST) {
    const row = await ctx.db
      .query('profiles')
      .withIndex('by_clerk_user_id', (q) => q.eq('clerkUserId', p.clerkUserId))
      .first();
    if (row) out[p.key] = row;
  }
  return out;
}

/**
 * Insert the fake people who aren't there yet, each with their People row. Dry unless `apply`: it
 * says who it would create. Refuses a cast member whose last name breaks the "Test-" rule.
 */
export const ensurePeople = internalMutation({
  args: {
    apply: v.optional(v.boolean()),
    /**
     * The operator's Clerk user id (`CONVEX_RUN_AS`): answered with their role and status, so the
     * script refuses before it files anything when the moderator acts it seeds would be refused —
     * approving a takedown ask removes a body, which takes an admin.
     */
    operator: v.optional(v.string()),
  },
  handler: async (ctx, { apply, operator }) => {
    assertSeedDeployment();
    const operatorRow =
      operator === undefined
        ? undefined
        : await ctx.db
            .query('profiles')
            .withIndex('by_clerk_user_id', (q) => q.eq('clerkUserId', operator))
            .first();
    const existing = await seedProfiles(ctx);
    const created: string[] = [];
    const now = Date.now();
    for (const [i, p] of SEED_CAST.entries()) {
      if (!hasTestSurname(p.displayName)) {
        throw new ConvexError(
          `${p.displayName}: every fake person's last name starts with "Test-"`,
        );
      }
      if (existing[p.key]) continue;
      created.push(p.displayName);
      if (apply !== true) continue;
      const id = await ctx.db.insert('profiles', {
        clerkUserId: p.clerkUserId,
        displayName: p.displayName,
        username: p.username,
        driveTimePrefMinutes: 60,
        profileVisibility: 'public',
        // Never contacted (D287): every toggle and both channels off, no email, no push token.
        notificationPrefs: PREFS_OFF,
        channelPrefs: { push: false, email: false },
        dateOfBirth: Date.UTC(1980 + i, i % 12, 1 + i),
        riskAckVersion: RISK_ACK_VERSION,
        riskAckAt: now,
        reputationPoints: p.reputationPoints,
        reportCount: 0,
        commentCount: 0,
        role: 'member',
        status: 'active',
        createdAt: now - (SEED_CAST.length - i) * 30 * DAY,
      });
      await refreshPersonRow(ctx, id);
    }
    return {
      created,
      existing: SEED_CAST.filter((p) => existing[p.key]).map((p) => p.displayName),
      applied: apply === true,
      ...(operator === undefined
        ? {}
        : {
            operator: operatorRow ? { role: operatorRow.role, status: operatorRow.status } : null,
          }),
    };
  },
});

/**
 * A fake person's recorded skate, as a phone would have uploaded it (a GPX file): the input
 * `waterBodies.create` derives a drawn body from. Keyed by the step (`providerActivityId`), so a
 * second call returns the first row. Its prompt is settled, so no "you skated" prompt sweeps it.
 */
export const ensureActivity = internalMutation({
  args: {
    person: literals(SEED_PERSON_KEYS),
    key: v.string(),
    path: v.object({ type: v.literal('LineString'), coordinates: v.array(v.array(v.number())) }),
    startTime: v.number(),
  },
  handler: async (ctx, { person, key, path, startTime }) => {
    assertSeedDeployment();
    const found = await activityByKey(ctx, key);
    if (found) return found._id;
    const profile = await ctx.db
      .query('profiles')
      .withIndex('by_clerk_user_id', (q) => q.eq('clerkUserId', seedPerson(person).clerkUserId))
      .first();
    if (!profile) throw new ConvexError(`No profile for ${person} yet — run ensurePeople first.`);
    return ctx.db.insert('gpsActivities', {
      userId: profile._id,
      provider: 'gpx',
      providerActivityId: seedKey(key),
      sportType: 'IceSkate',
      startTime,
      endTime: startTime + HOUR,
      elapsedSeconds: 3_600,
      path,
      promptState: 'dismissed',
      detectedAt: startTime + HOUR,
    });
  },
});

// ── The state ────────────────────────────────────────────────────────────────────────────────────

/** A step's place in the plan, as `state` answers it. */
export interface SeedState {
  people: { key: SeedPersonKey; displayName: string; profileId: Id<'profiles'> | null }[];
  bodies: { role: SeedBodyRole; name: string | null }[];
  done: string[];
  ready: SeedCall[];
  waiting: { key: string; label: string; on: string }[];
  unavailable: { key: string; label: string; missing: string }[];
}

/**
 * **The plan against the deployment.** Read-only. Each step is done (its seed key finds the row it
 * files), ready (with its arguments resolved), waiting on an earlier step, or unavailable (an input
 * this deployment doesn't hold — a dormant body, say).
 */
export const state = internalQuery({
  args: {},
  handler: async (ctx): Promise<SeedState> => {
    assertSeedDeployment();
    const now = Date.now();
    const people = await seedProfiles(ctx);
    const bodies = await seedBodies(ctx);
    const outs = new Map<string, string>();
    let launch: Id<'putIns'> | null | undefined;
    const refs: Refs = {
      now,
      person: (key) => {
        const p = people[key];
        if (!p) throw new Missing(`the fake person ${key} (run ensurePeople)`, true);
        return p._id;
      },
      body: (role) => {
        const b = bodies[role];
        if (!b) throw new Missing(`a ${role} body on this deployment`, false);
        return b;
      },
      out: (stepKey) => {
        const id = outs.get(stepKey);
        if (id === undefined) throw new Missing(stepKey, true);
        return id;
      },
      launch: () => {
        if (!launch) throw new Missing('a live launch on Caspian Lake', false);
        return launch;
      },
      survivor: async (drawnStepKey) => {
        const drawn = await ctx.db.get(refs.out(drawnStepKey) as Id<'waterBodies'>);
        const live = drawn ? await liveSurvivorOf(drawn, (id) => ctx.db.get(id)) : null;
        if (!live) throw new Missing(`${drawnStepKey}'s overlap with a known body`, false);
        return live._id;
      },
      townAt: async (point) => {
        const town = await townContaining(ctx, point);
        if (!town) throw new Missing('a loaded town under the merge-proof pair', false);
        return town.externalId;
      },
      item: async (flagStepKey) => {
        const flagId = refs.out(flagStepKey);
        const member = await ctx.db
          .query('inboxItemMembers')
          .withIndex('by_source', (q) => q.eq('sourceTable', 'contentFlags').eq('sourceId', flagId))
          .first();
        if (!member) throw new Missing(`${flagStepKey}'s Inbox item`, true);
        return member.itemId;
      },
    };
    if (bodies.caspian) {
      const caspian = bodies.caspian._id;
      const rows = await ctx.db
        .query('putIns')
        .withIndex('by_water_body', (q) => q.eq('waterBodyId', caspian))
        .take(20);
      launch = rows.find((p) => p.status === 'visible')?._id ?? null;
    }

    const out: SeedState = {
      people: SEED_CAST.map((p) => ({
        key: p.key,
        displayName: p.displayName,
        profileId: people[p.key]?._id ?? null,
      })),
      bodies: (
        Object.keys({
          ...SEED_NAMED_BODIES,
        }) as SeedBodyRole[]
      ).map((role) => ({ role, name: bodies[role]?.name ?? null })),
      done: [],
      ready: [],
      waiting: [],
      unavailable: [],
    };
    const steps = seedSteps();
    const settled = new Set<string>();
    // Pass 1, to a fixpoint: every step whose seed key finds its row is done — a finder may read what
    // another step filed, wherever that step sits in the list.
    for (let moved = true; moved; ) {
      moved = false;
      for (const step of steps) {
        if (settled.has(step.key) || (step.after ?? []).some((k) => !settled.has(k))) continue;
        try {
          const found = await step.find(ctx, refs);
          if (found === null) continue;
          outs.set(step.key, found);
          settled.add(step.key);
          moved = true;
        } catch (err) {
          if (!(err instanceof Missing)) throw err;
        }
      }
    }
    // Pass 2: the rest are ready, waiting on a step not yet filed, or missing an input here.
    const waiting: SeedState['waiting'] = [];
    const unavailable = new Set<string>();
    for (const step of steps) {
      if (settled.has(step.key)) {
        out.done.push(step.key);
        continue;
      }
      try {
        const pending = (step.after ?? []).find((k) => !settled.has(k));
        if (pending !== undefined) throw new Missing(pending, true);
        const args = await step.args(refs);
        const call: SeedCall = { key: step.key, label: step.label, as: step.as, fn: step.fn, args };
        if (step.as !== 'operator' && step.as !== 'bare') {
          call.clerkUserId = seedPerson(step.as).clerkUserId;
        }
        out.ready.push(call);
      } catch (err) {
        if (!(err instanceof Missing)) throw err;
        if (err.waiting) waiting.push({ key: step.key, label: step.label, on: err.what });
        else {
          unavailable.add(step.key);
          out.unavailable.push({ key: step.key, label: step.label, missing: err.what });
        }
      }
    }
    // Waiting on a step that can't be filed here is unavailable too, never waiting for ever.
    for (let moved = true; moved; ) {
      moved = false;
      for (const w of waiting) {
        if (unavailable.has(w.key) || !unavailable.has(w.on)) continue;
        unavailable.add(w.key);
        out.unavailable.push({
          key: w.key,
          label: w.label,
          missing: `${w.on}, which can't be filed here`,
        });
        moved = true;
      }
    }
    out.waiting = waiting.filter((w) => !unavailable.has(w.key));
    return out;
  },
});

// ── The clear ────────────────────────────────────────────────────────────────────────────────────

/**
 * One source row's worst case for the Inbox writer: `leaveMember` re-derives the item from its
 * members (at most `MAX_MEMBERS` of each status) and reads the source's facts. A fresh budget always
 * covers one such row and its own side rows, so every call removes something or finishes.
 */
export const INBOX_LEAVE_COST = (2 * MAX_MEMBERS + 24) * ROW_MAX.small + 2 * DOC_MAX;
/**
 * A drawing's leave from its item: the item (`drawn:<id>`, keyed by the drawing alone) holds that one
 * member, so the writer re-derives it from a handful of rows and reads the drawing's facts.
 */
const DRAWN_LEAVE_COST = 24 * ROW_MAX.small + 2 * DOC_MAX;
/** What the library writer's isolated refresh reads in the caller's own transaction (its queue row). */
const LIBRARY_REFRESH_RESERVE = 16 * ROW_MAX.small;
/**
 * What geometry's gone path reads: the facts row (its neighbor list, a whole document at worst), the
 * links it held and the holders of its outline (each at most a few dozen small rows), and failures.
 */
const GEO_GONE_RESERVE = DOC_MAX + 96 * ROW_MAX.small;
/** Rows one call deletes at most, whatever the reads allow — the write side's own bound. */
export const CLEAR_WRITES_PER_CALL = 1_500;

class OutOfRoom extends Error {}

/** The clear's tally, by table, and its budget. */
class Sweep {
  readonly removed: Record<string, number> = {};
  private writes = 0;
  constructor(
    readonly ctx: MutationCtx,
    readonly budget: ReadBudget,
  ) {}

  /** Reserve `bytes` for work a writer does on its own reads, or stop the call here. */
  need(bytes: number): void {
    if (!this.budget.affords(bytes) || this.writes >= CLEAR_WRITES_PER_CALL) throw new OutOfRoom();
    this.budget.spend(bytes);
  }

  /** The first row of a read, charged as it really weighs; `null` when there is none. */
  async first<D>(kind: RowKind, read: () => Promise<D | null>): Promise<D | null> {
    if (!this.budget.affordsRead(kind) || this.writes >= CLEAR_WRITES_PER_CALL)
      throw new OutOfRoom();
    const row = await this.budget.measured(kind, read);
    if (row === undefined) throw new OutOfRoom();
    return row;
  }

  async delete(table: TableNames, id: Id<TableNames>): Promise<void> {
    await this.ctx.db.delete(id);
    this.writes++;
    this.removed[table] = (this.removed[table] ?? 0) + 1;
  }

  /** Delete every row `read` finds, one at a time (each read sees the last delete). */
  async drain<T extends TableNames>(
    table: T,
    kind: RowKind,
    read: () => Promise<Doc<T> | null>,
    clean?: (row: Doc<T>) => Promise<void>,
  ): Promise<void> {
    for (;;) {
      const row = await this.first(kind, read);
      if (!row) return;
      if (clean) await clean(row);
      await this.delete(table, row._id);
    }
  }
}

/** An audit row and what hangs off it: its snapshots, body links and the verdicts it wrote. */
async function dropAudit(s: Sweep, action: Doc<'moderationActions'>): Promise<void> {
  const db = s.ctx.db;
  await s.drain('auditSnapshots', 'moderationAction', () =>
    db
      .query('auditSnapshots')
      .withIndex('by_action', (q) => q.eq('actionId', action._id))
      .first(),
  );
  await s.drain('auditBodyLinks', 'small', () =>
    db
      .query('auditBodyLinks')
      .withIndex('by_action', (q) => q.eq('actionId', action._id))
      .first(),
  );
  await s.drain('contentVerdicts', 'verdict', () =>
    db
      .query('contentVerdicts')
      .withIndex('by_action', (q) => q.eq('actionId', action._id))
      .first(),
  );
}

/** Every audit row about a target, and what hangs off each. */
async function dropAuditsOf(
  s: Sweep,
  targetType: Doc<'moderationActions'>['targetType'],
  targetId: string,
): Promise<void> {
  const db = s.ctx.db;
  await s.drain(
    'moderationActions',
    'moderationAction',
    () =>
      db
        .query('moderationActions')
        .withIndex('by_target', (q) => q.eq('targetType', targetType).eq('targetId', targetId))
        .first(),
    (row) => dropAudit(s, row),
  );
  await s.drain('contentVerdicts', 'verdict', () =>
    db
      .query('contentVerdicts')
      .withIndex('by_target_at', (q) =>
        q
          .eq('targetType', targetType as Doc<'contentVerdicts'>['targetType'])
          .eq('targetId', targetId),
      )
      .first(),
  );
}

/**
 * The points a seeded row earned *someone else* (a corroborated report's author, say): the ledger row
 * goes and the running total it moved moves back, as `awardPointEvent` moved it.
 */
async function dropPointsFor(s: Sweep, refId: string): Promise<void> {
  await s.drain(
    'pointEvents',
    'small',
    () =>
      s.ctx.db
        .query('pointEvents')
        .withIndex('by_ref', (q) => q.eq('refId', refId))
        .first(),
    async (e) => {
      const owner = await s.ctx.db.get(e.userId);
      if (!owner) return;
      if (e.reason === 'bounty_fulfilled') await bumpBountyPoints(s.ctx, e.userId, -e.delta);
      else await bumpReputation(s.ctx, e.userId, -e.delta);
    },
  );
}

/**
 * A flag, a request, a drawn body or a ticket: out of its Inbox item first, through the writer. The
 * writer's worst case is reserved only when there is a member to take out, so a row whose member
 * already left (a call that stopped after it) never pays for it twice.
 */
async function leave(s: Sweep, source: InboxSource): Promise<void> {
  const member = await s.first('small', () =>
    s.ctx.db
      .query('inboxItemMembers')
      .withIndex('by_source', (q) => q.eq('sourceTable', source.table).eq('sourceId', source.id))
      .first(),
  );
  if (!member) return;
  s.need(INBOX_LEAVE_COST);
  await leaveMember(s.ctx, source);
  s.removed.inboxItemMembers = (s.removed.inboxItemMembers ?? 0) + 1;
}

/**
 * A body whose figures a removed row counted — its library row's asks and reports, its card — asked
 * to be re-derived through its own writers: the library's queue and the card's refresh row, which
 * dev's crons drain within the minute and the hour. Taken from the swept row itself, so a body is
 * re-derived wherever its standing has moved since the seed filed on it.
 */
async function touchBody(s: Sweep, waterBodyId: Id<'waterBodies'> | undefined): Promise<void> {
  if (waterBodyId === undefined) return;
  s.need(16 * ROW_MAX.small);
  const now = Date.now();
  await queueLibraryRefresh(s.ctx, [waterBodyId], now);
  await queueSummaryRefresh(s.ctx, waterBodyId, now);
}

async function dropFlag(s: Sweep, f: Doc<'contentFlags'>): Promise<void> {
  await leave(s, flagSource(f._id));
  await dropAuditsOf(s, 'contentFlag', f._id);
  if (f.targetType === 'waterbody') await touchBody(s, f.targetId as Id<'waterBodies'>);
}

async function dropRequest(s: Sweep, r: Doc<'waterBodyRequests'>): Promise<void> {
  await leave(s, requestSource(r._id));
  await dropAuditsOf(s, 'waterBodyRequest', r._id);
  await touchBody(s, r.waterBodyId);
}

/**
 * A comment on seeded content, removed as its author's own delete would remove it: a real person's
 * comment on a fake report goes with the report (by design), and the visible-comment count it added
 * to their profile comes back off, as `comments.remove` takes it off.
 */
async function dropComment(s: Sweep, c: Doc<'comments'>): Promise<void> {
  await dropContentSides(s, 'comment', c._id);
  if (c.moderationStatus !== 'removed' && c.authorDeletedAt === undefined) {
    await bumpContributionCount(
      s.ctx,
      c.authorId,
      'commentCount',
      visibleDelta(c.moderationStatus, 'removed'),
    );
  }
}

/** What hangs off a piece of content: its audit rows, verdicts, flags, thumbs and others' points. */
async function dropContentSides(
  s: Sweep,
  targetType: 'report' | 'post' | 'comment' | 'hazard' | 'accessAlert',
  id: string,
): Promise<void> {
  const db = s.ctx.db;
  await dropAuditsOf(s, targetType, id);
  // The person's Deleted-list row, through its one writer (an author-deleted report has one).
  s.need(WITHDRAWAL_DROP_COST);
  await dropWithdrawal(s.ctx, targetType, id as Id<'reports'>, s.budget);

  await s.drain(
    'contentFlags',
    'contentFlag',
    () =>
      db
        .query('contentFlags')
        .withIndex('by_target', (q) => q.eq('targetType', targetType).eq('targetId', id))
        .first(),
    (f) => dropFlag(s, f),
  );
  if (targetType === 'report' || targetType === 'hazard') {
    await s.drain('reportRatings', 'small', () =>
      db
        .query('reportRatings')
        .withIndex('by_target', (q) => q.eq('targetType', targetType).eq('targetId', id))
        .first(),
    );
  }
  await dropPointsFor(s, id);
}

/**
 * What the operator and the fake people put on a body the seed drew (the merge-proof pair, B01-5d):
 * its bays (their cells and rows), its landmarks (their rows), its launches, bounties, favorites and
 * place names, and its short list of names — every one on the seed's own body, so it goes with it.
 */
async function dropBodyChildren(s: Sweep, body: Doc<'waterBodies'>): Promise<void> {
  const db = s.ctx.db;
  await s.drain(
    'waterBodySubAreas',
    'waterBody',
    () =>
      db
        .query('waterBodySubAreas')
        .withIndex('by_parent', (q) => q.eq('waterBodyId', body._id))
        .first(),
    async (bay) => {
      await s.drain('waterBodySubAreaCells', 'small', () =>
        db
          .query('waterBodySubAreaCells')
          .withIndex('by_sub_area', (q) => q.eq('subAreaId', bay._id))
          .first(),
      );
      await dropAuditsOf(s, 'waterBodySubArea', bay._id);
    },
  );
  await s.drain(
    'bodyLandmarks',
    'landmark',
    () =>
      db
        .query('bodyLandmarks')
        .withIndex('by_water_body', (q) => q.eq('waterBodyId', body._id))
        .first(),
    (row) => dropAuditsOf(s, 'bodyLandmark', row._id),
  );
  await s.drain(
    'putIns',
    'putIn',
    () =>
      db
        .query('putIns')
        .withIndex('by_water_body', (q) => q.eq('waterBodyId', body._id))
        .first(),
    (row) => dropAuditsOf(s, 'putIn', row._id),
  );
  await s.drain('bounties', 'report', () =>
    db
      .query('bounties')
      .withIndex('by_water_body_status', (q) => q.eq('waterBodyId', body._id))
      .first(),
  );
  // The bounty's gate record (the attempt, allowed): about the seed's body and its fake asker.
  await s.drain('bountyGateEvents', 'gateEvent', () =>
    db
      .query('bountyGateEvents')
      .withIndex('by_water_body', (q) => q.eq('waterBodyId', body._id))
      .first(),
  );
  // A pattern the recurrence pass clustered on the body (a merge re-clusters its survivor's).
  await s.drain('hazardRecurrence', 'hazardRecurrence', () =>
    db
      .query('hazardRecurrence')
      .withIndex('by_water_body', (q) => q.eq('waterBodyId', body._id))
      .first(),
  );
  await s.drain('waterBodyFavorites', 'small', () =>
    db
      .query('waterBodyFavorites')
      .withIndex('by_water_body', (q) => q.eq('waterBodyId', body._id))
      .first(),
  );
  await s.drain(
    'corpusPlaceNames',
    'landmark',
    () =>
      db
        .query('corpusPlaceNames')
        .withIndex('by_water_body_status', (q) => q.eq('waterBodyId', body._id))
        .first(),
    (row) => dropAuditsOf(s, 'corpusPlaceName', row._id),
  );
  // Its short list of names, through the list's own module (the one that may write it).
  s.need(ROW_MAX.bodyNames);
  if (await dropBodyNames(s.ctx, body._id)) {
    s.removed.bodyNames = (s.removed.bodyNames ?? 0) + 1;
  }
}

/** A body a fake person drew, and everything its write made: cells, facts, library rows, item. */
async function dropDrawnBody(s: Sweep, body: Doc<'waterBodies'>): Promise<void> {
  const db = s.ctx.db;
  await dropBodyChildren(s, body);
  await dropAuditsOf(s, 'waterbody', body._id);
  await s.drain('auditBodyLinks', 'small', () =>
    db
      .query('auditBodyLinks')
      .withIndex('by_body_time', (q) => q.eq('waterBodyId', body._id))
      .first(),
  );
  await s.drain('waterBodyCells', 'small', () =>
    db
      .query('waterBodyCells')
      .withIndex('by_body', (q) => q.eq('waterBodyId', body._id))
      .first(),
  );
  await s.drain('bodySummaryRefreshes', 'small', () =>
    db
      .query('bodySummaryRefreshes')
      .withIndex('by_water_body', (q) => q.eq('waterBodyId', body._id))
      .first(),
  );
  // Reserved before the body goes, so a call that can't afford the library's writer stops with the
  // body still there to find. The writer runs isolated (its own limits), and on a failure queues the
  // body for the library's drain, which removes its rows and moves the counts.
  // Out of its Inbox item last, in one reserved step with the body's delete: the member is how the
  // clear finds a drawing a merge took the skate from (B01-5d), so a call that stops earlier leaves it
  // there to find the body by again. A drawing's item is keyed by the drawing alone, so it holds this
  // one member: its leave is reserved at that size, not at the generic worst of `MAX_MEMBERS`.
  s.need(LIBRARY_REFRESH_RESERVE + GEO_GONE_RESERVE + DRAWN_LEAVE_COST);
  const member = await db
    .query('inboxItemMembers')
    .withIndex('by_source', (q) => q.eq('sourceTable', 'waterBodies').eq('sourceId', body._id))
    .first();
  if (member) {
    await leaveMember(s.ctx, bodySource(body._id));
    s.removed.inboxItemMembers = (s.removed.inboxItemMembers ?? 0) + 1;
  }
  await s.delete('waterBodies', body._id);
  await refreshBodyLibrary(s.ctx, body._id);
  // Geometry's own "gone" path: its facts and links go, every neighbor whose facts list it is marked
  // to recompute, and every body holding a copy of its outline drops it (`bodyGeo.store`).
  await s.ctx.runMutation(internal.bodyGeo.store, {
    waterBodyId: body._id,
    stamp: '',
    staleAt: null,
    neighbors: [],
    neighborsCapped: false,
    towns: [],
    counties: [],
    states: [],
    areasAt: 0,
  });
}

/**
 * The phases, in order, each over every fake person. Later phases find what earlier ones would
 * otherwise orphan; the people go last, once nothing names them.
 */
async function sweepPeople(s: Sweep, people: Doc<'profiles'>[]): Promise<void> {
  const db = s.ctx.db;
  for (const p of people) {
    await s.drain(
      'contentFlags',
      'contentFlag',
      () =>
        db
          .query('contentFlags')
          .withIndex('by_flagger', (q) => q.eq('flaggerId', p._id))
          .first(),
      (f) => dropFlag(s, f),
    );
    await s.drain(
      'contentFlags',
      'contentFlag',
      () =>
        db
          .query('contentFlags')
          .withIndex('by_subject_status', (q) => q.eq('subjectUserId', p._id))
          .first(),
      (f) => dropFlag(s, f),
    );
    await s.drain(
      'waterBodyRequests',
      'waterBodyRequest',
      () =>
        db
          .query('waterBodyRequests')
          .withIndex('by_requester_created', (q) => q.eq('requesterId', p._id))
          .first(),
      (r) => dropRequest(s, r),
    );
    await s.drain(
      'supportTickets',
      'supportTicket',
      () =>
        db
          .query('supportTickets')
          .withIndex('by_clerk_user_created', (q) => q.eq('clerkUserId', p.clerkUserId))
          .first(),
      (t) => leave(s, ticketSource(t._id)),
    );
    await s.drain('reportRatings', 'small', () =>
      db
        .query('reportRatings')
        .withIndex('by_rater', (q) => q.eq('raterId', p._id))
        .first(),
    );
    await s.drain('hazardConfirmations', 'small', () =>
      db
        .query('hazardConfirmations')
        .withIndex('by_user', (q) => q.eq('userId', p._id))
        .first(),
    );
    await s.drain(
      'comments',
      'comment',
      () =>
        db
          .query('comments')
          .withIndex('by_author', (q) => q.eq('authorId', p._id))
          .first(),
      (c) => dropComment(s, c),
    );
    await s.drain(
      'accessAlerts',
      'accessAlert',
      () =>
        db
          .query('accessAlerts')
          .withIndex('by_author', (q) => q.eq('createdByUserId', p._id))
          .first(),
      async (a) => {
        await dropContentSides(s, 'accessAlert', a._id);
        await touchBody(s, a.waterBodyId);
      },
    );
    await s.drain(
      'hazards',
      'hazard',
      () =>
        db
          .query('hazards')
          .withIndex('by_author', (q) => q.eq('createdByUserId', p._id))
          .first(),
      async (h) => {
        await dropContentSides(s, 'hazard', h._id);
        await touchBody(s, h.waterBodyId);
        await s.drain('hazardConfirmations', 'small', () =>
          db
            .query('hazardConfirmations')
            .withIndex('by_hazard', (q) => q.eq('hazardId', h._id))
            .first(),
        );
      },
    );
    await s.drain(
      'reports',
      'report',
      () =>
        db
          .query('reports')
          .withIndex('by_author', (q) => q.eq('authorId', p._id))
          .first(),
      async (r) => {
        await dropContentSides(s, 'report', r._id);
        await touchBody(s, r.waterBodyId);
        await s.drain(
          'comments',
          'comment',
          () =>
            db
              .query('comments')
              .withIndex('by_report', (q) => q.eq('reportId', r._id))
              .first(),
          (c) => dropComment(s, c),
        );
        await s.drain(
          'waterBodyRequests',
          'waterBodyRequest',
          () =>
            db
              .query('waterBodyRequests')
              .withIndex('by_report', (q) => q.eq('reportId', r._id))
              .first(),
          (q) => dropRequest(s, q),
        );
        await s.drain('reportSubAreas', 'small', () =>
          db
            .query('reportSubAreas')
            .withIndex('by_report', (q) => q.eq('reportId', r._id))
            .first(),
        );
      },
    );
    await s.drain(
      'posts',
      'post',
      () =>
        db
          .query('posts')
          .withIndex('by_author', (q) => q.eq('authorId', p._id))
          .first(),
      (post) => dropContentSides(s, 'post', post._id),
    );
    await s.drain(
      'gpsActivities',
      'activity',
      () =>
        db
          .query('gpsActivities')
          .withIndex('by_user', (q) => q.eq('userId', p._id))
          .first(),
      async (a) => {
        if (a.waterBodyId === undefined) return;
        const drawn = await s.first('waterBody', () => db.get(a.waterBodyId as Id<'waterBodies'>));
        if (drawn && drawn.createdByUserId === p._id) await dropDrawnBody(s, drawn);
      },
    );
    // Every body the person drew, through the Inbox member its drawing filed — its filer is the
    // drawer, and no decision, merge or unmerge moves it, where a merge moves the skate above to the
    // survivor (B01-5d). Each pass removes the member (`dropDrawnBody` leaves first), so it ends.
    for (;;) {
      const member = await s.first('inboxMember', () =>
        db
          .query('inboxItemMembers')
          .withIndex('by_filer_source_status', (q) =>
            q.eq('filedByUserId', p._id).eq('sourceTable', 'waterBodies'),
          )
          .first(),
      );
      if (!member) break;
      const id = member.sourceId as Id<'waterBodies'>;
      const drawn = await s.first('waterBody', () => db.get(id));
      if (drawn && drawn.createdByUserId === p._id) await dropDrawnBody(s, drawn);
      else await leave(s, bodySource(id));
    }
    await s.drain('pointEvents', 'small', () =>
      db
        .query('pointEvents')
        .withIndex('by_user', (q) => q.eq('userId', p._id))
        .first(),
    );
    for (const index of ['by_target', 'by_actor'] as const) {
      await s.drain(
        'moderationActions',
        'moderationAction',
        () =>
          index === 'by_target'
            ? db
                .query('moderationActions')
                .withIndex('by_target', (q) => q.eq('targetType', 'user').eq('targetId', p._id))
                .first()
            : db
                .query('moderationActions')
                .withIndex('by_actor', (q) => q.eq('actorId', p._id))
                .first(),
        (row) => dropAudit(s, row),
      );
    }
    await s.drain('contentVerdicts', 'verdict', () =>
      db
        .query('contentVerdicts')
        .withIndex('by_subject_ended', (q) => q.eq('subjectUserId', p._id))
        .first(),
    );
    await s.drain('notifications', 'small', () =>
      db
        .query('notifications')
        .withIndex('by_user', (q) => q.eq('userId', p._id))
        .first(),
    );
    await s.drain('notificationQueue', 'small', () =>
      db
        .query('notificationQueue')
        .withIndex('by_user', (q) => q.eq('userId', p._id))
        .first(),
    );
  }
}

/**
 * **Remove the seed** — every row a fake person wrote or that is about one, the operator's acts on
 * them, then the people — through the writers that keep the stored counts exact: each flag, request,
 * ticket and drawn body leaves its Inbox item through `leaveMember`; a drawn body's library rows go
 * through `refreshBodyLibrary` and its geometry through `bodyGeo`'s own gone path; a real person's
 * comment on seeded content goes with it (by design) and its count comes off their profile; points
 * the seed earned anyone else move back; each person's People row through `refreshPersonRow`. Every
 * real body a removed row counted on is queued for its library and card writers, taken from the
 * removed row — nothing a real body stores is written here directly, and nothing of the seed's ever
 * ruled a real body (the dispute's ruling is on a body the seed drew).
 *
 * **Bounded on bytes, and never wedged.** Every read is charged as it really weighs against one
 * `ReadBudget`, and each writer's worst case is reserved before the step it guards; a call stops
 * where the budget (or {@link CLEAR_WRITES_PER_CALL}) runs out and answers `done: false` — the script
 * calls again. Each read is the head of an index the call deletes from, so the next call walks on with
 * no cursor, and a fresh budget always holds at least one row's whole work: every call removes
 * something or finishes. `budgetBytes` is the test seam for a small budget.
 *
 * Not removed, because no row names who caused it: the anonymous counters a write ticks
 * (`textLengthEvents`, `externalApiCalls`, `metricSnapshots`) — counts only, never a person or a word.
 */
export const clear = internalMutation({
  args: { budgetBytes: v.optional(v.number()) },
  handler: async (ctx, { budgetBytes }) => {
    assertSeedDeployment();
    const s = new Sweep(ctx, new ReadBudget(budgetBytes ?? TX_BUDGET));
    const people = Object.values(await seedProfiles(ctx)).filter((p): p is Doc<'profiles'> => !!p);
    try {
      await sweepPeople(s, people);
      for (const p of people) {
        await s.delete('profiles', p._id);
        await refreshPersonRow(ctx, p._id);
        s.removed.peopleRows = (s.removed.peopleRows ?? 0) + 1;
      }
      return { done: true, removed: s.removed };
    } catch (err) {
      if (err instanceof OutOfRoom) return { done: false, removed: s.removed };
      throw err;
    }
  },
});

/** What `clear` would remove, by fake person, counted from bounded reads — the dry run. */
export const clearPlan = internalQuery({
  args: {},
  handler: async (ctx) => {
    assertSeedDeployment();
    const people = Object.values(await seedProfiles(ctx)).filter((p): p is Doc<'profiles'> => !!p);
    const cap = 500;
    const db = ctx.db;
    const out: Record<string, number> = { profiles: people.length };
    const add = (table: string, n: number) => {
      out[table] = (out[table] ?? 0) + n;
    };
    for (const p of people) {
      add(
        'contentFlags',
        (
          await db
            .query('contentFlags')
            .withIndex('by_flagger', (q) => q.eq('flaggerId', p._id))
            .take(cap)
        ).length,
      );
      add(
        'waterBodyRequests',
        (
          await db
            .query('waterBodyRequests')
            .withIndex('by_requester_created', (q) => q.eq('requesterId', p._id))
            .take(cap)
        ).length,
      );
      add(
        'supportTickets',
        (
          await db
            .query('supportTickets')
            .withIndex('by_clerk_user_created', (q) => q.eq('clerkUserId', p.clerkUserId))
            .take(cap)
        ).length,
      );
      add(
        'reports',
        (
          await db
            .query('reports')
            .withIndex('by_author', (q) => q.eq('authorId', p._id))
            .take(cap)
        ).length,
      );
      add(
        'comments',
        (
          await db
            .query('comments')
            .withIndex('by_author', (q) => q.eq('authorId', p._id))
            .take(cap)
        ).length,
      );
      add(
        'hazards',
        (
          await db
            .query('hazards')
            .withIndex('by_author', (q) => q.eq('createdByUserId', p._id))
            .take(cap)
        ).length,
      );
      add(
        'accessAlerts',
        (
          await db
            .query('accessAlerts')
            .withIndex('by_author', (q) => q.eq('createdByUserId', p._id))
            .take(cap)
        ).length,
      );
      add(
        'gpsActivities',
        (
          await db
            .query('gpsActivities')
            .withIndex('by_user', (q) => q.eq('userId', p._id))
            .take(cap)
        ).length,
      );
      add(
        'moderationActions',
        (
          await db
            .query('moderationActions')
            .withIndex('by_target', (q) => q.eq('targetType', 'user').eq('targetId', p._id))
            .take(cap)
        ).length,
      );
    }
    return out;
  },
});
