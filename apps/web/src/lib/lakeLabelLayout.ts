/**
 * Where a lake's label goes, and which ones draw (Review 3's rule, ported from the mock's
 * `chrome.js` `mapLabel` and `mirrorLabels`).
 *
 * A label is pinned to its water: a dot at the body's interior point, a 45° leader a fixed 16 px up
 * and to the right, and the lockup (slug over name) hanging off the leader's end — so every label
 * sits the same distance from a point on its own water, whatever the body's size or shape. A lockup
 * that would run off the map's right edge mirrors: leader up and left, lockup right-aligned to it.
 *
 * Pure, in map pixels, and free of the map library, so the geometry can be proven: `SkaterMap`
 * projects the anchors and measures the lockups, this says where they go.
 *
 * **What a label may never do is cover a hazard mark** (D3): marks come in as obstacles, and a label
 * that would land on one loses its place. It's only ever the label that gives way.
 */

/** The dot at the anchor. */
export const LABEL_DOT_RADIUS = 2.5;
/** The leader's run, each way: a fixed 45°, 16 px across and 16 px up. */
export const LEADER_RUN = 16;
/** Anchor to the lockup's near edge. */
export const LOCKUP_INSET = 18;
/** Anchor to the lockup's top, with a slug over the name. */
export const LOCKUP_TOP_WITH_SLUG = -53;
/** Anchor to the lockup's top, a name alone. */
export const LOCKUP_TOP_NAME_ONLY = -34;
/** The lockup's foot sits on the leader's end. */
export const LOCKUP_BOTTOM = -LEADER_RUN;
/** How close a lockup may run to the map's right edge before it mirrors. */
export const MAP_EDGE_MARGIN = 12;
/** Air left between two labels, and around an obstacle. */
export const LABEL_GAP = 4;
/** The most labels a map draws: past this a view is a list's job, and each one is a DOM node. */
export const MAX_LAKE_LABELS = 24;

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface MapSize {
  width: number;
  height: number;
}

export interface LockupSize {
  width: number;
  /** Whether a slug rides over the name: it sets how tall the lockup is. */
  hasSlug: boolean;
}

export interface LabelPlacement {
  anchor: Point;
  mirrored: boolean;
  /** The lockup's box, in map px. */
  lockup: Rect;
  /** The leader's far end, in map px: always `LEADER_RUN` from the anchor on each axis. */
  leaderEnd: Point;
  /** Everything the label covers — dot, leader and lockup — for collisions. */
  box: Rect;
}

/**
 * One label's geometry. It mirrors when the lockup would cross the right margin, unless mirroring
 * would run it further off the left than staying runs it off the right (a map narrower than its
 * label, on a phone): the rule is "stay readable", and flipping off the other edge wouldn't be.
 */
export function placeLabel(anchor: Point, size: LockupSize, mapWidth: number): LabelPlacement {
  const limit = mapWidth - MAP_EDGE_MARGIN;
  const rightOverrun = anchor.x + LOCKUP_INSET + size.width - limit;
  const leftOverrun = MAP_EDGE_MARGIN - (anchor.x - LOCKUP_INSET - size.width);
  const mirrored = rightOverrun > 0 && leftOverrun < rightOverrun;

  const left = mirrored ? anchor.x - LOCKUP_INSET - size.width : anchor.x + LOCKUP_INSET;
  const top = anchor.y + (size.hasSlug ? LOCKUP_TOP_WITH_SLUG : LOCKUP_TOP_NAME_ONLY);
  const lockup: Rect = { left, top, right: left + size.width, bottom: anchor.y + LOCKUP_BOTTOM };
  return {
    anchor,
    mirrored,
    lockup,
    leaderEnd: {
      x: anchor.x + (mirrored ? -LEADER_RUN : LEADER_RUN),
      y: anchor.y - LEADER_RUN,
    },
    box: {
      left: Math.min(lockup.left, anchor.x - LABEL_DOT_RADIUS),
      top: lockup.top,
      right: Math.max(lockup.right, anchor.x + LABEL_DOT_RADIUS),
      bottom: anchor.y + LABEL_DOT_RADIUS,
    },
  };
}

export function rectsOverlap(a: Rect, b: Rect, gap = 0): boolean {
  return (
    a.left < b.right + gap &&
    b.left < a.right + gap &&
    a.top < b.bottom + gap &&
    b.top < a.bottom + gap
  );
}

export interface LabelCandidate extends LockupSize {
  id: string;
  anchor: Point;
  /** Higher places first (`labelPriority`). */
  priority: number;
}

/**
 * Which labels draw and where. Greedy in priority order, with the id as the tiebreak so the same
 * set lays out the same way whatever order the query returned it in:
 *
 * - An anchor off the map has no label: its dot would be off the water you can see.
 * - A lockup that would be clipped by the map's top has none either: half a name reads as a bug.
 * - A label that overlaps an obstacle or a label already placed gives way. A dropped label always
 *   has a reason in the placed set, which is the property the tests hold it to.
 */
export function layoutLakeLabels(
  candidates: readonly LabelCandidate[],
  map: MapSize,
  options: { obstacles?: readonly Rect[]; maxLabels?: number } = {},
): Map<string, LabelPlacement> {
  const { obstacles = [], maxLabels = MAX_LAKE_LABELS } = options;
  const ordered = [...candidates].sort(
    (a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const placed = new Map<string, LabelPlacement>();
  for (const candidate of ordered) {
    if (placed.size >= maxLabels) break;
    const { x, y } = candidate.anchor;
    if (x < 0 || x > map.width || y < 0 || y > map.height) continue;
    const placement = placeLabel(candidate.anchor, candidate, map.width);
    if (placement.lockup.top < 0) continue;
    if (obstacles.some((obstacle) => rectsOverlap(placement.box, obstacle, LABEL_GAP))) continue;
    let clear = true;
    for (const other of placed.values()) {
      if (rectsOverlap(placement.box, other.box, LABEL_GAP)) {
        clear = false;
        break;
      }
    }
    if (clear) placed.set(candidate.id, placement);
  }
  return placed;
}

/** What earns a label a place when the map is crowded. */
export interface LabelStanding {
  favorite: boolean;
  openBounties: number;
  /** Reports in the recent window, `0` until they load. */
  recentReports: number;
  inactive: boolean;
  surfaceAreaSqM?: number;
}

/**
 * A label's priority: your lakes, then lakes someone wants a report on, then lakes with news, then
 * size, and an inactive body last. The tiers are far enough apart that area only ever breaks a tie
 * within one (area is log-scaled, and no water body reaches 10¹⁰ m² on a tier of 100).
 */
export function labelPriority(standing: LabelStanding): number {
  const tier =
    (standing.favorite ? 4000 : 0) +
    (standing.openBounties > 0 ? 2000 : 0) +
    (standing.recentReports > 0 ? 1000 : 0) -
    (standing.inactive ? 8000 : 0);
  return tier + Math.log10(Math.max(1, standing.surfaceAreaSqM ?? 1));
}

/** The cap `reports.recentCardsForBodies` reads per body, so a label can say "5+" honestly. */
export const RECENT_CARDS_PER_BODY = 5;

/** A local calendar day, as a comparable string. */
function dayKey(at: number, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  }).format(at);
}

/**
 * The slug over a lake's name: "3 reports · today", "1 report · Tuesday". It says what skaters
 * wrote and when, never what the ice is (D3).
 *
 * `null` while the counts load, so a label doesn't flash a claim it hasn't read. **"No recent
 * reports", not the board's "No reports yet":** the read only looks back 72 hours, so it can't know a
 * lake has never had one, and saying so of a lake with a four-day-old report would be false.
 */
export function labelSlug(input: {
  inactive: boolean;
  /** The body's recent report end times, or `undefined` while they load. */
  skateEndTimes: readonly number[] | undefined;
  now: number;
  timeZone?: string;
}): string | null {
  const { inactive, skateEndTimes, now, timeZone } = input;
  if (inactive) return 'Inactive';
  if (skateEndTimes === undefined) return null;
  if (skateEndTimes.length === 0) return 'No recent reports';
  const count = skateEndTimes.length;
  const noun = count === 1 ? 'report' : 'reports';
  const shown = count >= RECENT_CARDS_PER_BODY ? `${RECENT_CARDS_PER_BODY}+` : String(count);
  const newest = Math.max(...skateEndTimes);
  const when =
    dayKey(newest, timeZone) === dayKey(now, timeZone)
      ? 'today'
      : new Intl.DateTimeFormat('en-US', {
          weekday: 'long',
          ...(timeZone ? { timeZone } : {}),
        }).format(newest);
  return `${shown} ${noun} · ${when}`;
}

/** The lockup's own label for a bounty count: each person's ask is its own bounty row (Review 4). */
export function openBountiesLabel(count: number): string {
  return `${count} open ${count === 1 ? 'bounty' : 'bounties'}`;
}
