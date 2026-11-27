/**
 * **The corpus campaign's plan** (D341, B01-8a): the passes `scripts/etl/run-corpus.sh` runs, in its
 * order, and the three an operator runs by hand afterwards — each with the `importRuns.kind` its row
 * is written under and the board's *What it does* — plus which kinds list under Machinery › Corpus
 * and how a stored run is named as a pass.
 *
 * Core holds it (not the Convex package) because the server's reads, `importRuns.start`'s
 * `listedIn` derivation and the web's passes table all name passes, and the three must agree.
 * `kind` is a plain string here: core can't import the Convex package's `IMPORT_RUN_KINDS`.
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
  { pass: 'build-region', kind: 'region_masks', by: 'script', does: 'Region masks' },
  { pass: 'merge', kind: 'corpus_merge', by: 'script', does: 'Three catalogs, one filter' },
  { pass: 'load', kind: 'canonical_water', by: 'script', does: 'Bodies → Convex' },
  { pass: 'load-sub-areas', kind: 'sub_area_seed', by: 'script', does: 'Bays under their lakes' },
  { pass: 'landmarks', kind: 'landmark_match', by: 'script', does: 'Match OSM + GNIS names' },
  { pass: 'load-landmarks', kind: 'landmark_seed', by: 'script', does: 'Landmarks → Convex' },
  {
    pass: 'load-landmark-names',
    kind: 'landmark_seed',
    by: 'script',
    does: 'Unplaced names → review',
  },
  { pass: 'prune-floor', kind: 'floor_prune', by: 'hand', does: 'Demote rows the floor refuses' },
  {
    pass: 'seed-standing',
    kind: 'standing_seed',
    by: 'hand',
    does: 'Shelve new bodies nobody uses',
  },
  {
    pass: 'retire-absorbed',
    kind: 'absorbed_retire',
    by: 'hand',
    does: 'Fold the duplicates the merge absorbed',
  },
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
 * The label `scripts/etl/src/loadLandmarkNames.ts` writes; `load-landmarks` shares its kind
 * (`landmark_seed`), so a row from before B01-8a (no `campaignPass`) is told apart by it.
 */
export const LANDMARK_NAMES_LABEL_PREFIX = 'Corpus place names';

/**
 * A `retire-absorbed` row written before it had its own kind: `canonical_water`, labeled by
 * `scripts/etl/src/retireAbsorbed.ts` (the Convex package's `isLegacyRetireRow` reads the same).
 */
export const LEGACY_RETIRE_LABEL_PREFIX = 'retire absorbed duplicates';

const PASS_NAMES: ReadonlySet<string> = new Set(CORPUS_RUN_PLAN.map((p) => p.pass));

/**
 * A run's pass: `campaignPass` when stored (and a pass this plan knows), else by kind, telling
 * `load-landmarks` from `load-landmark-names` by label, and a legacy `retire-absorbed` row (kind
 * `canonical_water`) by its label, for rows before B01-8a. `null` for a kind that is no pass (the
 * campaign row itself, `dedup_resolve`, `seed_destinations`, any other loader).
 */
export function passOfRun(run: PassOfRunInput): CorpusPassName | null {
  if (run.campaignPass !== undefined && PASS_NAMES.has(run.campaignPass)) {
    return run.campaignPass as CorpusPassName;
  }
  if (run.kind === 'landmark_seed') {
    return run.label.startsWith(LANDMARK_NAMES_LABEL_PREFIX)
      ? 'load-landmark-names'
      : 'load-landmarks';
  }
  if (run.kind === 'canonical_water' && run.label.startsWith(LEGACY_RETIRE_LABEL_PREFIX)) {
    return 'retire-absorbed';
  }
  return CORPUS_RUN_PLAN.find((p) => p.kind === run.kind)?.pass ?? null;
}

/** A pass's plan entry. */
export function planPass(pass: CorpusPassName): CorpusPlanPass {
  const found = CORPUS_RUN_PLAN.find((p) => p.pass === pass);
  if (found === undefined) throw new Error(`no corpus pass named ${pass}`);
  return found;
}
