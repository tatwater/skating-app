/**
 * **The build's record** (B05 §2.1.3): the rule's answer, scored and laid out as work tiles, written
 * as a `NaipManifest`.
 *
 * Three shapes of build, by the flags of §3.1:
 *
 * - **From nothing** (no `--from-current`, no narrowing): every cell, every work tile any cell
 *   touches, all cut.
 * - **Narrowed from nothing** (`--cells` or `--states` without a current build — the pilot): every
 *   cell is recorded, but the archive holds only the work tiles the listed cells touch, all cut. A
 *   work tile the narrowing doesn't reach is not in `workTiles`: there is no archive to copy it from.
 * - **From the current build** (`--from-current`, optionally narrowed): every work tile any cell
 *   touches; one whose input hash equals the current manifest's is copied (`retile: false`), the rest
 *   cut. A narrowing means "consider only these cells changed": a cell outside it keeps the current
 *   build's record — pick, stack, score and all — so its work tiles' hashes stay the current ones and
 *   are copied, and the manifest never claims a stack its pixels weren't cut from.
 */

import {
  NAIP_MANIFEST_VERSION,
  NAIP_RULE_VERSION,
  type NaipCandidate,
  type NaipCellPick,
  type NaipExclusion,
  type NaipFoliageStrike,
  type NaipManifest,
  type NaipManifestCell,
  type NaipManifestFrame,
  type NaipManifestWorkTile,
  type NaipOffSeasonCell,
  type NaipSelection,
  type NaipState,
  naipExclusionsHash,
  naipFoliageStrikesHash,
  naipWorkTileInputHash,
  workTileKey,
  workTilesOf,
} from '@skating/core';
import { manifestName } from './keys';
import { type RefusalId, StageRefusal } from './refusals';
import { FULL_COVERAGE, type ThumbnailScore } from './score';

/** What the stage narrowed the build to (`--states` or `--cells`), if anything. */
export type Narrowing = { states: readonly NaipState[] } | { cells: readonly string[] } | null;

/**
 * The frames of a cell that would show, as far as the scores so far can tell: the pick, then each
 * fallback while everything above it is partial. Stops at the first frame not yet scored (it is
 * scored next round) or the first that covers the cell. `pending` lists what must be scored before
 * the answer is final.
 */
export function framesShowing(
  pick: NaipCellPick,
  scores: ReadonlyMap<string, ThumbnailScore | null>,
): { showing: NaipCandidate[]; pending: NaipCandidate[] } {
  const showing: NaipCandidate[] = [];
  for (const frame of [pick.pick, ...pick.stack]) {
    if (!scores.has(frame.itemId)) return { showing, pending: [frame] };
    showing.push(frame);
    const score = scores.get(frame.itemId);
    // Unscored (no thumbnail) counts as partial: a wrong guess costs a read, never a hole.
    if (score != null && score.valid >= FULL_COVERAGE) break;
  }
  return { showing, pending: [] };
}

/** Is a frame partial by its score? Unscored is partial (see `framesShowing`). */
export const isPartial = (score: ThumbnailScore | null | undefined): boolean =>
  score == null || score.valid < FULL_COVERAGE;

export interface ManifestInput {
  campaign: string;
  pilot: string | null;
  createdAt: string;
  catalog: NaipManifest['catalog'];
  selection: NaipSelection;
  exclusions: readonly NaipExclusion[];
  foliageStrikes: readonly NaipFoliageStrike[];
  scores: ReadonlyMap<string, ThumbnailScore | null>;
  narrowing: Narrowing;
  /** The current build's manifest, under `--from-current`; `null` otherwise. */
  current: NaipManifest | null;
}

const toFrame = (c: NaipCandidate): NaipManifestFrame => ({
  acquired: c.acquired,
  gsd: c.gsd,
  year: c.year,
  state: c.state,
});

/** Does the narrowing reach this cell? (A cell is in a state that lists it.) */
function narrowed(narrowing: Narrowing, key: string, states: readonly NaipState[]): boolean {
  if (narrowing === null) return true;
  if ('cells' in narrowing) return narrowing.cells.includes(key);
  return states.some((s) => narrowing.states.includes(s));
}

/**
 * The current build, checked before anything is read from it: published, this format (a manifest
 * read from the bucket is only cast to the type, and a version-1 one's `offSeasonCells` are bare
 * keys), the same rule when the build is narrowed (a kept cell keeps the current record, so it would
 * carry another rule's pick under this manifest's `ruleVersion`), and the same kind of build (the
 * assembler reads `basedOn` under this build's own prefix; §2.1.3: never a build based on a pilot).
 */
/** A build the select stage won't make. The message is the run row's error and the operator's answer. */
export class SelectRefusal extends StageRefusal {
  override name = 'SelectRefusal';
}

export function checkCurrent(
  current: NaipManifest,
  input: Pick<ManifestInput, 'narrowing' | 'pilot'>,
): void {
  const refuse = (id: RefusalId, why: string): never => {
    throw new SelectRefusal(id, `--from-current: ${current.campaign}'s manifest ${why}`);
  };
  if ((current.version as number) !== NAIP_MANIFEST_VERSION) {
    refuse(
      'select.fromCurrentFormat',
      `is a version-${String(current.version)} manifest; this select stage reads version ${NAIP_MANIFEST_VERSION} — build from nothing`,
    );
  }
  if (current.archive === undefined)
    refuse('select.fromCurrentUnpublished', 'names no archive (it was never published)');
  if (input.narrowing !== null && current.ruleVersion !== NAIP_RULE_VERSION) {
    refuse(
      'select.fromCurrentRule',
      `was built by rule ${current.ruleVersion}, not rule ${NAIP_RULE_VERSION}: a narrowed build would keep its picks — run it whole`,
    );
  }
  const kind = (pilot: string | null) => (pilot === null ? "production's" : `pilot ${pilot}'s`);
  if (current.pilot !== input.pilot) {
    refuse(
      'select.fromCurrentKind',
      `is ${kind(current.pilot)}; this build is ${kind(input.pilot)}`,
    );
  }
}

/** The manifest, from the rule's answer and its scores. Throws on a `current` it can't build from. */
export function buildManifest(input: ManifestInput): NaipManifest {
  const { current, narrowing } = input;
  if (current !== null) checkCurrent(current, input);

  const frames: Record<string, NaipManifestFrame> = {};
  const cells = new Map<string, NaipManifestCell>();

  const fresh = (p: NaipCellPick): NaipManifestCell => {
    for (const f of [p.pick, ...p.stack]) frames[f.itemId] = toFrame(f);
    const score = input.scores.get(p.pick.itemId);
    return {
      key: p.key,
      states: [...p.states],
      pick: p.pick.itemId,
      step: p.step,
      stack: p.stack.map((s) => s.itemId),
      partial: isPartial(score),
      cloudScore: score?.white ?? null,
      workTiles: workTilesOf(p.key).map(workTileKey),
    };
  };
  const kept = (c: NaipManifestCell): NaipManifestCell => {
    for (const id of [c.pick, ...c.stack]) {
      const f = (current as NaipManifest).frames[id];
      if (f === undefined) {
        throw new Error(
          `--from-current: the current manifest names frame ${id} but doesn't hold it`,
        );
      }
      frames[id] = f;
    }
    return { ...c, states: [...c.states], stack: [...c.stack], workTiles: [...c.workTiles] };
  };

  // Which cells are considered changed, and what each cell's record is. `whyOffSeason` follows the
  // record: a fresh cell's from this selection, a kept one's from the current build.
  const considered = new Set<string>();
  const whyOffSeason = new Map<string, NaipOffSeasonCell['why']>([
    ...(current?.offSeasonCells ?? []).map((c) => [c.key, c.why] as const),
  ]);
  const freshWhy = new Map(input.selection.offSeason.map((c) => [c.key, c.why]));
  const freshByKey = new Map(input.selection.picks.map((p) => [p.key, p]));
  const currentByKey = new Map((current?.cells ?? []).map((c) => [c.key, c]));
  for (const key of new Set([...freshByKey.keys(), ...currentByKey.keys()])) {
    const now = freshByKey.get(key);
    const was = currentByKey.get(key);
    const states = [...(now?.states ?? []), ...(was?.states ?? [])];
    const inScope = narrowed(narrowing, key, states);
    if (inScope) considered.add(key);
    if (current !== null && !inScope) {
      if (was !== undefined) cells.set(key, kept(was));
      continue; // not considered: the current build's answer stands, or the cell stays out
    }
    if (now !== undefined) {
      cells.set(key, fresh(now));
      const why = freshWhy.get(key);
      if (why === undefined) whyOffSeason.delete(key);
      else whyOffSeason.set(key, why);
    }
  }

  // The work tiles: which the archive holds, and which are cut.
  const byTile = new Map<string, NaipManifestCell[]>();
  for (const cell of cells.values()) {
    for (const t of cell.workTiles) byTile.set(t, [...(byTile.get(t) ?? []), cell]);
  }
  const currentHash = new Map((current?.workTiles ?? []).map((w) => [w.key, w.inputHash]));
  const workTiles: NaipManifestWorkTile[] = [];
  for (const [key, tileCells] of byTile) {
    const reached = tileCells.some((c) => considered.has(c.key));
    // Narrowed from nothing: only what the narrowing reaches is built.
    if (current === null && !reached) continue;
    const inputHash = naipWorkTileInputHash(key, tileCells, NAIP_RULE_VERSION);
    workTiles.push({
      key,
      inputHash,
      cells: tileCells.map((c) => c.key).sort(),
      retile: current === null || currentHash.get(key) !== inputHash,
    });
  }
  workTiles.sort((a, b) => (a.key < b.key ? -1 : 1));

  return {
    version: NAIP_MANIFEST_VERSION,
    campaign: input.campaign,
    pilot: input.pilot,
    createdAt: input.createdAt,
    ruleVersion: NAIP_RULE_VERSION,
    catalog: input.catalog,
    exclusionsHash: naipExclusionsHash(input.exclusions),
    foliageStrikesHash: naipFoliageStrikesHash(input.foliageStrikes),
    // Every off-season cell has its why: a fresh one from this selection, a kept one from the
    // current build (the same format and rule, `checkCurrent`).
    offSeasonCells: [...cells.values()]
      .filter((c) => c.step === 'offSeason')
      .map((c) => {
        const why = whyOffSeason.get(c.key);
        if (why === undefined) {
          throw new Error(
            `--from-current: the current manifest's off-season cell ${c.key} has no why`,
          );
        }
        return { key: c.key, why };
      })
      .sort((a, b) => (a.key < b.key ? -1 : 1)),
    basedOn:
      current === null
        ? null
        : {
            archive: (current.archive as { name: string }).name,
            manifest: manifestName(current.campaign),
          },
    frames: Object.fromEntries(Object.entries(frames).sort(([a], [b]) => (a < b ? -1 : 1))),
    cells: [...cells.values()].sort((a, b) => (a.key < b.key ? -1 : 1)),
    workTiles,
  };
}

/** The run's counts over a manifest (§2.1.3), named as the run row stores them. */
export function manifestCounts(manifest: NaipManifest): Record<string, number> {
  const counts: Record<string, number> = {
    cells: manifest.cells.length,
    frames: Object.keys(manifest.frames).length,
    workTiles: manifest.workTiles.length,
    workTilesCut: manifest.workTiles.filter((w) => w.retile).length,
    pickedLeafOn: manifest.cells.filter((c) => c.step === 'leafOn').length,
    pickedOffSeason: manifest.cells.filter((c) => c.step === 'offSeason').length,
    offSeasonNoLeafOn: manifest.offSeasonCells.filter((c) => c.why === 'noLeafOn').length,
    offSeasonAllTurned: manifest.offSeasonCells.filter((c) => c.why === 'allTurned').length,
    partial: manifest.cells.filter((c) => c.partial).length,
    unscored: manifest.cells.filter((c) => c.cloudScore === null).length,
    borderCells: manifest.cells.filter((c) => c.states.length > 1).length,
  };
  return counts;
}
