/**
 * Corpus standing (A07b) — **is this lake one we push at people, or one we merely know about?**
 *
 * ## Why a third tier exists
 *
 * The corpus holds ~25,000 bodies and the founder's target is a few hundred that are *actually
 * accessible and actually skated*. D48 already split "store every lake" from "control what displays",
 * and D49 turned display into a zoom ladder — but the ladder's floor (`MIN_VISIBLE_ZOOM_FLOOR`, z14)
 * is a *discoverability guarantee*: every listed body draws by z14, competes for the viewport read
 * budget, registers a weather cell, fans out drive-time notifications, and gets enriched by every ETL
 * pass. That is the right treatment for a lake somebody skates and the wrong one for the 24,000 that
 * nobody has ever touched.
 *
 * So a body has a **standing**:
 *
 * - **`active`** — the map, search, notifications, weather discovery, the recommended strip, bounty
 *   fan-out, the cell registry, enrichment: everything. The lake people are told about.
 * - **`dormant`** — still in the corpus and still *reachable*: it draws only when you zoom right in on
 *   it (`DORMANT_MIN_VISIBLE_ZOOM`), dimmed, and the drawer says why and offers a way to ask for it
 *   back. Search finds it, badged. Nothing *pushes* it. It is still coordinate-resolvable, which is
 *   the load-bearing property: a skate recorded over a dormant pond is exactly the evidence that
 *   brings it back, and hazards, on-ice alerts and track matching all resolve by coordinate.
 * - **`removed`** — D48's soft-delist, now drawn at the same quiet rung as `dormant` rather than
 *   vanishing (founder call, 2026-09-16: *"removed bodies should only be map-discoverable, not from
 *   search"*). A landowner's pond stays *findable by someone standing on it* — so that the landowner
 *   skating their own water attaches to the right row rather than minting a fresh public one — and
 *   unfindable by anyone browsing.
 * - **`unlisted`** — rejected or merged. No cell rows, no reads. Reads follow a merge to its survivor.
 *
 * **Standing is derived, never stored as a whole.** Three of the four tiers already had a field
 * (`reviewStatus` / `dedupStatus`, `removedAt`, `publicAccess.verdict`); this phase adds one more,
 * `dormant`, for the reasons no existing field expresses. One function here reads all of them in one
 * precedence order, so no two fields can disagree about what a body is — the A06f lesson, where a
 * *derived* demotion had to be re-derived at six scoring sites and every omission un-demoted a lake.
 *
 * ## The retention rule
 *
 * A body stays active while someone has been on it recently — `INACTIVE_SEASONS` — or while a person
 * has said it matters (a curated boost, a favourite). It becomes active again the moment there is
 * evidence: a report, a matched track, a put-in placed on it, a moderator confirming public access.
 * A put-in alone does not *keep* a body active (founder call): it is evidence of access, not of use,
 * so it qualifies a lake for the seed and re-activates a dormant one, and then the clock runs.
 *
 * What never flips automatically: a `none` access ruling and a removal. A resident skating a private
 * lake is not evidence the public may; their report attaches, the ruling stands.
 */

import type { PublicAccessVerdict } from './publicAccess';
import { type Season, seasonStartMs } from './season';

// ── Vocabulary ─────────────────────────────────────────────────────────────────────────────────

/** The four tiers, in the order `standingOf` resolves them. */
export const STANDINGS = ['unlisted', 'removed', 'dormant', 'active'] as const;
export type Standing = (typeof STANDINGS)[number];

/**
 * Why a body carries a `dormant` field — the reasons **no other field expresses**.
 *
 * `no_public_access` and `removed` are deliberately *not* here: they are read from `publicAccess`
 * and `removedAt`, and storing a second copy is how two fields come to disagree.
 *
 * - `inactive` — the retention rule: nobody has reported, tracked or marked anything here in
 *   `INACTIVE_SEASONS`, and nobody has boosted or favourited it. Written by the season cron and by
 *   the seed. **The only reason the machine writes on its own.**
 * - `not_in_campaign` — the admission rules changed under it: a campaign's master list no longer
 *   contains it (a raised acreage floor, a class the merge now refuses). Written by the prunes, which
 *   demote rather than delete (founder call, 2026-09-16: *"they shouldn't leave our database"*).
 * - `moderator` — a person set it dormant by hand, with a note.
 */
export const DORMANCY_REASONS = ['inactive', 'not_in_campaign', 'moderator'] as const;
export type DormancyReason = (typeof DORMANCY_REASONS)[number];

/** D48's removal reasons, re-stated here so the copy can read them without a Convex import. */
export const REMOVAL_REASONS = [
  'landowner_request',
  'unskateable',
  'junk',
  'duplicate',
  'other',
] as const;
export type RemovalReason = (typeof REMOVAL_REASONS)[number];

/** The stored `dormant` field. */
export interface Dormancy {
  since: number;
  reason: DormancyReason;
  /** The person, when a person decided. Absent for the cron, the prune and the seed. */
  byUserId?: string;
  /** Shown publicly on a `moderator` dormancy — what the moderator wanted the skater to know. */
  note?: string;
}

/** The subset of a `waterBodies` row standing is derived from. */
export interface StandingInput {
  reviewStatus?: 'pending' | 'approved' | 'rejected' | undefined;
  dedupStatus: 'clean' | 'suspected_duplicate' | 'near_certain' | 'merged';
  removedAt?: number | undefined;
  removalReason?: RemovalReason | undefined;
  publicAccess?: { verdict: PublicAccessVerdict; decidedAt: number } | undefined;
  dormant?: Dormancy | undefined;
}

/** Every reason a body can be anything but active — the union the drawer explains. */
export type StandingReason = DormancyReason | 'no_public_access' | RemovalReason;

export type BodyStanding =
  | { standing: 'active' }
  | { standing: 'unlisted' }
  | { standing: 'removed'; since: number; reason: RemovalReason }
  | {
      standing: 'dormant';
      since: number;
      reason: DormancyReason | 'no_public_access';
      note?: string;
    };

// ── The derivation ─────────────────────────────────────────────────────────────────────────────

/**
 * What a body is — **one precedence order, read from every field that bears on it.**
 *
 * `unlisted` first because a merged row has no standing of its own (reads follow the survivor).
 * `removed` before `dormant` because a removal is a human act with a reason and outranks anything
 * derived. Within `dormant`, a `none` access ruling outranks the stored reason: "there is no lawful
 * way in" is the stronger statement and the one a skater most needs first.
 */
export function standingOf(body: StandingInput): BodyStanding {
  if (body.reviewStatus === 'rejected' || body.dedupStatus === 'merged') {
    return { standing: 'unlisted' };
  }
  if (body.removedAt !== undefined) {
    return { standing: 'removed', since: body.removedAt, reason: body.removalReason ?? 'other' };
  }
  if (body.publicAccess?.verdict === 'none') {
    return {
      standing: 'dormant',
      since: body.publicAccess.decidedAt,
      reason: 'no_public_access',
    };
  }
  if (body.dormant !== undefined) {
    return {
      standing: 'dormant',
      since: body.dormant.since,
      reason: body.dormant.reason,
      ...(body.dormant.note !== undefined ? { note: body.dormant.note } : {}),
    };
  }
  return { standing: 'active' };
}

/** The one predicate every *push* surface gates on. */
export function isActive(body: StandingInput): boolean {
  return standingOf(body).standing === 'active';
}

/** A row shape a client's map builder may hold — every standing field optional. */
export type PartialStandingInput = Omit<StandingInput, 'dedupStatus'> & {
  dedupStatus?: StandingInput['dedupStatus'] | undefined;
};

/**
 * `isActive` for a partial row, as the clients' map feature builders hold one: an absent
 * `dedupStatus` reads as `clean`, because a body that reached a map read is listed by construction.
 */
export function isActiveRow(body: PartialStandingInput): boolean {
  return isActive({ ...body, dedupStatus: body.dedupStatus ?? 'clean' });
}

/**
 * Is the body reachable at all — cell-indexed, openable by id, resolvable by coordinate?
 *
 * Everything but `unlisted`. This is what `isListed` in the Convex package now means: a removed body
 * is *listed* (it has cell rows at the dormant rung) and not *active*.
 */
export function isReachable(body: StandingInput): boolean {
  return standingOf(body).standing !== 'unlisted';
}

/**
 * Can evidence of use — a report, a track, a put-in — bring this body back on its own?
 *
 * Only the two machine-written dormancies. A moderator's hand-set dormancy, a `none` ruling and a
 * removal are decisions, and a decision is reversed by a person.
 */
export function reactivatesOnEvidence(body: StandingInput): boolean {
  const s = standingOf(body);
  return s.standing === 'dormant' && (s.reason === 'inactive' || s.reason === 'not_in_campaign');
}

// ── Zoom ───────────────────────────────────────────────────────────────────────────────────────

/**
 * The zoom a non-active body first draws at.
 *
 * **Above the D49 floor, not a demotion within it.** `MIN_VISIBLE_ZOOM_FLOOR` (z14) is the promise
 * that every *active* body is findable by browsing; a dormant body is findable by *looking for it* —
 * you have to be zoomed in on the water itself, at which point the dimmed outline and the drawer's
 * explanation are exactly what you want. z16 is two levels past the floor: a whole small pond fills
 * the phone screen, so nothing else is competing with it.
 *
 * The cell index is unaffected: `indexLevelFor` clamps a body's index level to the ladder's finest
 * rung (z14), and the viewport read's `minVisibleZoom <= zoom` range does the rest. Coordinate
 * lookups scan every rung with no zoom cutoff, so a dormant body is found by a track or a tap
 * regardless.
 *
 * This retires A06f's `NO_PUBLIC_ACCESS_DEMOTION` (−2 zoom levels): a `none` body is dormant, and
 * dormant is a rung, not a subtraction.
 */
export const DORMANT_MIN_VISIBLE_ZOOM = 16;

// ── Retention ──────────────────────────────────────────────────────────────────────────────────

/**
 * How many seasons without evidence of use before an active body goes dormant (founder call,
 * 2026-09-16). Three: a lake can miss a warm winter and a lazy one and still be somewhere people
 * skate. Documented for skaters in `docs/corpus-lifecycle.md`; change it there too.
 */
export const INACTIVE_SEASONS = 3;

/**
 * The instant before which activity no longer counts, at a given season's rollover.
 *
 * At the rollover into season `S`, the last `INACTIVE_SEASONS` *completed* seasons are
 * `S − 3 … S − 1`, so the cutoff is the start of `S − INACTIVE_SEASONS`. Activity at or after it
 * retains the body.
 */
export function inactivityCutoffMs(season: Season): number {
  return seasonStartMs(season - INACTIVE_SEASONS);
}

/** What the retention rule reads about a body. */
export interface RetentionInput {
  /** The most recent report, matched track or hazard on the body; absent ⇒ never. */
  lastActivityAt?: number | undefined;
  /** A positive boost is a person saying "this is a destination" — a standing decision. */
  curatedBoost?: number | undefined;
  /** Anyone at all has favourited it. *"If you favourited it, you know something we don't."* */
  favorited: boolean;
}

/**
 * Does this active body stay active at the rollover into `season`?
 *
 * Use within the window, or a standing human decision. Deliberately **not** `includedByRequest`
 * (admission is not retention — a requested pond nobody then skates is still an unskated pond) and
 * **not** a put-in (access is not use).
 */
export function retainsActive(input: RetentionInput, season: Season): boolean {
  if ((input.curatedBoost ?? 0) > 0) return true;
  if (input.favorited) return true;
  return input.lastActivityAt !== undefined && input.lastActivityAt >= inactivityCutoffMs(season);
}

// ── Copy ───────────────────────────────────────────────────────────────────────────────────────

/** The badge a search result or card wears when the body is not active. */
export const INACTIVE_BADGE = 'Inactive';

/**
 * The drawer's one-line explanation of why a body is not on the active map, or `null` when it is.
 *
 * Plain and specific, because the whole point of keeping a dormant body reachable is that a skater
 * who finds it learns *why* and can say we are wrong. A removal names its reason, including a
 * landowner request (founder call, 2026-09-16 — *"we can re-address this if someone complains"*).
 * A `none` ruling defers to `describePublicAccess`, which already carries the date and the note.
 */
export function describeStanding(s: BodyStanding): string | null {
  switch (s.standing) {
    case 'active':
      return null;
    case 'unlisted':
      return 'This lake is no longer available.';
    case 'removed':
      return describeRemoval(s.reason);
    case 'dormant':
      switch (s.reason) {
        case 'inactive':
          return `No one has reported skating here in the last ${INACTIVE_SEASONS} seasons, so it isn\u2019t on the active map.`;
        case 'not_in_campaign':
          return 'This water no longer meets the size and type rules for the active map.';
        case 'moderator':
          return s.note
            ? `A moderator set this lake inactive: ${s.note}`
            : 'A moderator set this lake inactive.';
        case 'no_public_access':
          return 'A moderator found no public access, so it isn’t on the active map.';
      }
  }
}

function describeRemoval(reason: RemovalReason): string {
  switch (reason) {
    case 'landowner_request':
      return 'Removed from the map at the landowner’s request.';
    case 'unskateable':
      return 'Removed from the map — not skateable.';
    case 'junk':
      return 'Removed from the map — not a real body of water.';
    case 'duplicate':
      return 'Removed from the map as a duplicate of another lake.';
    case 'other':
      return 'Removed from the map by a moderator.';
  }
}

/** The moderator-facing label for a reason — the admin list's column, not skater copy. */
export function standingReasonLabel(reason: StandingReason): string {
  switch (reason) {
    case 'inactive':
      return 'Inactive';
    case 'not_in_campaign':
      return 'Not in campaign';
    case 'moderator':
      return 'Moderator';
    case 'no_public_access':
      return 'No public access';
    case 'landowner_request':
      return 'Landowner request';
    case 'unskateable':
      return 'Unskateable';
    case 'junk':
      return 'Junk';
    case 'duplicate':
      return 'Duplicate';
    case 'other':
      return 'Other';
  }
}
