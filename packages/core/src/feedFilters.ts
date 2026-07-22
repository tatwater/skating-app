/**
 * Pure feed-filter logic (Phase 4, decision #3) — the single source of truth both clients and the
 * `reports.listFeed` query narrate, so a report is included/excluded identically everywhere (D7/D40).
 * The feed is permissive by default (browse = pull): an empty filter set matches every report; each
 * field only *narrows*.
 *
 * ⚠️ Include-unknown semantics. Quality, thickness, and snow are optional on a report (only ~16% of
 * corpus reports carry a thickness reading). A quality/thickness floor therefore must NOT drop a
 * report that simply *omits* the attribute — otherwise a "≥4 in" filter hides ~84% of the feed. So
 * every attribute filter here treats a missing field as a PASS; only a present-but-below value fails.
 * The one hard filter is **distance**: a radius selection excludes out-of-band lakes outright — except
 * favorites, which are exempt from distance but still obey quality / snow / recency (decision #1).
 *
 * "No snow" keys off `surfaceTags` (`snow_covered` / `drifted`), never the sparse `snowCoverCm`.
 */

import { bandWithinRadius, type DriveTimeBand, isDriveTimeBand } from './driveTime';
import {
  ICE_TYPES,
  type IceType,
  SKATE_QUALITIES,
  type SkateQuality,
  SURFACE_TAGS,
  type SurfaceTag,
} from './types';

/** Surface tags that mark a report as snow-covered — the basis for the "no snow" filter (decision #3). */
export const SNOW_SURFACE_TAGS: readonly SurfaceTag[] = ['snow_covered', 'drifted'];

/** Ascending skate-quality rank so a floor comparison is a simple `>=` (great is best). */
const QUALITY_RANK: Record<SkateQuality, number> = { poor: 0, fair: 1, good: 2, great: 3 };

/** The report fields the filters read. All attribute fields optional — a report may omit any of them. */
export interface FilterableReport {
  skateEndTime: number;
  skateQuality?: SkateQuality;
  iceTypes?: IceType[];
  surfaceTags?: SurfaceTag[];
  iceThickness?: { readings: { valueCm?: number; minCm?: number; maxCm?: number }[] };
}

/**
 * The persisted feed filter row (schema `profiles.feedFilterPrefs`; also the local-storage working
 * copy). Every field optional; all-undefined = show everything. `radiusMinutes` / `qualityFloor` are
 * the two coarse gates, the rest positive-selection narrows.
 */
export interface FeedFilters {
  /** Drive-time radius (off / 30 / 60 / 90). A HARD filter — favorites exempt (see `matchesFilters`). */
  radiusMinutes?: DriveTimeBand;
  /** Minimum overall quality (typically `good` / `great`). Include-unknown. */
  qualityFloor?: SkateQuality;
  /** Minimum ice thickness in cm. Include-unknown (reports without a reading pass). */
  thicknessFloorCm?: number;
  /** Exclude reports tagged snow-covered / drifted. */
  noSnow?: boolean;
  /** Ideal ice types — report must carry at least one (include-unknown: no ice type ⇒ pass). */
  iceTypes?: IceType[];
  /** Ideal surface types — report must carry at least one (include-unknown: no tag ⇒ pass). */
  surfaceTags?: SurfaceTag[];
  /** Only reports whose skate-end is within the last N hours. Applies to favorites too. */
  recencyHours?: number;
}

/** Per-report context the filters need beyond the report itself: its band, favorite flag, and `now`. */
export interface FilterContext {
  /** The report's water-body drive-time band (from `bandForCoord`), or `null` if out of range/no home. */
  band: DriveTimeBand | null;
  /** Whether the viewer has favorited this report's water body (distance-exempt, decision #1). */
  isFavorite: boolean;
  /** Current time (epoch ms), injected so recency is deterministic/testable. */
  now: number;
}

/** Largest numeric thickness a reading asserts (a single value, or the upper end of a range). */
function readingUpperCm(reading: { valueCm?: number; maxCm?: number }): number | undefined {
  const candidate = reading.valueCm ?? reading.maxCm;
  return candidate !== undefined && Number.isFinite(candidate) ? candidate : undefined;
}

/** Does at least one array element appear in `wanted`? (Positive-selection intersection.) */
function intersects<T>(values: readonly T[], wanted: readonly T[]): boolean {
  return values.some((v) => wanted.includes(v));
}

/**
 * Does `report` survive `filters` for this viewer? The include-unknown rule above governs every
 * attribute gate; distance is the lone hard filter and favorites bypass it. An empty `filters`
 * returns `true` for every report (the permissive default).
 */
export function matchesFilters(
  report: FilterableReport,
  filters: FeedFilters,
  ctx: FilterContext,
): boolean {
  // Distance — HARD. Out-of-band lakes are dropped, unless this body is a favorite (decision #1).
  if (filters.radiusMinutes !== undefined && !ctx.isFavorite) {
    if (!bandWithinRadius(ctx.band, filters.radiusMinutes)) return false;
  }

  // Recency — applies to everyone, favorites included.
  if (filters.recencyHours !== undefined) {
    const cutoff = ctx.now - filters.recencyHours * 60 * 60 * 1000;
    if (report.skateEndTime < cutoff) return false;
  }

  // Quality floor — include-unknown (a report without a quality passes).
  if (filters.qualityFloor !== undefined && report.skateQuality !== undefined) {
    if (QUALITY_RANK[report.skateQuality] < QUALITY_RANK[filters.qualityFloor]) return false;
  }

  // Thickness floor — include-unknown. A report with readings must have one reaching the floor;
  // a report with no numeric reading passes (the field is simply unknown, not below).
  if (filters.thicknessFloorCm !== undefined) {
    const uppers = (report.iceThickness?.readings ?? [])
      .map(readingUpperCm)
      .filter((cm): cm is number => cm !== undefined);
    if (uppers.length > 0 && Math.max(...uppers) < filters.thicknessFloorCm) return false;
  }

  // No snow — exclude only reports that explicitly tag snow (include-unknown: no tags ⇒ pass).
  if (filters.noSnow && intersects(report.surfaceTags ?? [], SNOW_SURFACE_TAGS)) return false;

  // Ideal ice types — include-unknown: a report carrying no ice type passes; one carrying types must
  // intersect the wanted set.
  if (filters.iceTypes && filters.iceTypes.length > 0) {
    const reported = report.iceTypes ?? [];
    if (reported.length > 0 && !intersects(reported, filters.iceTypes)) return false;
  }

  // Ideal surface types — same include-unknown intersection rule.
  if (filters.surfaceTags && filters.surfaceTags.length > 0) {
    const reported = report.surfaceTags ?? [];
    if (reported.length > 0 && !intersects(reported, filters.surfaceTags)) return false;
  }

  return true;
}

/** Keep only the members of `wanted` present in `valid`, de-duplicated and order-preserving. */
function cleanEnumList<T extends string>(raw: unknown, valid: readonly T[]): T[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<T>();
  for (const v of raw) {
    if (typeof v === 'string' && (valid as readonly string[]).includes(v)) seen.add(v as T);
  }
  return seen.size > 0 ? [...seen] : undefined;
}

/**
 * Coerce an untrusted filter blob (local storage or a client mutation arg) into a clean `FeedFilters`,
 * dropping anything malformed or out-of-domain. Single-sourced so the client persistence layer and the
 * server `setFeedFilterPrefs` sanitize identically (D37 — never trust the client's copy). Omitted /
 * invalid fields are simply absent from the result (⇒ that gate is off).
 */
export function sanitizeFeedFilters(raw: unknown): FeedFilters {
  const input = (raw ?? {}) as Record<string, unknown>;
  const filters: FeedFilters = {};

  if (isDriveTimeBand(input.radiusMinutes)) filters.radiusMinutes = input.radiusMinutes;

  if (
    typeof input.qualityFloor === 'string' &&
    (SKATE_QUALITIES as readonly string[]).includes(input.qualityFloor)
  ) {
    filters.qualityFloor = input.qualityFloor as SkateQuality;
  }

  if (
    typeof input.thicknessFloorCm === 'number' &&
    Number.isFinite(input.thicknessFloorCm) &&
    input.thicknessFloorCm >= 0
  ) {
    filters.thicknessFloorCm = input.thicknessFloorCm;
  }

  if (input.noSnow === true) filters.noSnow = true;

  const iceTypes = cleanEnumList(input.iceTypes, ICE_TYPES);
  if (iceTypes) filters.iceTypes = iceTypes;
  const surfaceTags = cleanEnumList(input.surfaceTags, SURFACE_TAGS);
  if (surfaceTags) filters.surfaceTags = surfaceTags;

  if (
    typeof input.recencyHours === 'number' &&
    Number.isFinite(input.recencyHours) &&
    input.recencyHours > 0
  ) {
    filters.recencyHours = input.recencyHours;
  }

  return filters;
}
