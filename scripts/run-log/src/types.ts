/**
 * The shapes a loader hands the run logger. These mirror the `importRuns` table validators in
 * `packages/convex/convex/schema.ts` — deliberately re-declared rather than imported, because the
 * scripts are a separate tsconfig project from the Convex package's generated types and a loader
 * should not need `_generated` to be current in order to compile.
 */

/** One member of `IMPORT_RUN_KINDS` (`packages/convex/convex/lib/enums.ts`). Keep in step. */
export type ImportRunKind =
  | 'canonical_water'
  | 'osm_depths'
  | 'admin_areas'
  | 'lake_depth'
  | 'elevation'
  | 'wind_climate'
  | 'bathymetry_coverage'
  | 'region_stats'
  // The acquisition steps, ahead of any loader — where a source turns out to have moved, changed
  // schema, or quietly returned less than last time.
  | 'raw_archive'
  | 'r2_mirror'
  | 'bathymetry_join'
  | 'bathymetry_build'
  | 'bathymetry_tiles';

/** A named tally. Each loader names its own; see the table comment for why they aren't columns. */
export interface RunCount {
  name: string;
  value: number;
}

/**
 * One step of the full path — an archived extract, an `osmium` filter, a transform, a load.
 *
 * Everything past `name` is optional because the stages genuinely differ: a download has a
 * checksum and no command, a filter has a command and no checksum. Recording the union honestly,
 * with holes, beats inventing a lowest common denominator that describes none of them.
 */
export interface RunStage {
  name: string;
  detail?: string;
  command?: string;
  input?: string;
  output?: string;
  sourceUrl?: string;
  bytes?: number;
  sha256?: string;
  md5?: string;
  checksumVerified?: boolean;
  /** When the stage's *input* was produced (an extract's build date), not when the stage ran. */
  sourceAt?: number;
  counts?: RunCount[];
}

/** An itemized failure. `key` is whatever identifies the item — an `externalId`, a grid cell. */
export interface RunFailure {
  stage: string;
  key?: string;
  reason: string;
}

/**
 * What share of what a run *could* have covered, it actually did — and where the rest went.
 *
 * **A rate, not a count, because a count cannot be wrong.** "9,981 bodies stamped" reads as a
 * complete pass whether the corpus is 10,000 or 116,070; only a denominator makes a shortfall
 * visible. Every loader here already computed its rate and printed it to a terminal that scrolls.
 *
 * `omissions` must account for `eligible - covered`. The admin page renders any remainder as
 * **unexplained**, which is the line between "skipped, below the source's documented area floor"
 * and "went missing and nobody noticed" — indistinguishable in a totals-only summary, and the two
 * readings that matter most.
 */
export interface ImportRunCoverage {
  /** What is being counted — 'bodies', 'lakes', 'grid cells', 'towns'. */
  unit: string;
  /** The honest denominator: everything this pass could in principle have stamped. */
  eligible: number;
  /** What it actually stamped. */
  covered: number;
  /** Where the difference went, by reason. Documented limits belong here, not in prose. */
  omissions: { reason: string; count: number }[];
}
