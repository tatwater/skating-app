/**
 * **The Inbox's reads** (B01-5, *The Inbox (B01-5, the design)* in the B01 phase doc): the lanes'
 * counts, a lane's page, a lane's *Decided this week*, one item behind `?item=`, the day so far, and
 * board 2.1's two context reads (*Around it* and *That night, at the body*).
 *
 * Every list reads the stored items (`inboxItems`, written only by `lib/inboxItems.ts`), never a page
 * of the source tables; every count reads `inboxCounts`, moved with the items; every row and item
 * carries `can` — for each verb its handler draws, `null` (allowed) or the sentence the write would
 * refuse with (`lib/inboxRules.ts`, one rule per verb, D217, D268).
 *
 * All gated on `inbox.read`, Support's rows on `inbox.support.read` as well (PII, D37); the two
 * context reads on `content.read`. A read whose answer turns on the time takes the page's clock
 * (`now`), held within a minute of the server's.
 *
 * **These types are a published contract** (the web builders take them as landed): a change to any
 * shape here is called out as a contract change.
 */

import {
  AROUND_IT_DAYS,
  AROUND_IT_DEFAULT_DAYS,
  type AroundItPhrase,
  aroundItPhrases,
  type Count,
  callerNow,
  type DormancyReason,
  type HazardVerdict,
  INBOX_LANE_ORDER,
  INBOX_LANES,
  INBOX_LIST_LANES,
  INBOX_PAGE_SIZE,
  type InboxDecision,
  type InboxItemKind,
  type InboxLane,
  type InboxMemberStatus,
  isCompleteDay,
  isInboxFacet,
  type LatLng,
  localDayMsAt,
  type ObservedFrom,
  type RequestKind,
  type Restriction,
  type TrustClass,
  type UserRole,
  type WaterBodyClass,
} from '@skating/core';
import type { NamedTableInfo, OrderedQuery } from 'convex/server';
import { ConvexError, getDocumentSize, v } from 'convex/values';
import type { MultiPolygon as GeoMultiPolygon, Polygon as GeoPolygon } from 'geojson';
import type { DataModel, Doc, Id } from './_generated/dataModel';
import { type QueryCtx, query } from './_generated/server';
import { inboxPending } from './inboxItems';
import { hasCapability, requireCapability } from './lib/auth';
import { type InboxRuleFacts, inboxCan, inboxCanWithCodes } from './lib/inboxRules';
import {
  claimsOf,
  decidedOf,
  InboxReader,
  itemMapOf,
  itemOfRef,
  itemsUpTo,
  itemView,
  MEDIAN_CAP,
  metersBetween,
  personRef,
  placeOf,
  readInboxLanes,
  rowLabel,
  TODAY_CAP,
} from './lib/inboxViews';
import { CHARGED_QUERY_BUDGET, requestBudget } from './lib/readBudget';
import { CALIBRATION_WINDOW_DAYS, stefanWindowFor } from './lib/stefanWindow';
import { literals } from './lib/validators';

const MINUTE = 60_000;
const DAY_MS = 86_400_000;

/** The page's clock, held within a minute of the server's. */
const clockOf = (asked: number | undefined) => callerNow(asked, Date.now(), MINUTE);

// ── The verbs and their answers ────────────────────────────────────────────────────────────────

/**
 * Every verb an Inbox handler draws. A row or an item answers only the verbs its kind draws; a verb
 * absent from `can` is not drawn.
 */
export type InboxVerb =
  | 'dismiss'
  | 'hide'
  | 'remove'
  | 'restore'
  | 'pin'
  | 'unpin'
  | 'retract'
  | 'ruleClosed'
  | 'ruleAccessible'
  | 'clearRuling'
  | 'approve'
  | 'decline'
  | 'sameAs'
  | 'lookUpAgain'
  | 'approveDrawn'
  | 'rejectDrawn'
  | 'mergeDrawn'
  | 'reply'
  | 'note'
  | 'resolve'
  | 'reopen';

/**
 * For each verb the item's handler draws: `null` — the viewer may; a sentence — the write's own
 * refusal, word for word (D268), and the button is not drawn (D217).
 */
export type InboxCan = Partial<Record<InboxVerb, string | null>>;

/**
 * Why a verb is refused, where a client must tell one refusal from another without reading its
 * words (B01-5d): `awaitsDrawing` — a place ask's *Approve* waits on a bay or landmark not drawn
 * yet, so the handler offers *Draw in Body →*; `ownDrawing` — a drawing's merge refused to the
 * staffer who drew it (D289), the code the Shape tab's preview gives too; `unmerging` — a merge refused
 * while an unmerge is still running on either body (R10-A). Only refusals a client acts
 * on have a code.
 */
export type InboxRefusalCode = 'awaitsDrawing' | 'ownDrawing' | 'unmerging';

/** Each refused verb's code, where it has one (absent for a verb allowed or a refusal with none). */
export type InboxCanCode = Partial<Record<InboxVerb, InboxRefusalCode>>;

/** Who decided an item, when and what (the Decided rows and the colleague lock, D283). */
export type InboxDecidedState = {
  at: number;
  /** Null when the decider's profile is gone (a system decision, or a finalized deletion). */
  by: { userId: Id<'profiles'>; displayName: string } | null;
  decision: InboxDecision;
  /** The audit row an undo reads and History links; null for a decision recorded before the Inbox. */
  actionId: Id<'moderationActions'> | null;
  /** The viewer decided it themselves — the lock clears quietly (they know). */
  byMe: boolean;
};

// ── The pieces a row or an item is built from ──────────────────────────────────────────────────

/** A person as a row names them: their real name (D287's fake people included, "Test-" and all). */
export type PersonRefView = {
  userId: Id<'profiles'>;
  displayName: string;
  /** Empty for a departed person (their handle is reserved, `publicAuthor`'s rule). */
  username: string;
  /** Deleted or leaving: drawn as a tombstone, never linked. */
  deleted: boolean;
  /** A moderator or admin (*· staff*, as 2.1's drawer says). */
  isStaff: boolean;
};

/** A person with their standing at a glance — a flagger's byline, an asker, a drawer. */
export type PersonLockupView = PersonRefView & {
  role: UserRole;
  /** Null for a departed person (no trust claim about someone who has gone). */
  trustClass: TrustClass | null;
  points: number;
};

/** 2.1's *Author* block: who wrote the flagged content (or the person flagged), and their standing. */
export type AuthorBlockView = {
  person: PersonLockupView;
  standing: {
    status: 'active' | 'suspended' | 'banned' | 'leaving' | 'deleted';
    /** When a suspension lifts on its own; null otherwise. */
    until: number | null;
    /** Who set the standing (a suspension or ban), when the audit names them. */
    by: PersonRefView | null;
  };
  /** Their visible reports, counted among their newest 100 (`capped` past them). */
  reports: Count | null;
  /**
   * Their settled contradictions (D56 §7b): the private, non-scoring tally on their profile — reports
   * the weather didn't explain, in the minority against a more-corroborated one. Never shown to skaters.
   */
  contradicted: Count | null;
  /** The newest of their reports that carry a settled contradiction (up to 10, among their newest 100). */
  contradictedReports: ReportRefView[];
  /** Their earlier flags a moderator actioned (on them or their content), counted to 50; the latest's time. */
  priorActioned: { count: number; capped: boolean; lastAt: number | null };
  /** Open flags on them or their content, this item's included. */
  openFlags: Count | null;
  /** What they may not post (People's restrictions); empty when nothing is restricted. */
  restrictions: Restriction[];
};

/** A water body as a row or a head names it. */
export type BodyRefView = {
  waterBodyId: Id<'waterBodies'>;
  name: string;
  /** "Enfield, NH" — the body's town and state when known. */
  place: string | null;
  type: WaterBodyClass;
  areaSqM: number | null;
  /** Taken off the map (D48): the item still lists it, the map draws it dimmed. */
  removed: boolean;
  /** Where the map centers when it has no other mark. */
  point: LatLng | null;
};

/** What a report claims, as stored (D193–D195) — the claims a moderator rules on, never a class. */
export type ReportClaimsView = {
  iceThickness: NonNullable<Doc<'reports'>['iceThickness']> | null;
  iceTypes: Doc<'reports'>['iceTypes'];
  surfaceTags: Doc<'reports'>['surfaceTags'];
  sightings: NonNullable<Doc<'reports'>['sightings']>;
  suitability: NonNullable<Doc<'reports'>['suitability']> | null;
  skateQuality: NonNullable<Doc<'reports'>['skateQuality']> | null;
  snow: NonNullable<Doc<'reports'>['snow']> | null;
};

type ModerationStatus = Doc<'reports'>['moderationStatus'];

/** A report as 2.1's subject draws it (and a Post's member, and a comment's head). */
export type ReportSubjectView = {
  reportId: Id<'reports'>;
  body: BodyRefView;
  point: LatLng;
  /** The report's own town and state ("Enfield, NH"), when stored. */
  place: string | null;
  skateStartTime: number | null;
  skateEndTime: number;
  observedFrom: ObservedFrom | null;
  notes: string | null;
  claims: ReportClaimsView;
  /**
   * Its photos: every one for a viewer with `content.read`; for anyone else only the visible ones
   * (B01-5e), counted among the first twelve — `photoCountIsFloor` says there may be more.
   */
  photoCount: number;
  photoCountIsFloor: boolean;
  moderationStatus: ModerationStatus;
  /** *Also on this report*: thumbs up and down; null when not read. */
  ratings: { up: number; down: number } | null;
  /**
   * *Corrob.*: how many other skaters' reports agreed with this one inside the corroboration window
   * (each a `report_corroborated` ledger row keyed to this report), counted to 50. Who corroborated is
   * not stored on the row, so no first corroborator is named.
   */
  corroborations: Count;
};

/** An access alert as skaters see it, and its life (2.6). */
export type AlertSubjectView = {
  accessAlertId: Id<'accessAlerts'>;
  body: BodyRefView;
  /** The put-in or lot it is about, by name, and where. */
  place: {
    name: string | null;
    point: LatLng | null;
    targetType: Doc<'accessAlerts'>['targetType'];
  };
  reason: Doc<'accessAlerts'>['reason'];
  kind: Doc<'accessAlerts'>['kind'];
  note: string | null;
  status: Doc<'accessAlerts'>['status'];
  createdAt: number;
  expiresAt: number | null;
  pinnedBy: PersonRefView | null;
  confirmCount: number;
  denyCount: number;
  lastConfirmedAt: number | null;
  /** Its life, oldest first: posted, pinned, confirmed, flagged, retracted (the kit `LifeStrip`). */
  life: {
    at: number;
    event:
      | 'posted'
      | 'pinned'
      | 'unpinned'
      | 'confirmed'
      | 'denied'
      | 'flagged'
      | 'retracted'
      | 'resolved';
    by: PersonRefView | null;
  }[];
};

/**
 * A photo as 2.7's stage draws it: staff URLs, pixelated until *Show the photo* (B01-5e, D222).
 * **The URLs, the reveal and a down photo's caption go only to a viewer with `content.read`** —
 * decided on the server, so a viewer with `inbox.read` alone gets `null`s and `canReveal: false`.
 */
export type PhotoSubjectView = {
  photoId: Id<'photos'>;
  /** `null` for a hidden or removed photo to a viewer without `content.read`, or none written. */
  caption: string | null;
  takenAt: number | null;
  createdAt: number;
  /**
   * The **thumbnail** only — the stage pixelates from it. `null` without `content.read` (then no URL
   * of any size is served) and on a purged tombstone. The full image is never in the item read: it
   * comes from `inbox.photoReveal`, a staff-only read keyed by the photo, called on *Show the photo*,
   * so it stays out of the page's data, not only its markup.
   */
  thumbUrl: string | null;
  reportId: Id<'reports'> | null;
  body: BodyRefView | null;
  /**
   * *On the same report*: the report's **other** photos — never the flagged one itself — in the
   * report's order, at most twelve (`siblingsCut` past them, or when the item's budget ran out). A
   * thumbnail only with `content.read` (never on a purged one); each with its status, and the id of
   * an open flag on it (`null` with none) — the Inbox ref `flag:<openFlagId>` opens its item.
   */
  siblings: {
    photoId: Id<'photos'>;
    thumbUrl: string | null;
    moderationStatus: ModerationStatus;
    openFlagId: Id<'contentFlags'> | null;
  }[];
  siblingsCut: boolean;
  /** Its place on the report (0-based; "1 of 4" is `indexOnReport + 1` of `photoCount`). */
  indexOnReport: number | null;
  photoCount: number | null;
  /** The photo's moderation axis, as staff see it; absent on the row reads as `visible`. */
  moderationStatus: ModerationStatus;
  /** When its status last moved (a takedown, a restore, its uploader's withdrawal); `null` never. */
  moderatedAt: number | null;
  /** The viewer may see the bytes (`content.read`): the reveal is drawn only then. */
  canReveal: boolean;
  /** When its uploader withdrew it (their delete while it was held, B01-5e); `null` otherwise. */
  withdrawnAt: number | null;
  /** A removal's purge: when its bytes go (`null` unless removed and not yet purged)… */
  purgeAt: number | null;
  /** …and when they went: the row is a tombstone from then, its URLs `null`. */
  purgedAt: number | null;
};

/** A hazard as a plain content flag's subject draws it: its kind, words, footprint and votes. */
export type HazardSubjectView = {
  hazardId: Id<'hazards'>;
  body: BodyRefView | null;
  type: Doc<'hazards'>['type'];
  note: string | null;
  point: LatLng | null;
  createdAt: number;
  /**
   * The skaters' votes on it, **by verdict, as they cast them** (PR #170) — never folded into two
   * sides: "never existed" says the pin was in the wrong place, "fully healed" that what was there is
   * gone, "healing" that it is still dangerous, and a passage marker (`ridge_crossing`) inverts what
   * each means. The handler labels each with core's `verdictLabel(verdict, type)`. D3: none of these is
   * a reading of the ice; a moderator reads who said what, never "fewer warnings" as safer.
   */
  votes: Record<HazardVerdict, number>;
  /** More votes than the read counts (200): each count is then a floor. */
  votesCapped: boolean;
};

/** The flagged thing, by target type; `exists: false` when it is gone (`(deleted)`). */
export type FlagTargetView =
  | { targetType: Doc<'contentFlags'>['targetType']; targetId: string; exists: false }
  | ({
      targetId: string;
      exists: true;
      /** The content's text in short; empty for hidden or removed content to a viewer without `content.read`. */
      summary: string;
      moderationStatus: ModerationStatus | null;
      /**
       * When its author withdrew it (deleted it, or it was erased): the content is no longer up, whatever
       * its moderation status says; null while it stands.
       */
      withdrawnAt: number | null;
      /**
       * Which withdrawal `withdrawnAt` is, as the stored row tells it: `deleted` — its author deleted
       * it (the row stands, its words kept for the record until the sweep); `erased` — the 30-day sweep
       * has since erased its words (a comment kept as a placeholder; the sweep erases only what its
       * author withdrew). `null` while it stands. A Report, Post or hazard the sweep erases is deleted
       * outright, so it reads as gone (`exists: false`), never `erased`. `null` exactly when
       * `withdrawnAt` is.
       */
      withdrawal: 'deleted' | 'erased' | null;
    } & (
      | { targetType: 'report'; report: ReportSubjectView }
      | {
          targetType: 'post';
          post: {
            postId: Id<'posts'>;
            title: string | null;
            body: string | null;
            reports: ReportSubjectView[];
          };
        }
      | {
          targetType: 'comment';
          comment: {
            commentId: Id<'comments'>;
            body: string;
            createdAt: number;
            /** The report or Post it hangs on, as a head above it. */
            on: { reportId: Id<'reports'> | null; postId: Id<'posts'> | null; head: string | null };
          };
        }
      | { targetType: 'hazard'; hazard: HazardSubjectView }
      | { targetType: 'photo'; photo: PhotoSubjectView }
      | { targetType: 'accessAlert'; alert: AlertSubjectView }
      | { targetType: 'waterbody'; body: BodyRefView }
      | { targetType: 'user'; person: AuthorBlockView }
    ));

/** One flag an item holds: who filed it (or the app), why, and what they said. */
export type FlagMemberView = {
  flagId: Id<'contentFlags'>;
  reason: Doc<'contentFlags'>['reason'];
  note: string | null;
  filedAt: number;
  status: InboxMemberStatus;
  /** Null for a flag the app filed (`autoFiled`) or whose filer is gone. */
  filer: PersonLockupView | null;
  /** *Filed by the app*: the rule's flag, with no byline. */
  autoFiled: boolean;
  /** How many times the app recorded this problem ("4th occurrence"); 1 for a person's flag. */
  occurrences: number;
  lastOccurrenceAt: number | null;
  /** The superseded flag's verdict ("last dismissed 6 d ago"). */
  prior: { resolvedAt: number; resolution: Doc<'contentFlags'>['status'] } | null;
};

/** An access ruling on a body (2.2's ruling event, and contest access's standing ruling). */
export type RulingView = {
  verdict: NonNullable<Doc<'waterBodies'>['publicAccess']>['verdict'];
  ruledAt: number;
  by: PersonRefView | null;
  /** The note the ruling shows on the lake (public, at most 160 characters). */
  note: string | null;
  /** What the ruler cited: the ruling's audit reason (staff-facing); null when none is recorded. */
  reason: string | null;
};

/** One ask an item holds (a request, a bay or landmark ask). */
export type AskMemberView = {
  requestId: Id<'waterBodyRequests'>;
  asker: PersonLockupView | null;
  askedAt: number;
  note: string | null;
  /** The name asked for (a place ask). */
  name: string | null;
  coord: LatLng;
  status: InboxMemberStatus;
  /** A landmark ask filed from a report's `where` (D202). */
  fromReport: { reportId: Id<'reports'>; skateEndTime: number; where: string | null } | null;
  activityId: Id<'gpsActivities'> | null;
  /**
   * The recorded skate the ask came from, as its row stores it (B01-5c): when it started and ended
   * and the provider's moving time. No distance — no activity row stores one. `null` with no
   * `activityId`, for an activity gone, or for one the item's budget left unread (read after the
   * item's rule, at most `VIEW_SKATES` an item, so a skate never costs a lever its check).
   */
  skate: SkateView | null;
  /**
   * On a landmark ask: how many landmarks this asker has asked for and had added, from their own
   * Inbox filings (small rows), at most `VIEW_ASKER_COUNTS` asks an item (B01-5c). `null` on every
   * other kind, past that cap, or while the Inbox backfill is pending (its filings aren't all stored).
   */
  landmarkAsks: AskerLandmarksView | null;
};

/**
 * A person's landmark asks (2.4's counts by the byline): the landmark items they filed into, open or
 * decided (this one included), and how many of those were approved — the landmark added. Read from
 * the newest `LANDMARK_FILINGS_READ` of their open and of their closed filings; `capped` past either,
 * when both counts are floors. A withdrawn ask has left its item and isn't counted.
 */
export type AskerLandmarksView = { asked: number; added: number; capped: boolean };

/** A drawn body's creating skate (2.5): its times, and whether it left a track for the map. */
export type DrawnSkateView = SkateView & {
  activityId: Id<'gpsActivities'>;
  /** The activity stores a GPS track (a LineString) — the map's skate. */
  hasTrack: boolean;
};

/** A recorded skate's times, as `gpsActivities` stores them (B01-5c). */
export type SkateView = {
  startTime: number;
  /** When it ended; `null` for a provider that sent none. */
  endTime: number | null;
  /** The provider's moving time, which leaves out stops (so not `endTime − startTime`); `null` when not sent. */
  elapsedSeconds: number | null;
};

/**
 * Why an activate ask's body is dormant (B01-5c): the body's own `dormant` record — `inactive` (nobody
 * has been there in `INACTIVE_SEASONS`), `not_in_campaign` (the prunes), or `moderator` (a person,
 * with a note the skater sees).
 */
export type DormancyView = {
  reason: DormancyReason;
  since: number;
  /** The moderator's note, shown to skaters on the lake; `null` when none. */
  note: string | null;
  /** Who shelved it (a staffer, for `moderator`); `null` for the machine's own. */
  by: PersonRefView | null;
};

/** An admit's catalog feature (2.3's catalog block). */
export type CandidateView = {
  source: '3dhp';
  externalId: string;
  name: string | null;
  cls: WaterBodyClass | null;
  areaSqM: number;
  centroid: LatLng;
  polygon: NonNullable<Doc<'waterBodyRequests'>['candidate']>['polygon'];
  matchedAt: number;
  /** How far the feature is from the first ask's point. */
  metersFromAsk: number | null;
  /**
   * The nearest body already on the map ("Ricker Pond · 1.3 km west"), as the catalog lookup stamped
   * it on the ask (`waterBodyRequests.nearestKnown`, B01-5d: a bounded geo read at the lookup's write,
   * never at this read). `null` for an ask looked up before it was stamped — until *Look up again* —
   * and when no listed body lies within the lookup's margin.
   */
  nearestKnown: { waterBodyId: Id<'waterBodies'>; name: string; meters: number } | null;
};

/** A place that may already answer a landmark ask (2.4's lookalike). */
export type LookalikeView =
  | {
      kind: 'landmark';
      landmarkId: Id<'bodyLandmarks'>;
      name: string;
      point: LatLng;
      meters: number;
      /** 2.4's *Kind* row (a strait, a point, a beach…). */
      landmarkKind: Doc<'bodyLandmarks'>['kind'];
      /** Where it came from (*· OpenStreetMap*). */
      source: Doc<'bodyLandmarks'>['source'];
      aliases: string[];
      /** "Used by 1 report"; null when not read. */
      usedByReports: number | null;
    }
  | {
      kind: 'proposal';
      requestId: Id<'waterBodyRequests'>;
      name: string;
      coord: LatLng;
      meters: number;
    };

/** A drawn body over a known one (2.5's gauge). */
export type OverlapView = {
  /** The share of the drawing inside the known body, 0–1. */
  share: number;
  body: BodyRefView;
  /** The share is at or past the merge threshold (*Merge suggested from 80 %*). */
  suggested: boolean;
};

/** A report an item points at (a drawn body's skate). */
export type ReportRefView = {
  reportId: Id<'reports'>;
  skateEndTime: number;
  author: PersonRefView | null;
  observedFrom: ObservedFrom | null;
};

/** A support ticket (2.8). */
export type TicketView = {
  ticketId: Id<'supportTickets'>;
  category: Doc<'supportTickets'>['category'];
  body: string;
  createdAt: number;
  /** `in_progress` reads as open (D284: no assignee, no claim). */
  status: 'open' | 'resolved';
  context: NonNullable<Doc<'supportTickets'>['context']> | null;
  resolvedAt: number | null;
  resolvedBy: PersonRefView | null;
};

/**
 * A staffer's note or email reply on a ticket (B01-5f, `supportMessages`) — staff-only and PII, served
 * only behind `inbox.support.read`. Never the address a reply went to.
 */
export type SupportMessageView = {
  messageId: Id<'supportMessages'>;
  /** A `note` is staff-only (the dashed box); a `reply` went, or is going, to the person by email. */
  kind: 'note' | 'reply';
  author: PersonRefView | null;
  /** `null` once a note is removed (its undo puts it back). */
  body: string | null;
  createdAt: number;
  removedAt: number | null;
  /**
   * A note: `null` when this viewer may remove it now (`support.removeNote`), else that write's
   * sentence. A reply: always a sentence (a reply is canceled, never removed).
   */
  remove: string | null;
  reply: {
    /**
     * `settling` while its window runs (*Sending in 60 s · Undo*) and while its send is under way;
     * `sent`; `canceled` (undone inside the window); `failed` (*Not sent*, with `failedWhy`).
     */
    status: 'settling' | 'sent' | 'canceled' | 'failed';
    sendAfter: number;
    sentAt: number | null;
    /**
     * Why it wasn't sent, as a class, never the provider's message or an address: no support sender
     * configured, a seeded ticket (never mailed), no address on file, the provider refused (or no
     * send ever ran) — or `outcomeUnknown`: its send started and stopped before saying how it went,
     * so it **may or may not have been sent** (worded as that, never as sent or as not sent).
     */
    failedWhy: 'unconfigured' | 'seed' | 'noAddress' | 'sendFailed' | 'outcomeUnknown' | null;
    /**
     * Whether this viewer may cancel it now (`support.cancelReply`): `null`, or the sentence that
     * write refuses with — the undo's own rule, so *Undo* is drawn only where it lands (D217). Asked
     * at read time; a client hides *Undo* once `sendAfter` passes, when the write refuses it.
     */
    cancel: string | null;
  } | null;
};

/** A flag about the ticket's person, on 2.8's *Related* (each opens its Inbox item, `flag:<id>`). */
export type TicketRelatedFlagView = {
  flagId: Id<'contentFlags'>;
  reason: Doc<'contentFlags'>['reason'];
  targetType: Doc<'contentFlags'>['targetType'];
  status: 'open' | 'actioned';
  createdAt: number;
  resolvedAt: number | null;
};

// ── An item (`inbox.item`) ─────────────────────────────────────────────────────────────────────

type ItemBase = {
  itemId: Id<'inboxItems'>;
  lane: InboxLane;
  facet: string;
  /** The oldest open member's filing (a decided item: its oldest member's). */
  filedAt: number;
  lastActivityAt: number;
  memberCount: number;
  /**
   * The count stopped at the most an item counts (`MAX_MEMBERS`): `memberCount` is a floor, drawn
   * "500+" — never a total a window cut short passed off as exact.
   */
  memberCountIsFloor: boolean;
  can: InboxCan;
  /**
   * The refusal codes beside `can` (B01-5d): a refused verb's code where a client acts on which
   * refusal it is — `approve: 'awaitsDrawing'` exactly where a place ask's *Approve* waits on a bay or
   * landmark not drawn yet (the handler's *Draw in Body →*). Empty when no refusal has a code.
   */
  canCode: InboxCanCode;
  decided: InboxDecidedState | null;
};

/** One item as its handler draws it — one variant per kind. */
export type InboxItemView = ItemBase &
  (
    | {
        kind: 'flag';
        target: FlagTargetView;
        /**
         * Oldest first: the oldest `VIEW_MEMBERS` of each status, each read whole (B01-5c) — fewer
         * when the item's budget can't hold the next flag and its filer; `memberCount` is the total.
         */
        flags: FlagMemberView[];
        /** The list ended because the item's budget couldn't hold the next flag whole (B01-5c). */
        flagsCut: boolean;
        author: AuthorBlockView | null;
      }
    | {
        kind: 'access';
        body: BodyRefView;
        /**
         * Newest first: the newest `VIEW_MEMBERS` of each status, each read whole (B01-5c) — fewer
         * when the item's budget can't hold the next report and its filer; `memberCount` is the total.
         */
        reports: FlagMemberView[];
        /** The list ended because the item's budget couldn't hold the next report whole (B01-5c). */
        reportsCut: boolean;
        ruling: RulingView | null;
        /**
         * The reports the standing ruling dismissed (2.2's timeline), found among the body's first
         * `DISMISSED_BY_RULING_READ` (20) dismissed access reports, each with its filer.
         */
        dismissedByRuling: FlagMemberView[];
        /**
         * The body has more dismissed reports than were read, or the budget ended the read: the list
         * may be missing some the ruling dismissed (B01-5c).
         */
        dismissedByRulingCut: boolean;
        /**
         * People asking for the body back as accessible: its open `contest_access` asks — which a
         * skater can file only while it stands under a no-public-access ruling — counted to 200.
         */
        contestAsks: Count;
      }
    | {
        kind: 'request';
        requestKind: RequestKind;
        body: BodyRefView | null;
        /**
         * Newest first by when each was asked, open and closed together, as the Access item's
         * reports: the newest `VIEW_MEMBERS` (50) of each status, by count, each read whole (B01-5c).
         * Fewer when the item's budget can't hold the next ask at its worst (an admit carrying a
         * catalog polygon near the document limit): the list ends there and `asksCut` says so. The
         * true total is `memberCount` (`memberCountIsFloor` past 500): the web draws "Showing
         * `asks.length` of `memberCount`".
         */
        asks: AskMemberView[];
        /** The list ended because the item's budget couldn't hold the next ask whole. */
        asksCut: boolean;
        /**
         * The ask a decision is sent for — the newest open one served (the first ask in `asks` that is
         * open), whose reach the item's `can` was checked for. Any ask of the item closes the same group.
         */
        primaryRequestId: Id<'waterBodyRequests'>;
        candidate: CandidateView | null;
        /** Why no catalog feature matched — *Look up again* stands in for *Admit*. */
        resolveError: string | null;
        /**
         * A *contest access* ask's standing ruling — the one it contests, as the Access item serves its
         * ruling event (B01-5c). `null` for every other kind, and for a body with no ruling.
         */
        ruling: RulingView | null;
        /** An *activate* ask's body's dormancy, as the body stores it (B01-5c); `null` otherwise. */
        dormancy: DormancyView | null;
      }
    | {
        kind: 'place';
        placeKind: 'name_bay' | 'name_landmark';
        body: BodyRefView;
        /** Newest first, capped as a request's are (B01-5c). */
        asks: AskMemberView[];
        /** As a request's. */
        asksCut: boolean;
        /** The ask a decision is sent for, as a request's (B01-5c). */
        primaryRequestId: Id<'waterBodyRequests'>;
        /** A bay by the asked name now drawn on the body — *Approve* is drawn only then. */
        drawnSubAreaId: Id<'waterBodySubAreas'> | null;
        /**
         * A live landmark that already answers a landmark ask by name and place — *Approve* is
         * drawn only then; a lookalike is answered by *Same place* (`approve` with `sameAs`).
         */
        answeringLandmarkId: Id<'bodyLandmarks'> | null;
        lookalikes: LookalikeView[];
      }
    | {
        kind: 'drawn';
        body: BodyRefView;
        drawer: PersonLockupView | null;
        /**
         * The drawer's visible reports, as their profile counts them (the public profile's figure,
         * a stored count — B01-5c); `null` for a drawer gone or a profile the count hasn't reached.
         */
        drawerReports: number | null;
        overlap: OverlapView | null;
        /**
         * The report the drawing's skate became (B01-5c): the skate's `linkedReportId`, with a
         * capped excerpt of its text — `null` text for one hidden, removed or withdrawn by its author,
         * to a viewer without `content.read`. `null` when the skate has no report.
         */
        fromReport: (ReportRefView & { excerpt: string | null }) | null;
        /**
         * The skate the drawing was made from (B01-5c): the drawer's own activity bound to this body
         * that started before it was drawn — one row, the latest such. `null` when none is found.
         */
        skate: DrawnSkateView | null;
      }
    | {
        kind: 'ticket';
        ticket: TicketView;
        /**
         * The thread after the ticket's own body: the newest messages (at most `THREAD_MESSAGES`,
         * `lib/supportThread`), oldest first, newest last.
         */
        messages: SupportMessageView[];
        /** How many messages are served; with `messagesCut`, a floor ("100+"). */
        messageCount: number;
        /** Older messages were cut: the thread starts part-way (a cut line above the first). */
        messagesCut: boolean;
        /**
         * The address a reply goes out from (`SUPPORT_FROM_EMAIL`, the configured sender — nothing
         * else from the environment), or `null` when it is unset and no reply will be sent.
         */
        replyFrom: string | null;
        /** Why a reply written now would not be sent, before it is written; `null` when it would. */
        replyBlocked: 'unconfigured' | 'seed' | null;
        /**
         * The person's tickets, as the Inbox files them (their ticket members, open and resolved),
         * each status counted to a bound (`capped`: the figures are floors); `null` for a ticket filed
         * before they had a profile.
         */
        personTickets: { total: number; resolved: number; capped: boolean } | null;
        /** The person who filed it; `null` for a ticket filed before they had a profile. */
        person: AuthorBlockView | null;
        /** Flags about that person, newest first: the open ones, then those actioned. */
        related: { flags: TicketRelatedFlagView[]; capped: boolean };
      }
  );

/**
 * `inbox.item`'s answer: the item, or `null` — *No such item* (the list stays usable). `pending`
 * while the backfill runs: a ref may name a source row whose item isn't stored yet, so a `null` then
 * reads *Not yet*, not *No such item*.
 */
export type InboxItemRead = { item: InboxItemView | null; pending: boolean };

// ── A row (`inbox.listPage`, `inbox.tail`) ─────────────────────────────────────────────────────

type RowBase = {
  itemId: Id<'inboxItems'>;
  lane: InboxLane;
  facet: string;
  filedAt: number;
  lastActivityAt: number;
  memberCount: number;
  /**
   * The count stopped at the most an item counts (`MAX_MEMBERS`): `memberCount` is a floor, drawn
   * "500+" — never a total a window cut short passed off as exact.
   */
  memberCountIsFloor: boolean;
  body: BodyRefView | null;
  can: InboxCan;
  decided: InboxDecidedState | null;
};

/** A list row's label facts, by kind — resolved at read, so a rename never leaves a row stale. */
export type InboxRowView = RowBase &
  (
    | {
        kind: 'flag';
        /** The distinct reasons on the item, the oldest member's first. */
        reasons: Doc<'contentFlags'>['reason'][];
        target: {
          targetType: Doc<'contentFlags'>['targetType'];
          exists: boolean;
          summary: string;
          moderationStatus: ModerationStatus | null;
          /** Its author withdrew it (deleted, or erased): not up, whatever the status says. */
          withdrawn: boolean;
        };
        author: PersonRefView | null;
        /** The oldest member's filer; null for the app's own flag. */
        firstFiler: PersonRefView | null;
        autoFiled: boolean;
        occurrences: number;
      }
    | {
        kind: 'access';
        /** Distinct reporters (`memberCount`, by the one-flag-per-flagger rule; a floor with it). */
        reporters: number;
        latestNote: string | null;
        /** The standing ruling these reports came after (*disputes 12 Sep*). */
        disputes: { verdict: RulingView['verdict']; ruledAt: number } | null;
      }
    | {
        kind: 'request';
        requestKind: RequestKind;
        /** Distinct people, not rows. */
        askers: number;
        firstAsker: PersonRefView | null;
        note: string | null;
        candidate: { name: string | null; areaSqM: number } | null;
        resolveError: string | null;
      }
    | {
        kind: 'place';
        placeKind: 'name_bay' | 'name_landmark';
        name: string;
        askers: number;
        firstAsker: PersonRefView | null;
        others: PersonRefView[];
        fromReport: boolean;
        /** The nearest lookalike's distance (*lookalike 0.4 mi*); null for none or a bay ask. */
        lookalikeMeters: number | null;
      }
    | {
        kind: 'drawn';
        drawer: PersonRefView | null;
        overlapShare: number | null;
        overName: string | null;
        fromSkate: boolean;
      }
    | {
        kind: 'ticket';
        category: Doc<'supportTickets'>['category'];
        person: PersonRefView | null;
        snippet: string;
      }
  );

/** A row's kind, the same names as the item's. */
export type InboxRowKind = InboxItemKind;

/** The list's filter (the filter menu): a body, a person, or an age floor. */
export type InboxListFilter =
  | { waterBodyId: string }
  | { subjectUserId: string }
  | { minAgeDays: number };

/**
 * `inbox.listPage`'s answer: People's `endCursor` chain — a page read past is pinned to where it
 * ended, so a decision on page one moves nothing on page two.
 */
export type InboxListPage = {
  rows: InboxRowView[];
  isDone: boolean;
  continueCursor: string;
  splitCursor?: string;
  pageStatus?: string;
  /** The filter's scan, not the list, ended this page: more rows may match past it. */
  scanBudgetSpent: boolean;
  /** The backfill is still running: the list may be missing items. */
  pending: boolean;
};

// ── The lanes, the tail, the day ───────────────────────────────────────────────────────────────

/** One lane's figures (`inbox.lanes`). */
export type InboxLaneFigures = {
  lane: InboxLane;
  open: number;
  /** Each tab's open count, `all` included. */
  facets: Record<string, number>;
  /** The oldest open item's filing; null when the lane is empty. */
  oldestFiledAt: number | null;
  /**
   * The filter menu's age options (`INBOX_AGE_FLOORS_DAYS`): open items filed at least that many days
   * ago, counted to 200 (`capped`: at least that many). Access ranks by corroboration, so its counts
   * come from its first 200 items by rank — capped when it holds more.
   */
  olderThan: { days: number; count: Count }[];
};

/**
 * `inbox.lanes`'s answer, from `inboxCounts` — the Overview's Inbox card reads the same rows, so the
 * two agree by construction. Support's lane is absent for a viewer without `inbox.support.read`.
 */
export type InboxLanesView = {
  lanes: InboxLaneFigures[];
  /** Every open item the viewer may read (*All open*). */
  allOpen: number;
  /** Every decided item (*Decided*). */
  decided: number;
  /** Decided since the console's local midnight (*Today*), counted to 500. */
  today: Count;
  /** When the median open item was filed, for the client to age on its own clock; null when empty. */
  medianFiledAt: number | null;
  pending: boolean;
};

/** `inbox.tail`'s answer: the lane's *Decided this week*, newest first. */
export type InboxTailView = { rows: InboxRowView[]; capped: boolean; pending: boolean };

/** `inbox.today`'s answer (2.9): what was filed and decided since the console's local midnight. */
export type InboxTodayView = {
  /** The console's local midnight the day was read from. */
  since: number;
  /** Items filed today, oldest first (the open line's rises and its rug). */
  filed: { at: number; lane: InboxLane }[];
  filedCapped: boolean;
  /** Items decided today, oldest first (the line's falls; the median; *Decided today, by lane*). */
  decided: { at: number; filedAt: number; lane: InboxLane; decision: InboxDecision }[];
  decidedCapped: boolean;
  /**
   * Open as the day began (the line's first step), derived from what stands now: open now, less those
   * filed today, plus those decided today that were filed before it. **An estimate, not a record**:
   * an item that left the Inbox today (its last member withdrawn or erased) or that an undo reopened
   * today moves it by one, since nothing stores either. `null` when the day's filings or decisions
   * were capped (`filedCapped`, `decidedCapped`), never a figure from a partial read.
   */
  openAtStart: number | null;
  pending: boolean;
};

// ── 2.1's context ──────────────────────────────────────────────────────────────────────────────

/** One report *Around it* (2.1's drawer row). */
export type AroundReportView = {
  reportId: Id<'reports'>;
  skateStartTime: number | null;
  skateEndTime: number;
  observedFrom: ObservedFrom | null;
  author: PersonRefView | null;
  /** The author's visible reports (*· 14 reports*); null when not read. */
  authorReports: number | null;
  notes: string | null;
  claims: ReportClaimsView;
  /** From the flagged report's point; null when either point is missing. */
  distanceMeters: number | null;
  /** The named place nearest its point (*Town beach*); null when none. */
  placeName: string | null;
  /** Staff read hidden ones too, marked. */
  moderationStatus: ModerationStatus;
};

/**
 * `inbox.aroundIt`'s answer, or `null` when the report is gone. `phrases` are every phrase earned,
 * in order (core's `aroundItPhrases`); the line shows the first three.
 */
export type AroundItView = {
  flagged: AroundReportView;
  /** The other reports in the window, by skate end, oldest first. */
  reports: AroundReportView[];
  window: { from: number; to: number; days: number };
  /** More reports lay before / after the window's 50 each side. */
  cappedBefore: boolean;
  cappedAfter: boolean;
  phrases: AroundItPhrase[];
};

/** The Stefan thickness estimate (D288), or why it declined — context, never a verdict. */
export type StefanEstimateView =
  | { thicknessIn: number; freezingDegreeDays: number; alpha: number; windowDays: number }
  | { declined: 'thaw' | 'too_little_cold' | 'no_weather' };

/**
 * `inbox.claimWeather`'s answer (2.1's *That night, at the body*), or `null` (*Not recorded yet*)
 * for a missing report, a removed body or one with no weather cell. Temperatures in °C; the page
 * converts.
 */
export type ClaimWeatherView = {
  /** The skate's local calendar day (midnight UTC of that date, as `weatherDays.dayMs`). */
  dayMs: number;
  /** That night's low; null when the window wasn't fully observed (*Not recorded*). */
  lowC: number | null;
  /** Freezing nights in a row ending on the skate day; `gapAfter`: the run ended at a missing night. */
  freezingNights: { run: number; gapAfter: boolean };
  /** Freezing degree-days (°C·day) over complete days since 1 October (D249). */
  freezingDegreeDaysC: { value: number; since: number; days: number };
  stefan: StefanEstimateView;
};

// ── An item's map (`inbox.itemMap`) ────────────────────────────────────────────────────────────

/** A point as the embed's scene builders take it: `[lng, lat]`. */
export type InboxMapLngLat = [number, number];

/**
 * A body's outline for an embed (the web's `EmbedBody`). `simplified`: the stored outline was larger
 * than an embed is sent ({@link MAP_OUTLINE_BYTES}), so this is its largest ring kept to at most
 * {@link MAP_RING_POINTS} points (the Body console's `simplifiedRing`) — enough to draw, not to edit.
 */
export type InboxMapBody = {
  id: string;
  name: string;
  outline: GeoPolygon | GeoMultiPolygon;
  simplified: boolean;
};

/** A point somebody filed, or a place (the web's `EmbedPoint`). */
export type InboxMapPoint = { id: string; at: InboxMapLngLat; name?: string };

/**
 * A recorded skate's GPS track for an embed (the web's `EmbedPath`: `id`, `path` as `[lng, lat]`),
 * B01-5c. `id` is the activity's. `simplified`: the stored track was larger than an embed is sent
 * ({@link MAP_OUTLINE_BYTES}), so this is it thinned evenly to at most {@link MAP_RING_POINTS}
 * points, its first and last kept — enough to draw, not to measure.
 */
export type InboxMapTrack = { id: string; path: InboxMapLngLat[]; simplified: boolean };

/** A put-in or a lot (the web's `EmbedAccessPoint`). */
export type InboxMapAccessPoint = InboxMapPoint & { kind: 'putIn' | 'lot' };

/**
 * What an item's embedded map draws, and nothing more, per kind:
 * - `flag` on a report or hazard: `body`, and the flagged point in `points`; on an access alert:
 *   `body`, and the alert's put-in or lot in `access`;
 * - `access`: `body`, and its put-ins and lots in `access`;
 * - `request`: `body` when there is one, else the catalog feature as `candidate`; each ask's point in
 *   `points`; the nearest listed body in `others` when the admit names one;
 * - `place`: `body`, the asked points in `points`, each lookalike in `lookalikes`;
 * - `drawn`: the drawing as `body`, the known body it overlaps in `others`, and `overlapShare`.
 *
 * `capped`: something was left out to keep the answer within its byte bound.
 */
export type InboxMapView = {
  kind: InboxItemKind;
  body: InboxMapBody | null;
  candidate: InboxMapBody | null;
  others: InboxMapBody[];
  points: InboxMapPoint[];
  access: InboxMapAccessPoint[];
  lookalikes: InboxMapPoint[];
  /**
   * The skates behind the item, as tracks (B01-5c): on a `request`, each ask's recorded skate the
   * item read serves (`AskMemberView.skate`); on a `drawn` item, the skate it was drawn from
   * (`skate`, when `hasTrack`). Empty for every other kind. One left out for the answer's bound sets
   * `capped`.
   */
  tracks: InboxMapTrack[];
  overlapShare: number | null;
  capped: boolean;
};

/** `inbox.itemMap`'s answer: the map, or `null` for no such item (`pending` as `inbox.item`'s). */
export type InboxMapRead = { map: InboxMapView | null; pending: boolean };

// The map's bounds live in a leaf module both this and `lib/inboxViews.ts` import (B01-5c).
export { MAP_OUTLINE_BYTES, MAP_RING_POINTS } from './lib/inboxMapBounds';

// ── Args ───────────────────────────────────────────────────────────────────────────────────────

const nowArg = { now: v.optional(v.number()) };

/**
 * The console's local midnight, as the client computes it: the server can't know the browser's zone.
 * Held to the 36 hours before `now` (`heldDayStart`), so a stale or hand-made value never widens a
 * read.
 */
const dayStartArg = { dayStart: v.number() };

const filterArg = v.union(
  v.object({ waterBodyId: v.string() }),
  v.object({ subjectUserId: v.string() }),
  v.object({ minAgeDays: v.number() }),
);

/** Support's rows are PII (D37): a support read by a viewer without it is refused in these words. */
const SUPPORT_REFUSAL = 'Support tickets are read only by staff who answer them';

/** The day's start, held to `[now − 36 h, now]`. */
export function heldDayStart(dayStart: number, now: number): number {
  return Math.min(now, Math.max(now - 1.5 * DAY_MS, dayStart));
}

// ── The reads ──────────────────────────────────────────────────────────────────────────────────

/** Rows a filtered list scans for one page at most (`scanBudgetSpent` when it ran out first). */
export const SCAN_ROWS = 500;
/** The most rows a page asks for. */
const MAX_PAGE = 100;
/** A lane's *Decided this week*: the newest this many. */
export const TAIL_ROWS = 20;
/** Reports *Around it* reads on each side of the flagged one. */
export const AROUND_ROWS = 50;
/**
 * Rows *Around it* scans on a side at most, kept or not: reports an author took back are read and
 * skipped, so the scan, not only the list, needs a bound.
 */
export const AROUND_SCAN = 4 * AROUND_ROWS;

/** The request's budget: the transaction's, less the caller's own profile. */
const budgetOf = (ctx: QueryCtx) => requestBudget(ctx, CHARGED_QUERY_BUDGET);

/** A row as the list draws it: its labels, the verbs the viewer may use, and its decision. */
async function rowOf(
  ctx: QueryCtx,
  r: InboxReader,
  viewer: Doc<'profiles'>,
  item: Doc<'inboxItems'>,
): Promise<InboxRowView> {
  const label = await rowLabel(r, item);
  return {
    ...label,
    can: await inboxCan(ctx, viewer, item, rowFactsOf(item), (n, read) => r.take('small', n, read)),
    decided: await decidedOf(r, item),
  } as InboxRowView;
}

/**
 * The facts a row's verbs need that the stored item already carries, and no more: a restore or
 * takedown request's kind (its facet), on which its approval's capability turns (`body.remove`, an
 * admin's). Those kinds draw no precondition a row can't know, so the row's `can` is the item's;
 * every other row's capabilities turn on no fact (`capabilitiesFor` reads only the request kind).
 */
function rowFactsOf(item: Doc<'inboxItems'>): InboxRuleFacts | undefined {
  if (item.kind === 'request' && (item.facet === 'restore' || item.facet === 'takedown')) {
    return { requestKind: item.facet };
  }
  return undefined;
}

/** A lane's page, `all`'s flow-through, or the Decided list. */
export const listPage = query({
  args: {
    lane: literals(INBOX_LIST_LANES),
    facet: v.optional(v.string()),
    filter: v.optional(filterArg),
    cursor: v.optional(v.union(v.string(), v.null())),
    /** Where the page ended when first read: the page then reads exactly `(cursor, endCursor]`. */
    endCursor: v.optional(v.union(v.string(), v.null())),
    pageSize: v.optional(v.number()),
    ...nowArg,
  },
  handler: async (ctx, args): Promise<InboxListPage> => {
    const viewer = await requireCapability(ctx, 'inbox.read');
    if (args.lane === 'support') requireSupportRead(viewer);
    const support = hasCapability(viewer, 'inbox.support.read');
    const now = clockOf(args.now);
    const lane = args.lane;
    const facet = args.facet && args.facet !== 'all' ? args.facet : null;
    if (facet !== null && (lane === 'all' || lane === 'decided' || !isInboxFacet(lane, facet))) {
      throw new ConvexError('There is no such tab in this lane');
    }
    const pageSize = Math.min(Math.max(1, Math.floor(args.pageSize ?? INBOX_PAGE_SIZE)), MAX_PAGE);
    const status = lane === 'decided' ? ('decided' as const) : ('open' as const);
    const order = lane === 'all' || lane === 'decided' ? null : INBOX_LANE_ORDER[lane];
    const filter = args.filter;
    const budget = budgetOf(ctx);
    const pending = await inboxPending(ctx);

    // The range: the lane's own index when nothing filters it; a body's or a person's index (by
    // filing) when one does, the lane checked in the scan; an age floor checked in the scan.
    const items = ctx.db.query('inboxItems');
    let query: OrderedQuery<NamedTableInfo<DataModel, 'inboxItems'>>;
    let filtered = false;
    if (filter && 'waterBodyId' in filter) {
      const id = ctx.db.normalizeId('waterBodies', filter.waterBodyId);
      if (!id)
        return { rows: [], isDone: true, continueCursor: '', scanBudgetSpent: false, pending };
      query = items.withIndex('by_body_status', (q) =>
        q.eq('waterBodyId', id).eq('status', status),
      );
      filtered = true;
    } else if (filter && 'subjectUserId' in filter) {
      const id = ctx.db.normalizeId('profiles', filter.subjectUserId);
      if (!id)
        return { rows: [], isDone: true, continueCursor: '', scanBudgetSpent: false, pending };
      query = items.withIndex('by_subject_status', (q) =>
        q.eq('subjectUserId', id).eq('status', status),
      );
      filtered = true;
    } else if (lane === 'decided') {
      query = items.withIndex('by_status_decided', (q) => q.eq('status', 'decided')).order('desc');
      filtered = !support;
    } else if (order === null) {
      query = items.withIndex('by_status_lane_rank', (q) =>
        support
          ? q.eq('status', 'open')
          : q.eq('status', 'open').lt('laneOrder', INBOX_LANE_ORDER.support),
      );
    } else if (facet !== null) {
      query = items.withIndex('by_status_lane_facet_rank', (q) =>
        q.eq('status', 'open').eq('laneOrder', order).eq('facet', facet),
      );
    } else {
      query = items.withIndex('by_status_lane_rank', (q) =>
        q.eq('status', 'open').eq('laneOrder', order),
      );
    }
    const ageFloor =
      filter && 'minAgeDays' in filter ? now - Math.max(0, filter.minAgeDays) * DAY_MS : null;
    const scoped = filter !== undefined && !('minAgeDays' in filter);
    if (ageFloor !== null || scoped || !support) {
      filtered = filtered || ageFloor !== null || scoped;
      query = query.filter((q) => {
        const parts = [];
        if (ageFloor !== null) parts.push(q.lte(q.field('filedAt'), ageFloor));
        if (scoped && order !== null) parts.push(q.eq(q.field('laneOrder'), order));
        if (scoped && facet !== null) parts.push(q.eq(q.field('facet'), facet));
        if (!support) parts.push(q.neq(q.field('laneOrder'), INBOX_LANE_ORDER.support));
        return parts.length === 0 ? true : q.and(...parts);
      });
    }
    const cursor = args.cursor ?? null;
    const endCursor = args.endCursor ?? null;
    budget.reserve('small', filtered ? SCAN_ROWS : pageSize);
    const page = await query.paginate({
      cursor,
      numItems: pageSize,
      ...(endCursor !== null ? { endCursor } : {}),
      ...(filtered ? { maximumRowsRead: SCAN_ROWS } : {}),
    });
    const r = new InboxReader(ctx, budget, now, viewer._id, hasCapability(viewer, 'content.read'));
    const rows: InboxRowView[] = [];
    for (const item of page.page) rows.push(await rowOf(ctx, r, viewer, item));
    return {
      rows,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
      ...(page.splitCursor ? { splitCursor: page.splitCursor } : {}),
      ...(page.pageStatus ? { pageStatus: page.pageStatus } : {}),
      scanBudgetSpent: filtered && !page.isDone && page.page.length < pageSize,
      pending,
    };
  },
});

/** The lanes' open counts, the decided total, *Today* and each lane's oldest. */
export const lanes = query({
  args: { ...nowArg, ...dayStartArg },
  handler: async (ctx, args): Promise<InboxLanesView> => {
    const viewer = await requireCapability(ctx, 'inbox.read');
    const now = clockOf(args.now);
    const figures = await readInboxLanes(ctx, {
      support: hasCapability(viewer, 'inbox.support.read'),
      dayStart: heldDayStart(args.dayStart, now),
      ageFloorsAt: now,
    });
    return { ...figures, pending: await inboxPending(ctx) };
  },
});

/** A lane's *Decided this week*, newest 20. */
export const tail = query({
  args: { lane: literals(INBOX_LANES), ...nowArg },
  handler: async (ctx, args): Promise<InboxTailView> => {
    const viewer = await requireCapability(ctx, 'inbox.read');
    if (args.lane === 'support') requireSupportRead(viewer);
    const now = clockOf(args.now);
    const order = INBOX_LANE_ORDER[args.lane];
    const budget = budgetOf(ctx);
    const items = await budget.take('small', TAIL_ROWS + 1, (n) =>
      ctx.db
        .query('inboxItems')
        .withIndex('by_lane_status_decided', (q) =>
          q
            .eq('laneOrder', order)
            .eq('status', 'decided')
            .gte('decidedAt', now - 7 * DAY_MS),
        )
        .order('desc')
        .take(n),
    );
    const r = new InboxReader(ctx, budget, now, viewer._id, hasCapability(viewer, 'content.read'));
    const rows: InboxRowView[] = [];
    for (const item of items.slice(0, TAIL_ROWS)) rows.push(await rowOf(ctx, r, viewer, item));
    return { rows, capped: items.length > TAIL_ROWS, pending: await inboxPending(ctx) };
  },
});

/**
 * One item behind `?item=`: `ref` is the item's id or a source ref (`flag:<id>`, `request:<id>`,
 * `body:<id>`, `ticket:<id>`); a bare id is tried as each source (the audit feed's `?item=` links).
 */
export const item = query({
  args: { ref: v.string(), ...nowArg },
  handler: async (ctx, args): Promise<InboxItemRead> => {
    const viewer = await requireCapability(ctx, 'inbox.read');
    if (args.ref.startsWith('ticket:')) requireSupportRead(viewer);
    const now = clockOf(args.now);
    const pending = await inboxPending(ctx);
    const found = await itemOfRef(ctx, args.ref);
    if (!found) return { item: null, pending };
    if (found.lane === 'support') requireSupportRead(viewer);
    const r = new InboxReader(
      ctx,
      budgetOf(ctx),
      now,
      viewer._id,
      hasCapability(viewer, 'content.read'),
    );
    const built = await itemView(r, found);
    if (!built) return { item: null, pending };
    const { can, canCode } = await inboxCanWithCodes(ctx, viewer, found, built.facts);
    const view = {
      ...built.view,
      can,
      canCode,
      decided: await decidedOf(r, found),
    } as InboxItemView;
    return { item: view, pending };
  },
});

/**
 * **The full photo, on *Show the photo*** (board 2.7, B01-5e) — a staff-only read keyed by the photo
 * (`inbox.read` and `content.read`), so the full image's address is in the page's data only once a
 * moderator asks for it; the item read serves the thumbnail alone. `null` for a photo that is gone or
 * purged (a tombstone serves no address).
 */
export const photoReveal = query({
  args: { photoId: v.id('photos') },
  handler: async (ctx, { photoId }): Promise<{ url: string | null }> => {
    await requireCapability(ctx, 'inbox.read');
    await requireCapability(ctx, 'content.read');
    const budget = budgetOf(ctx);
    const photo = await budget.one('photo', () => ctx.db.get(photoId));
    if (!photo || photo.purgedAt !== undefined) return { url: null };
    return { url: await ctx.storage.getUrl(photo.storageId) };
  },
});

/**
 * An item's map geometry, bounded on bytes — separate from `inbox.item`, since an outline can weigh a
 * megabyte. Gated as `inbox.item` is, plus the body read's capability.
 */
export const itemMap = query({
  args: { ref: v.string(), ...nowArg },
  handler: async (ctx, args): Promise<InboxMapRead> => {
    const viewer = await requireCapability(ctx, 'inbox.read');
    await requireCapability(ctx, 'body.read');
    if (args.ref.startsWith('ticket:')) requireSupportRead(viewer);
    const pending = await inboxPending(ctx);
    const found = await itemOfRef(ctx, args.ref);
    if (!found) return { map: null, pending };
    if (found.lane === 'support') requireSupportRead(viewer);
    const r = new InboxReader(
      ctx,
      budgetOf(ctx),
      clockOf(args.now),
      viewer._id,
      hasCapability(viewer, 'content.read'),
    );
    return { map: await itemMapOf(r, found), pending };
  },
});

/** The day so far (2.9): items filed and decided since the console's local midnight, 500 each. */
export const today = query({
  args: { ...nowArg, ...dayStartArg },
  handler: async (ctx, args): Promise<InboxTodayView> => {
    const viewer = await requireCapability(ctx, 'inbox.read');
    const support = hasCapability(viewer, 'inbox.support.read');
    const now = clockOf(args.now);
    const since = heldDayStart(args.dayStart, now);
    const seen = (lane: InboxLane) => support || lane !== 'support';
    // Every range below is charged at its worst and sized to the request's budget (`itemsUpTo`): a
    // range the budget cut short is said as capped, as one past its cap is.
    const budget = budgetOf(ctx);
    const { rows: decidedRows, short: decidedShort } = await itemsUpTo(budget, TODAY_CAP + 1, (n) =>
      ctx.db
        .query('inboxItems')
        .withIndex('by_status_decided', (q) => q.eq('status', 'decided').gte('decidedAt', since))
        .take(n),
    );
    const decidedCapped = decidedRows.length > TODAY_CAP || decidedShort;
    const decided = decidedRows
      .slice(0, TODAY_CAP)
      .filter((i) => seen(i.lane))
      .map((i) => ({
        at: i.decidedAt ?? i.lastActivityAt,
        filedAt: i.filedAt,
        lane: i.lane,
        decision: i.decision ?? 'resolved',
      }))
      .sort((a, b) => a.at - b.at);
    // Open items filed today: each lane's range from today's first instant (the rank is the filing,
    // but for Access's), then the decided ones filed today.
    const filed: InboxTodayView['filed'] = [];
    let filedCapped = decidedCapped;
    for (const lane of INBOX_LANES) {
      if (!seen(lane)) continue;
      const order = INBOX_LANE_ORDER[lane];
      let rows: Doc<'inboxItems'>[];
      if (lane === 'accessReports') {
        // Access ranks by corroboration, so its range isn't by filing: its first 200 by rank are
        // read and filtered, and past them the day's filings can't be told whole — said as capped.
        const { rows: ranked, short } = await itemsUpTo(budget, MEDIAN_CAP + 1, (n) =>
          ctx.db
            .query('inboxItems')
            .withIndex('by_status_lane_rank', (q) => q.eq('status', 'open').eq('laneOrder', order))
            .take(n),
        );
        filedCapped ||= ranked.length > MEDIAN_CAP || short;
        rows = ranked.slice(0, MEDIAN_CAP).filter((i) => i.filedAt >= since);
      } else {
        const read = await itemsUpTo(budget, TODAY_CAP + 1, (n) =>
          ctx.db
            .query('inboxItems')
            .withIndex('by_status_lane_rank', (q) =>
              q.eq('status', 'open').eq('laneOrder', order).gte('rankKey', since),
            )
            .take(n),
        );
        rows = read.rows;
        filedCapped ||= rows.length > TODAY_CAP || read.short;
      }
      for (const i of rows) filed.push({ at: i.filedAt, lane: i.lane });
    }
    for (const d of decided) if (d.filedAt >= since) filed.push({ at: d.filedAt, lane: d.lane });
    filed.sort((a, b) => a.at - b.at);
    if (filed.length > TODAY_CAP) {
      filed.length = TODAY_CAP;
      filedCapped = true;
    }
    const figures = await readInboxLanes(ctx, { support, dayStart: null });
    const openFiledToday = filed.length - decided.filter((d) => d.filedAt >= since).length;
    const openAtStart =
      filedCapped || decidedCapped
        ? null
        : figures.allOpen - openFiledToday + decided.filter((d) => d.filedAt < since).length;
    return {
      since,
      filed,
      filedCapped,
      decided,
      decidedCapped,
      openAtStart,
      pending: await inboxPending(ctx),
    };
  },
});

/** The body's reports within ±`days` of a flagged report's skate end (2.1's line and drawer). */
export const aroundIt = query({
  args: { reportId: v.string(), days: v.optional(v.number()), ...nowArg },
  handler: async (ctx, args): Promise<AroundItView | null> => {
    const viewer = await requireCapability(ctx, 'content.read');
    const id = ctx.db.normalizeId('reports', args.reportId);
    if (!id) return null;
    const now = clockOf(args.now);
    const budget = budgetOf(ctx);
    const r = new InboxReader(ctx, budget, now, viewer._id, hasCapability(viewer, 'content.read'));
    const flagged = await r.get<'reports'>('report', id);
    if (!flagged) return null;
    const days = AROUND_IT_DAYS.includes(args.days as never)
      ? (args.days as number)
      : AROUND_IT_DEFAULT_DAYS;
    const end = flagged.skateEndTime;
    const from = end - days * DAY_MS;
    const to = end + days * DAY_MS;
    // Each side read lazily, a report at a time: the next row is pulled only while a whole report
    // still fits the budget, and every row pulled is charged its real weight and counted toward the
    // scan's bound — a skipped one too (one `paginate` is all a query gets). `capped` says the read
    // stopped before the window's end was seen: by the list's bound, the scan's, or the budget.
    const side = async (dir: 'before' | 'after') => {
      const rows: Doc<'reports'>[] = [];
      let capped = false;
      let scanned = 0;
      const q = ctx.db
        .query('reports')
        .withIndex('by_water_body_skate_end_time', (q) =>
          dir === 'before'
            ? q
                .eq('waterBodyId', flagged.waterBodyId)
                .gte('skateEndTime', from)
                .lte('skateEndTime', end)
            : q
                .eq('waterBodyId', flagged.waterBodyId)
                .gt('skateEndTime', end)
                .lte('skateEndTime', to),
        )
        .order(dir === 'before' ? 'desc' : 'asc');
      const reports = q[Symbol.asyncIterator]();
      for (;;) {
        if (!budget.affordsRead('report')) {
          capped = true;
          break;
        }
        const next = await reports.next();
        if (next.done) break;
        const rep = next.value;
        budget.reserveCalls(0, 1);
        budget.spend(getDocumentSize(rep));
        // The one past the scan's bound is read only to learn there is more: charged, then capped.
        if (scanned >= AROUND_SCAN) {
          capped = true;
          break;
        }
        scanned++;
        // An author's deletion is honored (D248): a report they took back is no context.
        if (rep._id === flagged._id || rep.authorDeletedAt !== undefined) continue;
        if (rows.length >= AROUND_ROWS) {
          capped = true;
          break;
        }
        rows.push(rep);
      }
      return { rows, capped };
    };
    const before = await side('before');
    const after = await side('after');
    const others = [...before.rows, ...after.rows];
    const view = async (rep: Doc<'reports'>): Promise<AroundReportView> => ({
      reportId: rep._id,
      skateStartTime: rep.skateStartTime ?? null,
      skateEndTime: rep.skateEndTime,
      observedFrom: rep.observedFrom ?? null,
      author: personRef(await r.get<'profiles'>('profile', rep.authorId)),
      authorReports: null,
      notes: rep.notes ?? null,
      claims: claimsOf(rep),
      distanceMeters: metersBetween(rep.point, flagged.point),
      placeName: rep.subAreaName ?? placeOf(rep),
      moderationStatus: rep.moderationStatus,
    });
    const reports: AroundReportView[] = [];
    for (const rep of others.sort((a, b) => a.skateEndTime - b.skateEndTime))
      reports.push(await view(rep));
    return {
      flagged: await view(flagged),
      reports,
      window: { from, to, days },
      cappedBefore: before.capped,
      cappedAfter: after.capped,
      // A moderator's takedown says the claims aren't to be relied on: a hidden or removed report is
      // listed for staff, marked, but no phrase quotes it as corroborating context.
      phrases: aroundItPhrases(
        flagged,
        others.filter((rep) => rep.moderationStatus === 'visible'),
      ),
    };
  },
});

/** That night, at the body (2.1): the low, the freezing run, the degree-days, the Stefan estimate. */
export const claimWeather = query({
  args: { reportId: v.string(), ...nowArg },
  handler: async (ctx, args): Promise<ClaimWeatherView | null> => {
    await requireCapability(ctx, 'content.read');
    const id = ctx.db.normalizeId('reports', args.reportId);
    if (!id) return null;
    const report = await ctx.db.get(id);
    if (!report) return null;
    const body = await ctx.db.get(report.waterBodyId);
    if (!body || body.removedAt !== undefined || !body.centroid) return null;
    const now = clockOf(args.now);
    const w = await stefanWindowFor(ctx, body, report.skateEndTime, now);
    const day = w.localDayMs;
    const todayLocal = localDayMsAt(now, w.utcOffsetSeconds);
    // That night and the nights before it, newest first: a run of freezing nights ends at a warm one
    // or at a night not recorded.
    const nights = await ctx.db
      .query('weatherDays')
      .withIndex('by_cell_day', (q) =>
        q
          .eq('cellKey', w.cellKey)
          .gte('dayMs', day - CALIBRATION_WINDOW_DAYS * DAY_MS)
          .lte('dayMs', day),
      )
      .order('desc')
      .take(CALIBRATION_WINDOW_DAYS + 1);
    const byDay = new Map(nights.map((n) => [n.dayMs, n]));
    const tonight = byDay.get(day);
    let run = 0;
    let gapAfter = false;
    for (let d = day; d >= day - CALIBRATION_WINDOW_DAYS * DAY_MS; d -= DAY_MS) {
      const low = byDay.get(d)?.nightMinTempC;
      if (low === undefined) {
        gapAfter = true;
        break;
      }
      if (low >= 0) break;
      run++;
    }
    // Freezing degree-days since 1 October of the skate's season (D249), complete days only.
    const dayDate = new Date(day);
    const year =
      dayDate.getUTCMonth() >= 6 ? dayDate.getUTCFullYear() : dayDate.getUTCFullYear() - 1;
    const since = Date.UTC(year, 9, 1);
    const season = await ctx.db
      .query('weatherDays')
      .withIndex('by_cell_day', (q) =>
        q.eq('cellKey', w.cellKey).gte('dayMs', since).lte('dayMs', day),
      )
      .take(SEASON_DAYS);
    let fdh = 0;
    let seasonDays = 0;
    for (const row of season) {
      if (row.missing === true || !isCompleteDay(row.hours, row.dayMs, todayLocal)) continue;
      fdh += row.freezingDegreeHours ?? 0;
      seasonDays++;
    }
    const stefan: StefanEstimateView =
      w.days === 0
        ? { declined: 'no_weather' }
        : w.declined || w.estimate === null
          ? { declined: 'thaw' }
          : w.estimate.thicknessIn === null
            ? { declined: 'too_little_cold' }
            : {
                thicknessIn: w.estimate.thicknessIn,
                freezingDegreeDays: w.estimate.freezingDegreeDays,
                alpha: w.estimate.alpha,
                windowDays: CALIBRATION_WINDOW_DAYS,
              };
    return {
      dayMs: day,
      lowC: tonight?.nightMinTempC ?? null,
      freezingNights: { run, gapAfter },
      freezingDegreeDaysC: { value: fdh / 24, since, days: seasonDays },
      stefan,
    };
  },
});

/** The days from 1 October a season's degree-days read at most (October to May). */
const SEASON_DAYS = 250;

/** Refuses a support read to a viewer without `inbox.support.read`, in the page's words. */
function requireSupportRead(viewer: Doc<'profiles'>): void {
  if (!hasCapability(viewer, 'inbox.support.read')) throw new ConvexError(SUPPORT_REFUSAL);
}
