/**
 * **The select stage** (B05 §2.1): walk the catalog, apply the rule to all of it, refuse what the
 * founder must look at, score the frames that show, and write the build's manifest and the cloud
 * contact sheet. `cli/select.ts` hands in the real world; everything here takes it injected.
 *
 * What it refuses, before anything is written (each a `SelectRefusal`, the run row failed with it):
 *
 * - a foliage strike the founder hasn't confirmed (`reviewedBy: 'proposed'`), in anything but a dry
 *   run: a proposal is run to be looked at, never built (D319);
 * - a cell whose every candidate is struck (a hole the exclusion list made);
 * - any violation of the rule's invariants on the whole catalog (`checkSelection`);
 * - a frame verify couldn't date (`checkManifestFrames`): caught here, before a Machine is paid for,
 *   never at assembly after the tiles are cut;
 * - a `--cells` key no frame covers (a typo would otherwise build nothing there, quietly);
 * - in anything but a dry run, **a pick whose thumbnail read failed this time**
 *   (`ScoreDeps.unreadable`): an unscored pick is cut as partial, and a re-run that scores it would
 *   decide another build;
 * - in anything but a dry run, **a campaign already published from other inputs**
 *   (`publishedBuild.ts`): its keys are never overwritten, so the change is a new campaign, and the
 *   scratch manifest the published archive was built from is kept as it is.
 */

import {
  isQuarterQuadKey,
  NAIP_EXCLUSIONS,
  NAIP_FOLIAGE_STRIKES,
  NAIP_STATES,
  type NaipCandidate,
  type NaipCatalogItem,
  type NaipCellPick,
  type NaipExclusion,
  type NaipFoliageStrike,
  type NaipManifest,
  type NaipState,
  selectNaipPicks,
} from '@skating/core';
import type { RunLogger } from '@skating/run-log';
import type { CatalogSnapshot } from './catalog';
import { publishedConflict } from './publishedBuild';
import type { ScoreTarget, ThumbnailScore } from './score';
import type { CloudCandidates } from './scoreSheet';
import { cloudCandidates } from './scoreSheet';
import { checkManifestFrames, checkSelection } from './selectChecks';
import {
  buildManifest,
  checkCurrent,
  framesShowing,
  manifestCounts,
  type Narrowing,
  SelectRefusal,
} from './selectManifest';
import { parseCellList, type StageArgs } from './stages';

export { SelectRefusal };

/** The run row, as far as this stage writes it; `null` for a dry run (no row). */
export type SelectRunLog = Pick<RunLogger, 'start' | 'count' | 'flush' | 'succeed' | 'failed'>;

export interface SelectDeps {
  /** The catalog: walked, or the campaign's snapshot read back. Calls `onState` per state. */
  walk: (onState: (state: NaipState, items: number) => void) => Promise<CatalogSnapshot>;
  /** Scores frames (thumbnails); `null` for one that couldn't be scored. */
  score: (targets: readonly ScoreTarget[]) => Promise<Map<string, ThumbnailScore | null>>;
  /**
   * The frames `score` couldn't read this time but a re-run may (`ScoreDeps.unreadable`): a network
   * error, a 5xx, a 429, a 403. Anything but a dry run refuses while a pick is among them.
   */
  unreadable?: ReadonlySet<string>;
  /** The current build's manifest, for `--from-current`. */
  readCurrent: () => Promise<NaipManifest>;
  /**
   * The manifest published under this campaign's own keys, or `null` when nothing is: read in
   * anything but a dry run, before the manifest is written. A read that fails throws (can't tell is
   * never "nothing published").
   */
  readPublished: () => Promise<NaipManifest | null>;
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
  /** The foliage strikes; the committed, reviewed list unless a dry run is handed a proposal. */
  foliageStrikes?: readonly NaipFoliageStrike[];
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
  const foliageStrikes = deps.foliageStrikes ?? NAIP_FOLIAGE_STRIKES;
  const run = deps.run;
  run?.start();
  try {
    const unconfirmed = foliageStrikes.filter((s) => s.reviewedBy !== 'founder');
    if (unconfirmed.length > 0 && !args.dryRun) {
      throw new SelectRefusal(
        'select.unconfirmedStrikes',
        `${unconfirmed.length} foliage strikes await the founder's confirmation: a proposal runs only as a dry run`,
      );
    }
    let narrowing: Narrowing = null;
    if (args.states !== null) narrowing = { states: args.states };
    if (args.cells !== null) {
      const keys = parseCellList(deps.readCellList(args.cells));
      const bad = keys.filter((k) => !isQuarterQuadKey(k));
      if (bad.length > 0)
        throw new SelectRefusal(
          'select.cellsNotQuarterQuads',
          `--cells: not quarter-quads: ${bad.join(', ')}`,
        );
      narrowing = { cells: keys };
    }
    const current = args.fromCurrent ? await deps.readCurrent() : null;
    if (current !== null) checkCurrent(current, { narrowing, pilot: args.pilot });
    // What this campaign has published, read before the walk and the scoring — so a bucket that
    // can't be read refuses before either writes its cache, and the conflict below is decided from a
    // fact already in hand (the eighth review: decide before you write).
    const published = args.dryRun ? null : await deps.readPublished();

    // The per-state counts reach the row with its close, never before: a refused select's row is
    // its open and its failed close (the walk is minutes, its row's only beat was here).
    const snapshot = await deps.walk((state, items) => {
      run?.count(`items${state}`, items);
      deps.log(`[select] ${state}: ${items} items`);
    });
    const candidates = snapshot.items;
    run?.count('items', candidates.length);

    const selection = selectNaipPicks(candidates, exclusions, foliageStrikes);
    run?.count('droppedCoarse', selection.dropped.coarse);
    run?.count('droppedExcluded', selection.dropped.excluded);
    run?.count('droppedOutsideState', selection.dropped.outsideState);
    run?.count('foliageStruck', selection.foliageStruck);
    run?.count('picks', selection.picks.length);
    // The known off-season cells, by name: the run's log says which, the manifest keeps them.
    for (const why of ['noLeafOn', 'allTurned'] as const) {
      const keys = selection.offSeason.filter((c) => c.why === why).map((c) => c.key);
      if (keys.length > 0)
        deps.log(`[select] off-season (${why}), ${keys.length}: ${keys.join(' ')}`);
    }
    const check = (deps.check ?? checkSelection)(candidates, exclusions, selection, foliageStrikes);
    if (check.holes.length > 0) {
      throw new SelectRefusal(
        'select.holes',
        `the exclusion list leaves ${check.holes.length} cells with no frame: ${check.holes.join(', ')}`,
      );
    }
    if (check.violations.length > 0) {
      throw new SelectRefusal(
        'select.invariants',
        `the rule's invariants fail on ${check.violations.length} cells: ${check.violations.slice(0, 20).join('; ')}`,
      );
    }
    if (narrowing !== null && 'cells' in narrowing) {
      const picked = new Set(selection.picks.map((p) => p.key));
      const uncovered = narrowing.cells.filter((k) => !picked.has(k));
      if (uncovered.length > 0) {
        throw new SelectRefusal(
          'select.cellsUncovered',
          `--cells lists cells no frame covers: ${uncovered.join(', ')}`,
        );
      }
    }

    deps.log(`[select] scoring the frames that show (${selection.picks.length} picks first)`);
    const scores = await scoreRounds(selection.picks, deps);
    // **A pick's read that failed this time decides nothing** (PR #188's review). A pick's score is
    // pixel-relevant — an unscored pick is cut as partial, its fallbacks warped too — but a failed
    // read isn't cached: a re-run reads it again, may score it, and so decides another build.
    // Resuming a campaign by running it again (the README's way) then re-cut its work tiles under a
    // live assembler, or refused a published campaign's honest re-run as "other inputs". A
    // fallback's score only steers what else is scored for the cloud sheet, so it is reported, never
    // refused; and a dry run reports every one and goes on.
    const sample = (ids: readonly string[]) =>
      `${ids.slice(0, 5).join(', ')}${ids.length > 5 ? ', …' : ''}`;
    const unreadable = [...(deps.unreadable ?? [])].sort();
    const picked = new Set(selection.picks.map((p) => p.pick.itemId));
    const undecided = unreadable.filter((id) => picked.has(id));
    if (undecided.length > 0 && !args.dryRun) {
      throw new SelectRefusal(
        'select.unreadablePicks',
        `the thumbnails of ${undecided.length} picks couldn't be read this time (${sample(undecided)}): an unscored pick is cut as partial, and a re-run that reads it would decide another build — run the select stage again (the scores are cached, so it reads only these)`,
      );
    }
    if (unreadable.length > 0) {
      deps.log(
        `[select] ${unreadable.length} thumbnails couldn't be read this time, unscored: ${sample(unreadable)}`,
      );
    }
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
      foliageStrikes,
      scores,
      narrowing,
      current,
    });
    const undatable = checkManifestFrames(manifest);
    if (undatable.length > 0) {
      throw new SelectRefusal(
        'select.undatable',
        `${undatable.length} of the manifest's frames can't be dated as verify will date them: ${undatable.slice(0, 20).join('; ')}`,
      );
    }
    if (!args.dryRun) {
      if (published !== null) {
        const conflict = publishedConflict(published, manifest);
        if (conflict !== null) throw new SelectRefusal('published.otherInputs', conflict);
        deps.log(
          `[select] ${args.campaign} is already published from these inputs: nothing changes`,
        );
      }
    }
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
