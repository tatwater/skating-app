/**
 * **The select stage** (B05 §2.1): walk the catalog, apply the rule to all of it, refuse what the
 * founder must look at, score the frames that show, and write the build's manifest and the cloud
 * contact sheet. `cli/select.ts` hands in the real world; everything here takes it injected.
 *
 * What it refuses, before anything is written (each a `SelectRefusal`, the run row failed with it):
 *
 * - the off-season step reaching a cell beyond `NAIP_OFF_SEASON_CELLS` (a seventh October cell is a
 *   look for the founder, never a silent foliage pick);
 * - a cell whose every candidate is struck (a hole the exclusion list made);
 * - any violation of the rule's invariants on the whole catalog (`checkSelection`);
 * - a `--cells` key no frame covers (a typo would otherwise build nothing there, quietly).
 */

import {
  isQuarterQuadKey,
  NAIP_EXCLUSIONS,
  NAIP_OFF_SEASON_CELLS,
  NAIP_STATES,
  type NaipCandidate,
  type NaipCatalogItem,
  type NaipCellPick,
  type NaipExclusion,
  type NaipManifest,
  type NaipState,
  selectNaipPicks,
} from '@skating/core';
import type { RunLogger } from '@skating/run-log';
import type { CatalogSnapshot } from './catalog';
import type { ScoreTarget, ThumbnailScore } from './score';
import type { CloudCandidates } from './scoreSheet';
import { cloudCandidates } from './scoreSheet';
import { checkSelection } from './selectChecks';
import { buildManifest, framesShowing, manifestCounts, type Narrowing } from './selectManifest';
import { parseCellList, type StageArgs } from './stages';

/** A build the stage won't make. The message is the run row's error and the operator's answer. */
export class SelectRefusal extends Error {
  override name = 'SelectRefusal';
}

/** The run row, as far as this stage writes it; `null` for a dry run (no row). */
export type SelectRunLog = Pick<RunLogger, 'start' | 'count' | 'flush' | 'succeed' | 'failed'>;

export interface SelectDeps {
  /** The catalog: walked, or the campaign's snapshot read back. Calls `onState` per state. */
  walk: (onState: (state: NaipState, items: number) => void) => Promise<CatalogSnapshot>;
  /** Scores frames (thumbnails); `null` for one that couldn't be scored. */
  score: (targets: readonly ScoreTarget[]) => Promise<Map<string, ThumbnailScore | null>>;
  /** The current build's manifest, for `--from-current`. */
  readCurrent: () => Promise<NaipManifest>;
  /** A `--cells` file's text. */
  readCellList: (path: string) => string;
  /** Writes the manifest; returns where. */
  writeManifest: (manifest: NaipManifest) => string;
  /** Writes the contact sheet; returns where. */
  writeSheet: (candidates: CloudCandidates) => string;
  log: (line: string) => void;
  run: SelectRunLog | null;
  now: () => Date;
  exclusions?: readonly NaipExclusion[];
  offSeasonCells?: readonly string[];
  /** The whole-catalog proof; injectable only so a test can make it fail. */
  check?: typeof checkSelection;
}

export interface SelectResult {
  manifest: NaipManifest;
  manifestPath: string;
  sheetPath: string;
  candidates: CloudCandidates;
  counts: Record<string, number>;
  /** Cells listed only with coarse frames: no candidate, so nothing to show (reported, not refused). */
  noCandidate: string[];
}

/** The ids the rounds of scoring ask for: what shows, then what would replace a candidate. */
async function scoreRounds(
  picks: readonly NaipCellPick[],
  deps: SelectDeps,
): Promise<Map<string, ThumbnailScore | null>> {
  const scores = new Map<string, ThumbnailScore | null>();
  const take = async (frames: readonly NaipCandidate[]) => {
    const fresh = frames.filter((f) => !scores.has(f.itemId));
    if (fresh.length === 0) return false;
    // The rule hands back the walk's own objects, so the thumbnail rides along.
    const targets = fresh.map((f) => ({
      itemId: f.itemId,
      thumbnail: (f as Partial<NaipCatalogItem>).thumbnail ?? null,
    }));
    for (const [id, s] of await deps.score(targets)) scores.set(id, s);
    for (const f of fresh) if (!scores.has(f.itemId)) scores.set(f.itemId, null);
    return true;
  };
  // Each round scores the next frame down every partial stack, until each cell's showing frames are
  // known (a stack is at most ~15 deep).
  for (;;) {
    const pending = picks.flatMap((p) => framesShowing(p, scores).pending);
    if (!(await take(pending))) break;
  }
  // The sheet draws each candidate beside its replacement, so those are scored too.
  const byKey = new Map(picks.map((p) => [p.key, p]));
  await take(
    cloudCandidates(picks, scores).picks.flatMap((c) =>
      (byKey.get(c.key) as NaipCellPick).stack.slice(0, 1),
    ),
  );
  return scores;
}

export async function runSelect(args: StageArgs, deps: SelectDeps): Promise<SelectResult> {
  const exclusions = deps.exclusions ?? NAIP_EXCLUSIONS;
  const offSeasonCells = deps.offSeasonCells ?? NAIP_OFF_SEASON_CELLS;
  const run = deps.run;
  run?.start();
  try {
    let narrowing: Narrowing = null;
    if (args.states !== null) narrowing = { states: args.states };
    if (args.cells !== null) {
      const keys = parseCellList(deps.readCellList(args.cells));
      const bad = keys.filter((k) => !isQuarterQuadKey(k));
      if (bad.length > 0) throw new SelectRefusal(`--cells: not quarter-quads: ${bad.join(', ')}`);
      narrowing = { cells: keys };
    }
    const current = args.fromCurrent ? await deps.readCurrent() : null;

    const snapshot = await deps.walk((state, items) => {
      run?.count(`items${state}`, items);
      run?.flush();
      deps.log(`[select] ${state}: ${items} items`);
    });
    const candidates = snapshot.items;
    run?.count('items', candidates.length);

    const selection = selectNaipPicks(candidates, exclusions, offSeasonCells);
    run?.count('droppedCoarse', selection.dropped.coarse);
    run?.count('droppedOutsideState', selection.dropped.outsideState);
    run?.count('droppedExcluded', selection.dropped.excluded);
    run?.count('picks', selection.picks.length);
    if (selection.offSeasonBeyondList.length > 0) {
      run?.count('offSeasonBeyondList', selection.offSeasonBeyondList.length);
      throw new SelectRefusal(
        `the off-season step reached cells beyond the committed six: ${selection.offSeasonBeyondList.join(', ')} — a look for the founder, not a silent foliage pick`,
      );
    }
    const check = (deps.check ?? checkSelection)(candidates, exclusions, selection);
    if (check.holes.length > 0) {
      throw new SelectRefusal(
        `the exclusion list leaves ${check.holes.length} cells with no frame: ${check.holes.join(', ')}`,
      );
    }
    if (check.violations.length > 0) {
      throw new SelectRefusal(
        `the rule's invariants fail on ${check.violations.length} cells: ${check.violations.slice(0, 20).join('; ')}`,
      );
    }
    if (narrowing !== null && 'cells' in narrowing) {
      const picked = new Set(selection.picks.map((p) => p.key));
      const uncovered = narrowing.cells.filter((k) => !picked.has(k));
      if (uncovered.length > 0) {
        throw new SelectRefusal(`--cells lists cells no frame covers: ${uncovered.join(', ')}`);
      }
    }

    deps.log(`[select] scoring the frames that show (${selection.picks.length} picks first)`);
    const scores = await scoreRounds(selection.picks, deps);
    const candidatesForSheet = cloudCandidates(selection.picks, scores);

    const perState: Partial<Record<NaipState, number>> = {};
    for (const s of NAIP_STATES) {
      if (snapshot.perState[s] !== undefined) perState[s] = snapshot.perState[s];
    }
    const manifest = buildManifest({
      campaign: args.campaign,
      pilot: args.pilot,
      createdAt: deps.now().toISOString(),
      catalog: {
        walkedOn: snapshot.walkedOn,
        items: candidates.length,
        perState,
        // The select stage keeps the snapshot beside the campaign; its upload to the private
        // bucket (`inventoryKey`) is the run's executor's, and a dry run never uploads. Nor does
        // a pilot: `naip/inventory/` is shared with the full build and outside every pilot
        // prefix, and a pilot writes nothing outside its own (found at the pilot, 2026-11-26).
        archivedAt:
          args.dryRun || args.pilot !== null ? null : `naip/inventory/${snapshot.walkedOn}/`,
      },
      selection,
      exclusions,
      offSeasonCells,
      scores,
      narrowing,
      current,
    });
    const counts = {
      ...manifestCounts(manifest),
      scored: [...scores.values()].filter((s) => s !== null).length,
      cloudCandidates: candidatesForSheet.picks.length,
      cloudFallbackCandidates: candidatesForSheet.fallbacks.length,
      noCandidate: check.noCandidate.length,
    };
    for (const [name, value] of Object.entries(counts)) run?.count(name, value);
    const manifestPath = deps.writeManifest(manifest);
    const sheetPath = deps.writeSheet(candidatesForSheet);
    run?.succeed([
      `${manifest.cells.length} cells, ${manifest.workTiles.filter((w) => w.retile).length} of ${manifest.workTiles.length} work tiles to cut`,
      `${candidatesForSheet.picks.length} picks over the cloud threshold, for review`,
    ]);
    return {
      manifest,
      manifestPath,
      sheetPath,
      candidates: candidatesForSheet,
      counts,
      noCandidate: check.noCandidate,
    };
  } catch (e) {
    run?.failed(e);
    throw e;
  }
}

/** The picks by labeled state, year, resolution and step — §2.1's table, for the report. */
export function pickTable(manifest: NaipManifest): string[] {
  const rows = new Map<string, number>();
  for (const c of manifest.cells) {
    const f = manifest.frames[c.pick] as NaipManifest['frames'][string];
    const label = `${f.state} ${f.year} ${f.gsd} m${c.step === 'offSeason' ? ` (off-season, ${f.acquired})` : ''}`;
    rows.set(label, (rows.get(label) ?? 0) + 1);
  }
  return [...rows].sort(([a], [b]) => (a < b ? -1 : 1)).map(([label, n]) => `${label}: ${n}`);
}
