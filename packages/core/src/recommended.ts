/**
 * Pure recommended-feed selection (decisions 13–15) — decides which *exceptional, corroborated* reports
 * may break a user's own distance/quality/thickness filters, and bundles/caps them. No Convex, no I/O.
 *
 * The bar is **trust + corroboration, never a lone great report** (D3): amplifying one unverified "great
 * ice!" claim across someone's filters is exactly how you build a machine for wasted trips. So a report
 * only qualifies when it is highly corroborated, authored by a high-trust user, photo-backed, top
 * quality, black ice, and recent — all at once. It breaks distance / quality / thickness filters but
 * **never** recency, blocks, or moderation (those gates are applied by the caller before this runs).
 *
 * Thresholds live in `reputationConfig.ts`; callers may override per field for tests / Phase-7 tuning.
 */

import {
  RECOMMENDED_BUNDLE_SIZE,
  RECOMMENDED_MAX_BODIES_PER_DAY,
  RECOMMENDED_MIN_CORROBORATION,
  RECOMMENDED_MIN_PHOTOS,
  RECOMMENDED_MIN_TRUST_CLASS,
  RECOMMENDED_RECENCY_HOURS,
  TRUST_CLASSES,
  type TrustClass,
} from './reputationConfig';
import type { IceType, SkateQuality } from './types';

const HOUR_MS = 60 * 60 * 1000;

/** Ascending trust-class rank; `null` (no class) ranks below `new` so "≥ Expert" is a simple compare. */
function trustRank(trust: TrustClass | null): number {
  return trust === null ? -1 : TRUST_CLASSES.indexOf(trust);
}

/** A candidate report, pre-enriched by the caller with its corroboration count + author trust class. */
export interface RecommendableReport {
  reportId: string;
  waterBodyId: string;
  /** Skate-end time (epoch ms) — drives the recency floor and ranking tie-break. */
  skateEndTime: number;
  skateQuality?: SkateQuality;
  iceTypes?: readonly IceType[];
  /** Number of photos on the report (photo-backed evidence gate). */
  photoCount: number;
  /** Independent in-window corroborators counted for this report (decision 14). */
  corroborationCount: number;
  /** The author's derived trust class at read time (`null` = no class). */
  authorTrust: TrustClass | null;
}

/** The tunable bar (decision 14). Every field defaults from `reputationConfig`; override per test. */
export interface RecommendedThresholds {
  minCorroboration: number;
  minTrustClass: TrustClass;
  minPhotos: number;
  requiredQuality: SkateQuality;
  requiredIceType: IceType;
  recencyHours: number;
}

const DEFAULT_THRESHOLDS: RecommendedThresholds = {
  minCorroboration: RECOMMENDED_MIN_CORROBORATION,
  minTrustClass: RECOMMENDED_MIN_TRUST_CLASS,
  minPhotos: RECOMMENDED_MIN_PHOTOS,
  requiredQuality: 'great',
  requiredIceType: 'black_ice',
  recencyHours: RECOMMENDED_RECENCY_HOURS,
};

/**
 * Does one report clear the "exceptional" bar (decision 14)? Every clause must hold at once:
 * corroboration ≥ floor, author trust ≥ `minTrustClass`, ≥ `minPhotos`, quality is exactly the required
 * top tier, ice types include the required type (black ice), and skate-end is within the recency floor.
 */
export function isRecommendable(
  report: RecommendableReport,
  now: number,
  overrides: Partial<RecommendedThresholds> = {},
): boolean {
  const t = { ...DEFAULT_THRESHOLDS, ...overrides };
  return (
    report.corroborationCount >= t.minCorroboration &&
    trustRank(report.authorTrust) >= trustRank(t.minTrustClass) &&
    report.photoCount >= t.minPhotos &&
    report.skateQuality === t.requiredQuality &&
    (report.iceTypes?.includes(t.requiredIceType) ?? false) &&
    report.skateEndTime >= now - t.recencyHours * HOUR_MS
  );
}

/**
 * A "more exceptional first" comparator: more corroboration, then more photos, then more recent. Pure
 * and total, so `rankRecommendations` is a stable, deterministic sort.
 */
function compareRecommendable(a: RecommendableReport, b: RecommendableReport): number {
  return (
    b.corroborationCount - a.corroborationCount ||
    b.photoCount - a.photoCount ||
    b.skateEndTime - a.skateEndTime
  );
}

/** Reports sorted most-exceptional first (does not filter — pair with `isRecommendable`). */
export function rankRecommendations(
  reports: readonly RecommendableReport[],
): RecommendableReport[] {
  return [...reports].sort(compareRecommendable);
}

/** One recommended card: a body plus the bundled top reports for it (best first, ≤ `bundleSize`). */
export interface RecommendedCard {
  waterBodyId: string;
  reportIds: string[];
}

/**
 * Select the recommended cards for a user this read (decisions 14–15): filter to recommendable, drop
 * bodies already recommended recently (dedup), then per body bundle its top `bundleSize` reports into
 * one card, rank bodies by their best report, and cap at `maxBodies` unique bodies. Returns 0–`maxBodies`
 * cards. The caller supplies the per-user daily budget (`maxBodies`) and the recently-recommended body
 * set (`excludeBodyIds`) from server-tracked state — more reliable than client session state (decision 15).
 */
export function selectRecommended(
  candidates: readonly RecommendableReport[],
  opts: {
    now: number;
    excludeBodyIds?: ReadonlySet<string>;
    maxBodies?: number;
    bundleSize?: number;
    thresholds?: Partial<RecommendedThresholds>;
  },
): RecommendedCard[] {
  const {
    now,
    excludeBodyIds,
    maxBodies = RECOMMENDED_MAX_BODIES_PER_DAY,
    bundleSize = RECOMMENDED_BUNDLE_SIZE,
    thresholds,
  } = opts;
  if (maxBodies <= 0) return [];

  // Group recommendable, non-deduped reports by body. `rankRecommendations` pre-sorts, so each group is
  // built most-exceptional first and its head (`best`) is the body's top report.
  const byBody = new Map<string, { best: RecommendableReport; reports: RecommendableReport[] }>();
  for (const report of rankRecommendations(candidates)) {
    if (!isRecommendable(report, now, thresholds)) continue;
    if (excludeBodyIds?.has(report.waterBodyId)) continue;
    const group = byBody.get(report.waterBodyId);
    if (group) group.reports.push(report);
    else byBody.set(report.waterBodyId, { best: report, reports: [report] });
  }

  // Rank bodies by their single best report, then take the daily budget of unique bodies.
  return [...byBody.values()]
    .sort((a, b) => compareRecommendable(a.best, b.best))
    .slice(0, maxBodies)
    .map((group) => ({
      waterBodyId: group.best.waterBodyId,
      reportIds: group.reports.slice(0, bundleSize).map((r) => r.reportId),
    }));
}
