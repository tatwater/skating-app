/**
 * The shapes a loader hands the run logger. These mirror the `importRuns` table validators in
 * `packages/convex/convex/schema.ts` — deliberately re-declared rather than imported, because the
 * scripts are a separate tsconfig project from the Convex package's generated types and a loader
 * should not need `_generated` to be current in order to compile.
 */

/**
 * One member of `IMPORT_RUN_KINDS` (`packages/convex/convex/lib/enums.ts`). Keep in step —
 * `packages/guards` checks it.
 */
export type ImportRunKind =
  | 'canonical_water'
  /** `scripts/etl merge` — the offline three-archive reconciliation that decides the corpus (A07a). */
  | 'corpus_merge'
  /**
   * `scripts/etl load-sub-areas` — the bays the merge found a parent for (A07a second audit).
   *
   * Its own kind rather than a `canonical_water` variant, because it writes a different table and
   * fails differently: a bay that cannot find its parent is an ordering error in the campaign, not a
   * body that failed a rule.
   */
  | 'sub_area_seed'
  /**
   * `scripts/etl resolve-merge-duplicates` — the `merge` verdicts a load declined (A07a).
   *
   * Its own kind because it **deletes**, and a pass that removes rows must never be filed under the
   * one that adds them: `/admin/imports` is where an operator goes to ask what a campaign did, and
   * "the load" and "the thing that deleted 110 rows" are not the same answer.
   */
  | 'dedup_resolve'
  | 'osm_depths'
  | 'admin_areas'
  | 'lake_depth'
  | 'elevation'
  | 'wind_climate'
  | 'bathymetry_coverage'
  | 'seed_destinations'
  | 'region_stats'
  // The acquisition steps, ahead of any loader — where a source turns out to have moved, changed
  // schema, or quietly returned less than last time.
  | 'raw_archive'
  | 'r2_mirror'
  | 'bathymetry_join'
  | 'bathymetry_build'
  | 'bathymetry_tiles'
  /**
   * `scripts/etl load-access` — the A06d access pass, in two kinds because it runs in two stages with
   * a hard order between them.
   *
   * A put-in references its lot by OSM id, so the lots must be rows first. Sharing one kind would
   * make the signature of running them out of order (`parkingMissing` on every put-in) look like a
   * data quality finding rather than a sequencing mistake.
   */
  | 'access_parking'
  | 'access_put_ins'
  // Corpus standing (A07b): the one-time partition into active / dormant, and the July rollover.
  | 'standing_seed'
  | 'standing_rollover'
  /** `scripts/etl load-landmarks` — the named places a body is steered by (D202). */
  | 'landmark_seed'
  /** `waterBodies:sweepAllBodySummaries` — the full map-card walk that fills the refresh table. */
  | 'body_summary_backfill'
  // The corpus campaign's passes that left no row before B01-7a (D218).
  /** `scripts/admin-areas build-region` — the TIGER region masks the merge clips against. */
  | 'region_masks'
  /** `scripts/etl landmarks` — the offline OSM + GNIS match `load-landmarks` loads (D202). */
  | 'landmark_match'
  /** `scripts/etl prune-floor` — the rows the area floor refuses, demoted to dormant. */
  | 'floor_prune'
  /**
   * `scripts/etl retire-absorbed` — the merge's absorbed rows folded into their survivors (D136).
   * Logged as `canonical_water` before B01-7a, which made it read as a campaign's load.
   */
  | 'absorbed_retire';

/**
 * What a run set out to cover (D218): one member of `IMPORT_RUN_SCOPES`
 * (`packages/convex/convex/lib/enums.ts`). Keep in step — `packages/guards` checks it.
 */
export type ImportRunScopePass =
  | 'full-canonical'
  | 'single-source'
  | 'enrichment'
  | 'seed'
  | 'rollover'
  | 'archive'
  /** Computed from data already held; writes no third-party data into the model. */
  | 'derived'
  /** Brings the stored corpus into line with what a campaign decided: demotes or folds. */
  | 'cleanup';

/**
 * **What a run set out to cover**, stated once at its start (D218) — so a full re-import and a
 * gap-fill read differently without inferring it from `kind` and `label`. What the run *achieved*
 * is its status and coverage, never this.
 */
export interface ImportRunScope {
  pass: ImportRunScopePass;
  /** The states it covered, two-letter codes. Absent when the pass is not by state. */
  states?: string[];
  /**
   * All of what its pass covers: `false` for a subset of states, a resumed walk, or a merge missing
   * one of its catalogs.
   */
  complete: boolean;
}

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
