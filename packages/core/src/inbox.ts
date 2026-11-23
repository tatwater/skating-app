/**
 * The Inbox's vocabulary (B01-5, *The Inbox (B01-5, the design)* in the B01 phase doc): its lanes and
 * their flow-through order, the kinds of item it lists, the decisions that close one, and each lane's
 * tabs. One home, so the server's stored items (`inboxItems`), the console's list and the Overview's
 * Inbox card name the same lanes the same way.
 *
 * An item is one *question* a person filed — a flag target in a lane, a body's access reports, an ask
 * and its siblings, a drawn body, a ticket — never one source row.
 */

/**
 * The lanes, in the order "All open" reads them (safety first). The names are the Overview's
 * (`InboxLane` in the web app's overview data), so its links land on the lane they name.
 */
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

/**
 * Each lane's place in "All open" — the stored item's `laneOrder`, the second key of the flow-through
 * index. Support is last, so a viewer without support's read takes the range `< INBOX_LANE_ORDER.support`.
 */
export const INBOX_LANE_ORDER: Readonly<Record<InboxLane, number>> = {
  safety: 0,
  accessReports: 1,
  requests: 2,
  placesAsked: 3,
  drawnBodies: 4,
  contentFlags: 5,
  support: 6,
};

/** What an item is a question about. */
export const INBOX_ITEM_KINDS = ['flag', 'access', 'request', 'place', 'drawn', 'ticket'] as const;
export type InboxItemKind = (typeof INBOX_ITEM_KINDS)[number];

/** An item waits (`open`) or has been decided; a withdrawn one is deleted, never decided. */
export const INBOX_ITEM_STATUSES = ['open', 'decided'] as const;
export type InboxItemStatus = (typeof INBOX_ITEM_STATUSES)[number];

/** A member (one source row) is still asking, or its item's decision closed it. */
export const INBOX_MEMBER_STATUSES = ['open', 'closed'] as const;
export type InboxMemberStatus = (typeof INBOX_MEMBER_STATUSES)[number];

/** The tables an item's members come from. */
export const INBOX_SOURCE_TABLES = [
  'contentFlags',
  'waterBodyRequests',
  'waterBodies',
  'supportTickets',
] as const;
export type InboxSourceTable = (typeof INBOX_SOURCE_TABLES)[number];

/**
 * How an item was decided — what the Decided list and the colleague lock say. A flag's takedown says
 * what it did (`hidden`, `removed`; an alert's `pinned` (its flags dismissed), `unpinned`, `retracted`; content put back and the flag
 * dismissed, `restored`); `actioned` is a flag actioned without a takedown — and every flag decided
 * before the Inbox recorded which, since the old flags page closed the flag and moderated the content
 * as two separate writes.
 */
export const INBOX_DECISIONS = [
  'dismissed',
  'actioned',
  'hidden',
  'removed',
  'pinned',
  'unpinned',
  'retracted',
  'restored',
  'ruled_closed',
  'ruled_accessible',
  'approved',
  'declined',
  'merged',
  'rejected',
  'resolved',
] as const;
export type InboxDecision = (typeof INBOX_DECISIONS)[number];

/** Each lane's tabs, `all` first; the filter menu holds the rest (kind, age, body, person). */
export const INBOX_FACETS: Readonly<Record<InboxLane, readonly string[]>> = {
  safety: ['all', 'reports', 'hazards', 'people'],
  accessReports: ['all', 'disputes', 'new'],
  requests: ['all', 'admit', 'activate', 'restore', 'contest_access', 'takedown'],
  placesAsked: ['all', 'bays', 'landmarks'],
  drawnBodies: ['all', 'overlap', 'newWater'],
  contentFlags: ['all', 'reports', 'comments', 'alerts', 'photos', 'people'],
  support: ['all', 'account', 'bug', 'safety', 'other'],
};

/** Rows on a list page. */
export const INBOX_PAGE_SIZE = 50;

/** Whether `facet` is one of `lane`'s tabs — a search's `facet` the lane doesn't have is dropped. */
export function isInboxFacet(lane: InboxLane, facet: string): boolean {
  return INBOX_FACETS[lane].includes(facet);
}

/**
 * What `inbox.listPage` lists: one lane, `all` (every open item in the flow-through order, each row
 * carrying its lane so the list draws the boundary) or `decided` (every lane's decisions, newest
 * first). The names are the console search's `lane` values.
 */
export const INBOX_LIST_LANES = [...INBOX_LANES, 'all', 'decided'] as const;
export type InboxListLane = (typeof INBOX_LIST_LANES)[number];

/** The ages the filter menu offers, in days: an item filed at least this long ago. */
export const INBOX_AGE_FLOORS_DAYS = [1, 3, 7, 30] as const;

/** How far *Around it* reaches either side of the flagged report's skate end, in days. */
export const AROUND_IT_DAYS = [1, 3, 7] as const;
export const AROUND_IT_DEFAULT_DAYS = 3;

/**
 * The phrases *Around it* may say (board 2.1), in the order the line says them. Each quotes the
 * reports' own claims — a measured reading, a sighting, the skater's own label, a surface tag — and
 * never a class the reports didn't choose ("thin", "safe", "solid"; D3, the founder's call of
 * 2026-11-20):
 *
 * - `measured_less` / `measured_more` — a `measured` reading's mean below / above the flagged
 *   report's own measured mean by more than 0.5 cm (only when the flagged report measured);
 * - `open_water` — `sightings` includes `open`; `skim_ice` — `sightings` includes `skim`;
 * - `dont_go` — `suitability === 'dont_go'`;
 * - `wet_or_slushy` — `surfaceTags` includes `wet`, `slushy` or `overflow`.
 */
export const AROUND_IT_PHRASE_KEYS = [
  'measured_less',
  'measured_more',
  'open_water',
  'skim_ice',
  'dont_go',
  'wet_or_slushy',
] as const;
export type AroundItPhraseKey = (typeof AROUND_IT_PHRASE_KEYS)[number];

/** One phrase and how many of the other reports earn it ("2 measured less"). */
export interface AroundItPhrase {
  key: AroundItPhraseKey;
  count: number;
}

/** At most this many phrases on 2.1's line; the drawer lists them all. */
export const AROUND_IT_LINE_PHRASES = 3;

/** A report's claims as `aroundItPhrases` reads them: the stored fields, nothing derived. */
export interface AroundItReport {
  iceThickness?: {
    readings: readonly { valueCm?: number; minCm?: number; maxCm?: number; method: string }[];
  } | null;
  sightings?: readonly { type: string }[] | null;
  suitability?: string | null;
  surfaceTags?: readonly { type: string }[] | null;
}

/** How far a measured mean must differ from the flagged one to count, in cm. */
export const AROUND_IT_MEASURE_MARGIN_CM = 0.5;

const WET_TAGS = new Set(['wet', 'slushy', 'overflow']);

/**
 * The mean of a report's **measured** readings, in cm — a value, or a range's midpoint; an estimate,
 * a poke count and a lower bound never count (the instrument's own rule, `readingsToCm`). `null` when
 * it measured nothing.
 */
export function measuredMeanCm(report: AroundItReport): number | null {
  const cm: number[] = [];
  for (const r of report.iceThickness?.readings ?? []) {
    if (r.method !== 'measured') continue;
    if (typeof r.valueCm === 'number' && r.valueCm > 0) cm.push(r.valueCm);
    else if (typeof r.minCm === 'number' && typeof r.maxCm === 'number') {
      const mid = (r.minCm + r.maxCm) / 2;
      if (mid > 0) cm.push(mid);
    }
  }
  return cm.length === 0 ? null : cm.reduce((a, b) => a + b, 0) / cm.length;
}

/**
 * **The phrases *Around it* says** (board 2.1; the founder's call of 2026-11-20; D3): each counts the
 * other reports whose own stored claims earn it, in {@link AROUND_IT_PHRASE_KEYS}' order, each report
 * counted once per phrase it earns; a phrase no report earns is left out. Nothing here is a class —
 * no "thin", "safe" or "solid": every phrase quotes a field the reports chose.
 */
export function aroundItPhrases(
  flagged: AroundItReport,
  others: readonly AroundItReport[],
): AroundItPhrase[] {
  const mine = measuredMeanCm(flagged);
  const has = (tags: readonly { type: string }[] | null | undefined, keys: Set<string>) =>
    (tags ?? []).some((t) => keys.has(t.type));
  const counts: Record<AroundItPhraseKey, number> = {
    measured_less: 0,
    measured_more: 0,
    open_water: 0,
    skim_ice: 0,
    dont_go: 0,
    wet_or_slushy: 0,
  };
  for (const r of others) {
    const theirs = measuredMeanCm(r);
    if (mine !== null && theirs !== null) {
      if (theirs < mine - AROUND_IT_MEASURE_MARGIN_CM) counts.measured_less++;
      else if (theirs > mine + AROUND_IT_MEASURE_MARGIN_CM) counts.measured_more++;
    }
    if (has(r.sightings, new Set(['open']))) counts.open_water++;
    if (has(r.sightings, new Set(['skim']))) counts.skim_ice++;
    if (r.suitability === 'dont_go') counts.dont_go++;
    if (has(r.surfaceTags, WET_TAGS)) counts.wet_or_slushy++;
  }
  return AROUND_IT_PHRASE_KEYS.filter((key) => counts[key] > 0).map((key) => ({
    key,
    count: counts[key],
  }));
}

/**
 * **The notification types every installed phone build words** (B01-5, the governor's ruling 7): the
 * list as it stood before this wave. `notifications.list` serves a type outside a client's `knows`
 * (absent: this list) as the `unknown` row every build already words, so a build whose core lacks a
 * newer case (`moderator_decision`, PR 3) never throws on it. Frozen: a new type is added to
 * `NOTIFICATION_TYPES`, never here.
 */
export const NOTIFICATION_TYPES_EVERY_BUILD_KNOWS = [
  'activity_detected',
  'bounty_request',
  'hazard_confirmation',
  'bounty_answered',
  'report_rated',
  'report_commented',
  'content_flag_resolved',
  'favorite_report',
  'nearby_report_digest',
  'great_report_nearby',
] as const;

/**
 * A drawing at least this much inside a known body suggests merging it there (board 2.5's *Merge
 * suggested from 80 %* — invented, for the founder's look).
 */
export const MERGE_SUGGEST_SHARE = 0.8;
