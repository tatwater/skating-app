/**
 * **The corpus campaign's plan** (D341, B01-8a): the passes `scripts/etl/run-corpus.sh` runs, in its
 * order, and the three an operator runs by hand afterwards — each with the `importRuns.kind` its row
 * is written under and the board's *What it does* — plus which kinds list under Machinery › Corpus
 * and how a stored run is named as a pass.
 *
 * Core holds it (not the Convex package) because the server's reads, `importRuns.start`'s
 * `listedIn` derivation and the web's passes table all name passes, and the three must agree.
 * `kind` is a plain string here: core can't import the Convex package's `IMPORT_RUN_KINDS`.
 *
 * PLACEHOLDER (B01-8a T0): the names, kinds and order are the seam, from the design's pass table;
 * the *What it does* words and `passOfRun` are S2's.
 */

/** `run-corpus.sh`'s name for each pass it runs, in order, then the by-hand passes. */
export const CORPUS_SCRIPT_PASSES = [
  'build-region',
  'merge',
  'load',
  'load-sub-areas',
  'landmarks',
  'load-landmarks',
  'load-landmark-names',
] as const;

export const CORPUS_HAND_PASSES = ['prune-floor', 'seed-standing', 'retire-absorbed'] as const;

export type CorpusPassName =
  | (typeof CORPUS_SCRIPT_PASSES)[number]
  | (typeof CORPUS_HAND_PASSES)[number];

export interface CorpusPlanPass {
  pass: CorpusPassName;
  /** The `importRuns.kind` the pass's row is written under. */
  kind: string;
  by: 'script' | 'hand';
  /** The board's *What it does*. */
  does: string;
}

/**
 * The script's seven passes in order, then the three by hand. Two passes share `landmark_seed`, so a
 * kind alone can't name a pass (`passOfRun`).
 */
export const CORPUS_RUN_PLAN: readonly CorpusPlanPass[] = [
  { pass: 'build-region', kind: 'region_masks', by: 'script', does: '' },
  { pass: 'merge', kind: 'corpus_merge', by: 'script', does: '' },
  { pass: 'load', kind: 'canonical_water', by: 'script', does: '' },
  { pass: 'load-sub-areas', kind: 'sub_area_seed', by: 'script', does: '' },
  { pass: 'landmarks', kind: 'landmark_match', by: 'script', does: '' },
  { pass: 'load-landmarks', kind: 'landmark_seed', by: 'script', does: '' },
  { pass: 'load-landmark-names', kind: 'landmark_seed', by: 'script', does: '' },
  { pass: 'prune-floor', kind: 'floor_prune', by: 'hand', does: '' },
  { pass: 'seed-standing', kind: 'standing_seed', by: 'hand', does: '' },
  { pass: 'retire-absorbed', kind: 'absorbed_retire', by: 'hand', does: '' },
];

/**
 * What lists under Machinery › Corpus (`importRuns.listedIn: 'corpus'` for a row with no parent):
 * the campaign and its passes, `dedup_resolve`, `standing_seed`, `seed_destinations`, and
 * `run-canonical.sh`'s single-state loads (`canonical_water`).
 */
export const CORPUS_RUN_KINDS: readonly string[] = [
  'corpus_campaign',
  'region_masks',
  'corpus_merge',
  'canonical_water',
  'sub_area_seed',
  'landmark_match',
  'landmark_seed',
  'floor_prune',
  'standing_seed',
  'absorbed_retire',
  'dedup_resolve',
  'seed_destinations',
];

/** What `passOfRun` reads of a run: an `importRuns` row. */
export interface PassOfRunInput {
  kind: string;
  label: string;
  campaignPass?: string;
}

/**
 * A run's pass: `campaignPass` when stored, else by kind, telling `load-landmarks` from
 * `load-landmark-names` by label for rows before B01-8a. `null` for a kind that is no pass.
 *
 * PLACEHOLDER (B01-8a T0): S2 writes it.
 */
export function passOfRun(_run: PassOfRunInput): CorpusPassName | null {
  throw new Error('passOfRun is not built yet');
}
