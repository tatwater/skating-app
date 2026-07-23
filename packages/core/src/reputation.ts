/**
 * Pure reputation math (D50) — the single source of truth for trust-class derivation, the "reports
 * agree" / "hazards agree" corroboration tests, and the measured-thickness rigor check. Heavily tested
 * (100%, D40) before any Convex wiring, because this is safety-adjacent: a corroboration rule that's too
 * loose inflates trust off coincidence, and trust drives what the recommended feed amplifies (D3).
 *
 * All tunable numbers live in `reputationConfig.ts` (the Phase-7 admin surface); this module is only the
 * logic that reads them.
 */

import { NEW_ACCOUNT_WINDOW_MS, TRUST_CLASS_THRESHOLDS, type TrustClass } from './reputationConfig';
import type { IceType, SkateQuality } from './types';

/** Ascending skate-quality rank so "within one ordinal step" is `|rankA − rankB| <= 1` (great is best). */
const QUALITY_RANK: Record<SkateQuality, number> = { poor: 0, fair: 1, good: 2, great: 3 };

/**
 * Derive the cosmetic trust class from a boost-only point total and account age (decision 5).
 *
 * Point thresholds are checked **first, top-down**, so points always beat age — a fast earner is
 * `expert` even inside the New window. Only if the total is below `trusted` does age decide: inside the
 * New window → `new` (a welcome, even with zero signals); past it → `null` (no chip — we never render
 * "Not trusted"). Since the model is boost-only, `points` is never negative in Phase 6.
 */
export function deriveTrustClass(points: number, accountAgeMs: number): TrustClass | null {
  if (points >= TRUST_CLASS_THRESHOLDS.leader) return 'leader';
  if (points >= TRUST_CLASS_THRESHOLDS.expert) return 'expert';
  if (points >= TRUST_CLASS_THRESHOLDS.trusted) return 'trusted';
  if (accountAgeMs < NEW_ACCOUNT_WINDOW_MS) return 'new';
  return null;
}

/** The report fields corroboration reads — both attributes optional, since a report may omit either. */
export interface AgreeableReport {
  skateQuality?: SkateQuality;
  iceTypes?: readonly IceType[];
}

/** Do two ice-type sets share at least one member? */
function shareIceType(a: readonly IceType[] = [], b: readonly IceType[] = []): boolean {
  return a.some((t) => b.includes(t));
}

/**
 * The corroboration "agrees" test (decision 3): two same-body reports agree when their `skateQuality` is
 * **within one ordinal step** (different people mean different things by each label, so exact-match is
 * too strict) **OR** they share **≥1 ice type**. Either signal alone is enough. When neither report
 * carries a quality *and* they share no ice type, they don't agree — absence isn't agreement.
 */
export function reportsAgree(a: AgreeableReport, b: AgreeableReport): boolean {
  if (a.skateQuality !== undefined && b.skateQuality !== undefined) {
    if (Math.abs(QUALITY_RANK[a.skateQuality] - QUALITY_RANK[b.skateQuality]) <= 1) return true;
  }
  return shareIceType(a.iceTypes, b.iceTypes);
}

/**
 * The corroboration **contradiction** test (Phase 10 / D56 §7, the inverse seam of `reportsAgree`). A
 * genuine contradiction needs conflicting *signal*, not mere absence: both reports carry a `skateQuality`
 * that differs by **≥2 ordinal steps** (e.g. `great` vs `fair`/`poor`) **and** they share **no** ice type
 * (a shared ice type is itself an agreement signal). This is a strict subset of `!reportsAgree`, so a pair
 * can never both agree *and* contradict.
 *
 * A contradiction is only the *candidate* — the caller must still confirm the weather-since doesn't explain
 * the change before it counts (an honest "the ice changed" report is never a contradiction; D3/D50).
 */
export function reportsContradict(a: AgreeableReport, b: AgreeableReport): boolean {
  if (a.skateQuality === undefined || b.skateQuality === undefined) return false;
  if (Math.abs(QUALITY_RANK[a.skateQuality] - QUALITY_RANK[b.skateQuality]) < 2) return false;
  return !shareIceType(a.iceTypes, b.iceTypes);
}

/** The hazard field the agreement test reads — a hazard carries exactly one `type` (Phase 9). */
export interface AgreeableHazard {
  type: string;
}

/**
 * Two hazards agree when they are the **same type** (decision 3). A hazard carries exactly one type
 * (Phase 9), so "type overlap" is type equality — a pressure ridge doesn't corroborate open water.
 */
export function hazardsAgree(a: AgreeableHazard, b: AgreeableHazard): boolean {
  return a.type === b.type;
}

/** A report's thickness shape — an optional list of readings, each `measured` or `estimated`. */
export interface MeasurableReport {
  iceThickness?: { readings: readonly { method?: string }[] };
}

/**
 * True when a report carries **≥1 measured** (not estimated) thickness reading — the gate for the
 * once-per-report `measured_thickness` boost and the `Measured` badge (decision 2). Rewards rigor: an
 * actual drilled/probed reading, not an eyeballed guess.
 */
export function hasMeasuredThickness(report: MeasurableReport): boolean {
  return report.iceThickness?.readings.some((r) => r.method === 'measured') ?? false;
}
