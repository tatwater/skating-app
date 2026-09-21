/**
 * Pure logic for the cross-water-body **newsfeed** (Phase 05, D28) — the point-derived location label
 * and the feed-card view-model, framework-free so web + mobile render identically (D7/D40).
 *
 * The feed is global (all lakes, all regions) for now; Phase 04 later layers an additive drive-time /
 * favorites narrow onto the same query without touching this shaping. The card composes the existing
 * `reportView.ts` helpers (humanized ice/surface vocab, quality label, skate-window duration) so a
 * single source drives both surfaces.
 */

import type { SilhouetteData } from './bodySilhouette';
import {
  formatSkateWindow,
  humanizeEnum,
  OBSERVED_FROM_LABELS,
  SIGHTING_LABELS,
  SKATE_QUALITY_LABELS,
  SUITABILITY_LABELS,
} from './reportView';
import type { TrustClass } from './reputationConfig';
import type {
  IceType,
  ObservedFrom,
  Sighting,
  SkateQuality,
  Suitability,
  SurfaceTag,
} from './types';

/**
 * A feed/report author's public attribution + cosmetic trust (D50). `trustClass` drives the `TrustAvatar`
 * ring color (never a raw number); `profileImageUrl` is the Clerk avatar (initials fallback when absent).
 * Both are optional so a legacy card / offline-cached row without them still renders (no ring, no image).
 */
export interface FeedAuthor {
  displayName: string;
  username: string;
  profileImageUrl?: string;
  trustClass?: TrustClass | null;
  /**
   * A deletion tombstone (D33/D62). Present so a client renders the name **without a link**: the
   * `username` on a tombstone is a synthetic sentinel, and routing to `/u/<sentinel>` would be a dead
   * end dressed up as a profile. Absent on every live author, so a card that ignores it still works.
   */
  deleted?: true;
}

/** The point-derived admin place (from `reports.place`), stamped at create via `adminAreas` (Phase 05). */
export interface PlaceLabelParts {
  town?: string;
  county?: string;
  state?: string;
}

/**
 * The card's location string, town-first (`"Stowe, VT"`), county as the fallback
 * (`"Chittenden County, VT"`), then bare state (`"VT"`). Returns `null` when nothing resolved
 * (ocean / no-match), so the card omits the location segment entirely. The county name already
 * carries its `County` suffix (data model), so this only joins the place name to the state.
 */
export function formatPlaceLabel(place: PlaceLabelParts | undefined): string | null {
  if (!place) return null;
  const name = place.town?.trim() || place.county?.trim() || '';
  const state = place.state?.trim() || '';
  if (name && state) return `${name}, ${state}`;
  if (name) return name;
  if (state) return state;
  return null;
}

/** The pieces of a report's / hazard's location line, coarsest last. */
export interface LocationLineParts {
  /** The named sub-area stamped at create (A02 / D60) — "Malletts Bay". Absent on most bodies. */
  subAreaName?: string;
  /**
   * Every bay the report is a member of, primary first (A09 / D175) — present only on a skate that
   * crossed more than one. When present it replaces `subAreaName` in the line: *"Malletts Bay &
   * Shelburne Bay · Lake Champlain"*, because a skater who was in both was in both.
   */
  subAreaNames?: readonly string[];
  /** The parent water body — always present on a report or hazard. */
  bodyName: string;
  /** The point-derived admin place (`reports.place`), stamped at create via `adminAreas` (Phase 05). */
  place?: PlaceLabelParts;
}

/** Separator between location segments. Middot, not a comma — the town segment already has one. */
const LOCATION_SEPARATOR = ' · ';

/**
 * The location segments, finest name first: `["Malletts Bay", "Lake Champlain", "Colchester, VT"]`.
 *
 * **This is the one place the line is composed, and it has to be** (A02). Before this, the sub-area
 * would have been the third thing a card assembled by hand: `formatPlaceLabel` returned only the
 * `"Colchester, VT"` segment, and `bodyName` was a separate field each surface rendered beside it in
 * its own JSX. Adding a name to the front of that would have meant editing the feed card, report
 * detail, hazard lines and both mobile equivalents in parallel and hoping they stayed in agreement —
 * and "the label disagrees with itself depending on which screen you're on" is the kind of bug nobody
 * files and everybody notices.
 *
 * Absent segments are dropped rather than left as an empty gap, so a body with no sub-area and an
 * unresolved place reads as just its own name.
 */
function locationSegments(parts: LocationLineParts): string[] {
  return [
    formatSubAreaNames(parts),
    parts.bodyName.trim() || null,
    formatPlaceLabel(parts.place),
  ].filter((segment): segment is string => !!segment);
}

/** Joins the member bays of a two-bay skate; a comma list would read as a place-name with a county. */
const SUB_AREA_LIST_SEPARATOR = ' & ';

/** The bay segment: the list form when there is one, else the single stamped name, else nothing. */
function formatSubAreaNames(parts: LocationLineParts): string | null {
  const names = (parts.subAreaNames ?? [])
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (names.length > 0) return names.join(SUB_AREA_LIST_SEPARATOR);
  return parts.subAreaName?.trim() || null;
}

/** The whole line on one row — report detail's subtitle, the hazard reporter line, a search result. */
export function formatLocationLine(parts: LocationLineParts): string {
  return locationSegments(parts).join(LOCATION_SEPARATOR);
}

/**
 * The same segments split for a two-row card: the finest name as the heading, everything coarser
 * beneath it. Feed cards have always rendered a bold body name over a muted place line, and a bay is
 * the name a skater actually uses — so on Malletts Bay the heading becomes "Malletts Bay" and the
 * lake drops into the sub-line beside the town.
 *
 * It shares `locationSegments` with {@link formatLocationLine} rather than re-deriving, which is the
 * point: the two surfaces can differ in *layout* without being able to differ in what the label says
 * or what order it says it in.
 */
export function splitLocationLine(parts: LocationLineParts): {
  primary: string;
  secondary: string | null;
} {
  const [primary = '', ...rest] = locationSegments(parts);
  return { primary, secondary: rest.length > 0 ? rest.join(LOCATION_SEPARATOR) : null };
}

/** Thresholds for the relative-time label (ms). */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * A compact "when" label relative to `now`, keyed off the skate-*end* time: `just now` · `5m ago` ·
 * `3h ago` · `2d ago`, then an absolute-ish `5w ago`. `now` is injected so the format is
 * deterministic in tests and the UI re-renders it live. A future instant (clock skew) reads `just
 * now` rather than a negative age.
 */
export function formatRelativeTime(ms: number, now: number): string {
  const diff = now - ms;
  if (diff < MINUTE) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  const days = Math.floor(diff / DAY);
  if (days < 7) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
}

/**
 * The raw feed item the server (`reports.listFeed`) returns per report, already enriched with the
 * survivor water-body name, point-derived place, author, blocked flag, and photo thumbnail URLs.
 * `buildFeedCardView` turns this into render-ready strings. `blocked` de-emphasizes the author but
 * never hides the report (D3, safety-first) — a block is not a moderation action.
 */
export interface FeedCardData {
  reportId: string;
  waterBodyId: string;
  bodyName: string;
  /** The report's named sub-area (A02 / D60), stamped at create. Absent on all but a few giants. */
  subAreaName?: string;
  /** Every member bay of a two-bay skate, primary first (A09) — see `LocationLineParts`. */
  subAreaNames?: string[];
  place?: PlaceLabelParts;
  skateEndTime: number;
  skateStartTime?: number;
  iceTypes: IceType[];
  surfaceTags: SurfaceTag[];
  skateQuality?: SkateQuality;
  /** Who the ice is for, in the author's words (A10 / D190) — `dont_go` leads the card when set. */
  suitability?: Suitability;
  /** How the author saw it (A10 / D191). Absent means unstated. */
  observedFrom?: ObservedFrom;
  /** What a shore observer saw (A10 / D189) — the observation a from-shore report may carry. */
  sighting?: Sighting;
  photoThumbUrls: string[];
  author: FeedAuthor;
  blocked: boolean;
  /** Viewer has favorited this body (Phase 04) — drives the feed badge + the per-page boost. */
  isFavorite?: boolean;
  /**
   * The body's easiest known approach (A06d / D87), denormalized onto the row by the access join.
   *
   * **On the feed card because the drive-time filter is the thing it corrects.** A skater filtering
   * to "within 60 minutes" is filtering on *drive* time, and a hike-in lake inside that band is not
   * the trip they think they are being offered. The two are shown separately and never summed — a
   * 55-minute drive plus a 25-minute walk is not an 80-minute drive (D72 amendment).
   */
  accessKind?: string;
  /** The lake as a still image — outline, put-in, skate, the chips' where (A10 §12.3). */
  silhouette?: SilhouetteData;
}

/**
 * The feed item the server (`posts.listFeed`) returns per Post (A10 / D186): the author's title and
 * prose over the member Reports the viewer's filters matched, in the author's order. A legacy Post
 * has one Report and no words, and renders exactly as the report card always did. `omittedCount`
 * is the members the *filters* hid (never moderation — those are not counted), so the header can say
 * so rather than let a two-lake day read as one.
 */
export interface PostCardData {
  postId: string;
  title?: string;
  body?: string;
  /** The D28 sort key — the freshest visible member's end time. */
  latestSkateEndTime: number;
  author: FeedAuthor;
  blocked: boolean;
  /** Any matched member is on a favorited body or bay (Phase 04 / A09) — the per-page boost. */
  isFavorite: boolean;
  /** Never empty: a Post with no matching Report is not in the page. */
  reports: FeedCardData[];
  omittedCount: number;
}

/**
 * The Post header, render-ready (A10 / D186). `hasHeader` is the one decision both surfaces make
 * the same way: a legacy Post — one Report, no words — draws no header at all and is the report
 * card exactly as it always was; anything with a title, prose or a second Report gets the author
 * and the time once, up top, and the Reports as blocks under it. `omittedLabel` names the members
 * the viewer's own filters hid, so a two-lake day never silently reads as one.
 */
export interface PostCardView {
  postId: string;
  hasHeader: boolean;
  title: string | null;
  body: string | null;
  relativeTime: string;
  author: FeedAuthor;
  blocked: boolean;
  isFavorite: boolean;
  reports: FeedCardView[];
  omittedLabel: string | null;
}

export function omittedReportsLabel(count: number): string | null {
  if (count <= 0) return null;
  return count === 1
    ? '1 more lake outside your filters'
    : `${count} more lakes outside your filters`;
}

/**
 * The Posts minus the Reports the recommended strip already shows (D50: a permissive-filter viewer
 * must not see one twice). A member the strip took is removed from its Post; a Post left with no
 * member is dropped. Not counted as omitted — the reader saw it, one card up.
 */
export function withoutRecommended(
  posts: readonly PostCardData[],
  recommendedReportIds: ReadonlySet<string>,
): PostCardData[] {
  const out: PostCardData[] = [];
  for (const post of posts) {
    const reports = post.reports.filter((r) => !recommendedReportIds.has(r.reportId));
    if (reports.length === 0) continue;
    out.push(reports.length === post.reports.length ? post : { ...post, reports });
  }
  return out;
}

/**
 * A cached report card as the one-Report Post it belongs to — for the mobile offline read-cache,
 * which stores `FeedCardData` per Report (the per-body cache reads it back that way too) and hands
 * the feed Posts. Renders as the legacy card: no header, no words.
 */
export function postCardForCachedReport(report: FeedCardData): PostCardData {
  return {
    postId: `cached:${report.reportId}`,
    latestSkateEndTime: report.skateEndTime,
    author: report.author,
    blocked: report.blocked,
    isFavorite: report.isFavorite ?? false,
    reports: [report],
    omittedCount: 0,
  };
}

export function buildPostCardView(data: PostCardData, now: number): PostCardView {
  const reports = data.reports.map((r) => buildFeedCardView(r, now));
  const title = data.title ?? null;
  const body = data.body ?? null;
  return {
    postId: data.postId,
    hasHeader: title !== null || body !== null || reports.length > 1 || data.omittedCount > 0,
    title,
    body,
    relativeTime: formatRelativeTime(data.latestSkateEndTime, now),
    author: data.author,
    blocked: data.blocked,
    isFavorite: data.isFavorite,
    reports,
    omittedLabel: omittedReportsLabel(data.omittedCount),
  };
}

/** Render-ready feed card. `relativeTime` depends on `now`, so it's computed per render, not stored. */
export interface FeedCardView {
  reportId: string;
  waterBodyId: string;
  bodyName: string;
  placeLabel: string | null;
  /**
   * The card's two rows, composed (A02): `primary` is the finest name — the bay when there is one,
   * otherwise the lake — and `secondary` is everything coarser. Cards render **these**, never
   * `bodyName` + `placeLabel` by hand; see {@link splitLocationLine}.
   */
  locationPrimary: string;
  locationSecondary: string | null;
  skateEndTime: number;
  relativeTime: string;
  durationLabel: string | null;
  qualityLabel: string | null;
  /**
   * The A10 axes (§12.1). `suitabilityLabel` leads the chip row when set — "Don't go" before
   * "Great" (D3: the who-claim outranks the how-good). `vantageLabel` is set only off the ice: the
   * default vantage says nothing a reader needs, while "From shore" and "Secondhand" change how a
   * thickness reads. `sightingLabel` is the shore observer's one observation.
   */
  suitabilityLabel: string | null;
  vantageLabel: string | null;
  sightingLabel: string | null;
  /** `true` when the author said don't go — the card leads with it, in the warning treatment. */
  isDontGo: boolean;
  /** Humanized ice + surface vocabulary, ready as chip text (UI truncates if it wants). */
  chips: string[];
  photoThumbUrls: string[];
  author: FeedAuthor;
  blocked: boolean;
  /** Viewer has favorited this body (Phase 04) — the card shows a heart/badge and boosts it. */
  isFavorite: boolean;
  /** `true` ⇒ render the Hike-In chip (D87). Only the hike-in case; the others are unremarkable. */
  isHikeIn: boolean;
}

/**
 * Recency section a report falls in, keyed off its skate-*end* time relative to `now` (Phase 04,
 * decision #5). Drives the feed's "Older than …" scroll-divider headers: a stable `key` for React
 * lists + a human `label`. Buckets widen with age (day → week → month) so a scrolling feed reads
 * "Today / Yesterday / Earlier this week / …". A future instant (clock skew) buckets as `today`.
 */
export interface FeedSectionMeta {
  key: 'today' | 'yesterday' | 'this-week' | 'this-month' | 'older';
  label: string;
}

/** The recency bucket for a single skate-end time relative to `now`. Pure (see `formatRelativeTime`). */
export function feedSectionForTime(skateEndTime: number, now: number): FeedSectionMeta {
  const diff = now - skateEndTime;
  if (diff < DAY) return { key: 'today', label: 'Today' };
  if (diff < 2 * DAY) return { key: 'yesterday', label: 'Yesterday' };
  if (diff < 7 * DAY) return { key: 'this-week', label: 'Earlier this week' };
  if (diff < 30 * DAY) return { key: 'this-month', label: 'Earlier this month' };
  return { key: 'older', label: 'Older than a month' };
}

/** One recency section: its header meta + the cards that fall in it, order preserved. */
export interface FeedSection<T> {
  key: FeedSectionMeta['key'];
  label: string;
  items: T[];
}

/**
 * Partition an already newest-first feed list into contiguous recency sections (Phase 04, decision #5).
 * Each item keeps its position; a new section starts whenever the bucket changes, so an out-of-order
 * list can't produce a duplicate header for the same key. `getTime` extracts the skate-end time so this
 * works over raw `FeedCardData` or a built `FeedCardView` alike. Empty in → empty out.
 */
export function groupFeedSections<T>(
  items: readonly T[],
  getTime: (item: T) => number,
  now: number,
): FeedSection<T>[] {
  const sections: FeedSection<T>[] = [];
  for (const item of items) {
    const meta = feedSectionForTime(getTime(item), now);
    const last = sections[sections.length - 1];
    if (last && last.key === meta.key) last.items.push(item);
    else sections.push({ key: meta.key, label: meta.label, items: [item] });
  }
  return sections;
}

/**
 * Compose the render-ready feed card from a server item + the current time. Pure: no I/O, no
 * date-now — `now` is injected so the relative label is deterministic and stays live on the client.
 */
export function buildFeedCardView(data: FeedCardData, now: number): FeedCardView {
  const chips = [...data.iceTypes.map(humanizeEnum), ...data.surfaceTags.map(humanizeEnum)];
  const location = splitLocationLine({
    ...(data.subAreaName !== undefined ? { subAreaName: data.subAreaName } : {}),
    ...(data.subAreaNames !== undefined ? { subAreaNames: data.subAreaNames } : {}),
    bodyName: data.bodyName,
    ...(data.place !== undefined ? { place: data.place } : {}),
  });
  return {
    reportId: data.reportId,
    waterBodyId: data.waterBodyId,
    bodyName: data.bodyName,
    placeLabel: formatPlaceLabel(data.place),
    locationPrimary: location.primary,
    locationSecondary: location.secondary,
    skateEndTime: data.skateEndTime,
    relativeTime: formatRelativeTime(data.skateEndTime, now),
    durationLabel: formatSkateWindow(data.skateEndTime, data.skateStartTime),
    qualityLabel: data.skateQuality ? SKATE_QUALITY_LABELS[data.skateQuality] : null,
    suitabilityLabel: data.suitability ? SUITABILITY_LABELS[data.suitability] : null,
    vantageLabel:
      data.observedFrom && data.observedFrom !== 'on_ice'
        ? OBSERVED_FROM_LABELS[data.observedFrom]
        : null,
    sightingLabel: data.sighting ? SIGHTING_LABELS[data.sighting] : null,
    isDontGo: data.suitability === 'dont_go',
    chips,
    photoThumbUrls: data.photoThumbUrls,
    author: data.author,
    blocked: data.blocked,
    isFavorite: data.isFavorite ?? false,
    isHikeIn: data.accessKind === 'hike_in',
  };
}
