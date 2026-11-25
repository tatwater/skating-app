/**
 * Undo handlers for the Body console's levers: a body's identity, water, access ruling, standing and removal; sub-areas; landmarks (D226, B01 §11). Composed into `UNDO_HANDLERS` by `undoHandlers.ts`;
 * the shapes are `undoTypes.ts`'s.
 *
 * Every handler runs the forward verb's own helper with the value the row recorded as `prev`, so the
 * side effects run again: a boost re-scores and re-cells, a ruling re-derives standing, a redraw
 * re-stamps reports and hazards, a restore re-clips. Nothing here patches a row back by hand.
 */

import {
  type BodyStanding,
  type DepthSource,
  distanceToPolygonMeters,
  type LatLng,
  MAX_LANDMARKS_PER_BODY,
  normalizeLandmarkNames,
  OPERATOR_PUT_IN_SNAP_MAX_M,
  standingOf,
} from '@skating/core';
import { ConvexError } from 'convex/values';
import type { MultiPolygon, Polygon } from 'geojson';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import {
  lotRemovalRefusalOf,
  relinkRefusalOf,
  removeOfficialLotImpl,
  setOfficialParkingImpl,
  setPutInAccessImpl,
} from '../accessPoints';
import { setOverrideImpl } from '../imageryOverrides';
import {
  type LandmarkEditPrev,
  type LandmarkRestorePrev,
  removeLandmarkImpl,
  restoreLandmarkImpl,
  unrestoreLandmarkImpl,
  updateLandmarkImpl,
} from '../landmarks';
import {
  bodyAlerts,
  demotePutInImpl,
  directionRefusal,
  hiddenLaunches,
  launchRefusalOf,
  PLACEMENT_ALERTS_READ,
  PLACEMENT_ALERTS_UNCHECKED,
  placementPhoto,
  placementRefusalOf,
  placePutInImpl,
  promotePutInImpl,
  SUPPRESSION_ROWS_READ,
  unplacePutInImpl,
} from '../putIns';
import { setStandingImpl } from '../standing';
import {
  type RedrawSnapshot,
  redrawSubAreaImpl,
  removeSubAreaImpl,
  renameSubAreaImpl,
  restoreSubAreaImpl,
  setSubAreaCuratedBoostImpl,
} from '../subAreas';
import {
  chooseDepthSourceImpl,
  type DepthFields,
  depthChoiceOutcome,
  editRefusal,
  removeBodyImpl,
  restoreBodyImpl,
  restoreDepthImpl,
  returnToReviewImpl,
  returnToReviewRefusal,
  reviewAgainRefusal,
  reviewDrawnBodyImpl,
  samplePointsRefusal,
  setAliasesImpl,
  setClassImpl,
  setCuratedBoostImpl,
  setIncludedByRequestImpl,
  setModeratorTownsImpl,
  setPublicAccessImpl,
  setReferenceLinksImpl,
  setSatelliteImageryImpl,
  setWaterBodyNameImpl,
  setWeatherSamplePointsImpl,
} from '../waterBodies';
import { type ModerationAction, type ModerationTargetType, readSnapshot } from './audit';
import { resolveSurvivor } from './bodies';
import { NAMES_NEED_THE_BAY, nameListRefusal } from './bodyNames';
import { reopenFlagsClosedBy } from './inboxFlags';
import {
  landmarkEditRefusal,
  liveBaysForNaming,
  liveLandmarksForBody,
  retireAsPromoted,
} from './landmarkRows';
import { listChangedRefusal } from './listCas';
import { ROW_MAX } from './readBudget';
import { UNDO_POLICY } from './undoPolicy';
import { UNDO_CHECKED_ELSEWHERE } from './undoReads';
import {
  meta,
  NOTHING_TO_UNDO,
  PREDATES,
  type TargetUndo,
  type UndoCall,
  type UndoHandler,
} from './undoTypes';

/** Rows that recorded no `prev` predate undo (D226); everything here needs one. */
const needsPrev = (row: Doc<'moderationActions'>): string | null =>
  meta(row).prev === undefined ? PREDATES : null;

const never = () => false;

/** The snapshot a row's undo needs, or the refusal a missing one means. */
async function snapshotOf<T>(call: UndoCall): Promise<T> {
  const payload = await readSnapshot<T>(call.ctx, call.row._id);
  if (payload === null) throw new ConvexError(PREDATES);
  return payload;
}

// ── A body's identity and water ───────────────────────────────────────────────────────────────────

type Dormancy = NonNullable<Doc<'waterBodies'>['dormant']>;

/** set_curated_boost → the boost it replaced; on a body it reactivated, the dormancy it cleared too. */
const undoCuratedBoost: UndoHandler = {
  blocked: needsPrev,
  undoTakesAway: (row) => {
    const prev = meta(row).prev as { curatedBoost: number | null; dormant?: Dormancy };
    return (
      UNDO_POLICY.set_curated_boost.takesAway(prev.curatedBoost) ||
      (prev.dormant !== undefined && UNDO_POLICY.set_standing.takesAway('dormant'))
    );
  },
  run: async ({ ctx, actor, row, reason }) => {
    const prev = meta(row).prev as { curatedBoost: number | null; dormant?: Dormancy };
    const curatedBoost = prev.curatedBoost ?? undefined;
    if (row.targetType === 'waterBodySubArea') {
      await setSubAreaCuratedBoostImpl(ctx, actor, {
        subAreaId: row.targetId as Id<'waterBodySubAreas'>,
        curatedBoost,
        reason,
      });
      return;
    }
    const waterBodyId = row.targetId as Id<'waterBodies'>;
    await setCuratedBoostImpl(ctx, actor, { waterBodyId, curatedBoost, reason });
    // The boost brought a shelved body back; its undo shelves it again, for the reason it had.
    if (prev.dormant !== undefined) {
      await setStandingImpl(ctx, actor, {
        waterBodyId,
        standing: 'dormant',
        dormancyReason: prev.dormant.reason,
        ...(prev.dormant.note !== undefined ? { note: prev.dormant.note } : {}),
        reason,
      });
    }
  },
};

/** set_reference_links → the list it replaced. */
const undoReferenceLinks: UndoHandler = {
  blocked: needsPrev,
  undoTakesAway: (row) => UNDO_POLICY.set_reference_links.takesAway(meta(row).prev.referenceLinks),
  // A merge carries a loser's list to its survivor with no row on the survivor: an undo that would put
  // back a list that has moved since is refused, so never offered (B01-3g).
  refusal: async (ctx, row, read) => {
    const id = ctx.db.normalizeId('waterBodies', row.targetId);
    const body = id ? await read.row('waterBody', id) : null;
    const refused = editRefusal(body);
    if (refused !== null || body === null) return refused;
    return listChangedRefusal(
      body.referenceLinks ?? [],
      meta(row).referenceLinks ?? [],
      'this body’s reference links',
    );
  },
  run: ({ ctx, actor, row, reason }) =>
    setReferenceLinksImpl(ctx, actor, {
      waterBodyId: row.targetId as Id<'waterBodies'>,
      links: meta(row).prev.referenceLinks as { label: string; url: string }[],
      // The undo is the same compare-and-set: refused if the list moved since this row wrote it.
      expected: meta(row).referenceLinks as { label: string; url: string }[],
      reason,
    }).then(() => undefined),
};

/**
 * set_water_body_name → the name it replaced: picked again when it was a moderator's claim, the
 * override cleared when it was the catalogs' own ranking. Rows from before `prev.overridden` can't
 * tell the two apart.
 */
const undoWaterBodyName: UndoHandler = {
  blocked: (row) => (meta(row).prev?.overridden === undefined ? PREDATES : null),
  undoTakesAway: (row) => UNDO_POLICY.set_water_body_name.takesAway(meta(row).prev.name),
  run: async ({ ctx, actor, row, reason }) => {
    const prev = meta(row).prev as { name: string; overridden: boolean };
    await setWaterBodyNameImpl(ctx, actor, {
      waterBodyId: row.targetId as Id<'waterBodies'>,
      name: prev.overridden ? prev.name : null,
      reason,
    });
  },
};

/**
 * set_lake_depth (a reading, a rejection or a release) → the depth fields as they stood — only while
 * the body still reads what this write left. The A06a import refills a released measurement without
 * an audit row, so "a later write means no undo" can't see it in the log; the row's `after` is what
 * lets the undo see it on the body, and refuse rather than throw a newer import's numbers away.
 */
const undoLakeDepth: UndoHandler = {
  blocked: (row) =>
    meta(row).prev === undefined || meta(row).after === undefined ? PREDATES : null,
  undoTakesAway: (row) => UNDO_POLICY.set_lake_depth.takesAway(meta(row).prev),
  run: ({ ctx, actor, row, reason }) =>
    restoreDepthImpl(ctx, actor, {
      waterBodyId: row.targetId as Id<'waterBodies'>,
      fields: meta(row).prev as Partial<DepthFields>,
      expected: meta(row).after as Partial<DepthFields>,
      reason,
    }),
};

/** set_satellite_imagery → the mode it replaced (`auto` when none was stored). */
const undoSatelliteImagery: UndoHandler = {
  blocked: needsPrev,
  undoTakesAway: (row) =>
    UNDO_POLICY.set_satellite_imagery.takesAway(meta(row).prev.satelliteImagery),
  run: async ({ ctx, actor, row, reason }) => {
    await setSatelliteImageryImpl(ctx, actor, {
      waterBodyId: row.targetId as Id<'waterBodies'>,
      mode: meta(row).prev.satelliteImagery,
      reason,
    });
  },
};

/** set_weather_sample_points → the grid it replaced, from the snapshot. */
const undoWeatherSamplePoints: UndoHandler = {
  blocked: (row) => (meta(row).prev?.snapshot === true ? null : PREDATES),
  undoTakesAway: () => UNDO_POLICY.set_weather_sample_points.takesAway(),
  // The grid it puts back has to be on the outline as it stands: a redraw or a re-import moves it.
  refusalCost: () => ({ bytes: ROW_MAX.waterBody + ROW_MAX.pointsSnapshot, reads: 2 }),
  refusal: async (ctx, row, read) => {
    const id = ctx.db.normalizeId('waterBodies', row.targetId);
    const body = id ? await read.row('waterBody', id) : null;
    if (body === null) return 'Water body not found';
    const prev = await read.snapshot<{ weatherSamplePoints: { lat: number; lng: number }[] }>(
      'pointsSnapshot',
      row._id,
    );
    if (prev === null) return PREDATES;
    // A grid is always one stored document; one split in parts isn't this verb's to check here.
    if (prev === 'parts') return UNDO_CHECKED_ELSEWHERE;
    return samplePointsRefusal(body, prev.weatherSamplePoints);
  },
  run: async (call) => {
    const { weatherSamplePoints } = await snapshotOf<{
      weatherSamplePoints: { lat: number; lng: number }[];
    }>(call);
    await setWeatherSamplePointsImpl(call.ctx, call.actor, {
      waterBodyId: call.row.targetId as Id<'waterBodies'>,
      points: weatherSamplePoints,
      reason: call.reason,
    });
  },
};

/**
 * set_public_access → the ruling it replaced, ruled again. Its standing follows as it does for any
 * ruling — and an `open` ruling that brought a shelved body back shelves it again, for the reason it
 * had, as a boost's undo does. The reports the ruling closed reopen, and their Inbox item with them.
 */
const undoPublicAccess: UndoHandler = {
  blocked: needsPrev,
  undoTakesAway: (row) => {
    const prev = meta(row).prev as { publicAccess: unknown; dormant?: Dormancy };
    return (
      UNDO_POLICY.set_public_access.takesAway(prev.publicAccess) ||
      (prev.dormant !== undefined && UNDO_POLICY.set_standing.takesAway('dormant'))
    );
  },
  run: async ({ ctx, actor, row, reason }) => {
    const { publicAccess: prev, dormant } = meta(row).prev as {
      publicAccess: Doc<'waterBodies'>['publicAccess'] | null;
      dormant?: Dormancy;
    };
    const waterBodyId = row.targetId as Id<'waterBodies'>;
    await setPublicAccessImpl(ctx, actor, {
      waterBodyId,
      verdict: prev?.verdict ?? null,
      ...(prev?.note !== undefined ? { note: prev.note } : {}),
      reason,
    });
    const after = await ctx.db.get(waterBodyId);
    if (dormant !== undefined && after && standingOf(after).standing === 'active') {
      await setStandingImpl(ctx, actor, {
        waterBodyId,
        standing: 'dormant',
        dormancyReason: dormant.reason,
        ...(dormant.note !== undefined ? { note: dormant.note } : {}),
        reason,
      });
    }
    // The reports this ruling closed reopen with it, and their Inbox item (B01-5).
    await reopenFlagsClosedBy(ctx, actor, row._id, reason, { withUndoOf: true });
  },
};

/** set_included_by_request → the flag it replaced. A body admitted on a request undoes with it. */
const undoIncludedByRequest: UndoHandler = {
  blocked: (row) => {
    if (meta(row).requestId !== undefined) {
      return "This body was admitted from the catalog on a skater's request; reopening the request in the Inbox undoes it.";
    }
    return needsPrev(row);
  },
  undoTakesAway: (row) =>
    UNDO_POLICY.set_included_by_request.takesAway(meta(row).prev.includedByRequest),
  run: async ({ ctx, actor, row, reason }) => {
    const body = await ctx.db.get(row.targetId as Id<'waterBodies'>);
    if (!body) throw new ConvexError('Water body not found');
    await setIncludedByRequestImpl(ctx, actor._id, {
      body,
      included: meta(row).prev.includedByRequest === true,
      reason,
    });
  },
};

// ── Standing ──────────────────────────────────────────────────────────────────────────────────────

/**
 * set_standing, activate_body, demote_body → the standing it replaced, through `setStanding`'s own
 * helper: shelved again for the reason it was shelved, or brought back. A `no_public_access`
 * dormancy belongs to the access ruling, and a removal to remove/restore; neither is this lever's.
 *
 * The reason rule reads the standing the undo puts back for all three (the registry's `set_standing`
 * rule): `activate_body` and `demote_body` record no value of their own to weigh.
 */
const undoStanding: UndoHandler = {
  blocked: (row) => {
    const { prev, next } = meta(row) as { prev?: BodyStanding; next?: BodyStanding };
    if (prev === undefined || next === undefined) return PREDATES;
    const reasons = [prev, next].map((s) => ('reason' in s ? s.reason : undefined));
    if (reasons.includes('no_public_access')) {
      return 'A no-public-access ruling decides this standing; change the access ruling instead.';
    }
    const kinds = [prev.standing, next.standing];
    if (kinds.includes('removed') || kinds.includes('unlisted')) {
      return 'This came with a removal or a merge; undo that instead.';
    }
    if (prev.standing === next.standing) return 'Nothing changed: the standing was already this.';
    return null;
  },
  undoTakesAway: (row) =>
    UNDO_POLICY.set_standing.takesAway((meta(row).prev as BodyStanding).standing),
  run: async ({ ctx, actor, row, reason }) => {
    const prev = meta(row).prev as BodyStanding;
    const waterBodyId = row.targetId as Id<'waterBodies'>;
    if (prev.standing === 'dormant' && prev.reason !== 'no_public_access') {
      await setStandingImpl(ctx, actor, {
        waterBodyId,
        standing: 'dormant',
        dormancyReason: prev.reason,
        ...(prev.note !== undefined ? { note: prev.note } : {}),
        reason,
      });
    } else {
      await setStandingImpl(ctx, actor, { waterBodyId, standing: 'active', reason });
    }
  },
};

// ── A drawn body's review (B01-5) ─────────────────────────────────────────────────────────────────

/** The review an approval or a rejection made. */
const reviewMadeBy = (row: Doc<'moderationActions'>): 'approved' | 'rejected' =>
  row.action === 'approve_waterbody' ? 'approved' : 'rejected';

/**
 * approve_waterbody / reject_waterbody → back to pending review (`return_to_review`), listed again as
 * a pending body is. Asks no reason: pending takes nothing away. The body as it stands is read for
 * the offer and the write alike (`returnToReviewRefusal`): reviewed again, or merged, says no.
 */
const undoReview: UndoHandler = {
  undoTakesAway: () => UNDO_POLICY.return_to_review.takesAway('pending'),
  refusalCost: () => ({ bytes: ROW_MAX.waterBody, reads: 1 }),
  refusal: async (_ctx, row, read, viewer) =>
    returnToReviewRefusal(
      await read.row('waterBody', waterBodyIdOf(row)),
      reviewMadeBy(row),
      viewer._id,
    ),
  run: async ({ ctx, actor, row, reason }) => {
    await returnToReviewImpl(ctx, actor, {
      waterBodyId: waterBodyIdOf(row),
      from: reviewMadeBy(row),
      reason,
      undoes: row._id,
    });
  },
};

/**
 * return_to_review → reviewed again as the row it took back had it: approved, or rejected (which
 * takes the drawing off the map, so it asks why).
 */
const undoReturnToReview: UndoHandler = {
  blocked: (row) => (meta(row).prev?.reviewStatus === undefined ? PREDATES : null),
  // The review's own rule, as its write asks it (`reviewDrawnBodyImpl`): still pending, not merged,
  // and never the drawer's to review (D289) — so History offers only what the write accepts.
  refusalCost: () => ({ bytes: ROW_MAX.waterBody, reads: 1 }),
  refusal: async (_ctx, row, read, viewer) =>
    reviewAgainRefusal(await read.row('waterBody', waterBodyIdOf(row)), viewer._id),
  undoTakesAway: (row) => UNDO_POLICY.return_to_review.takesAway(meta(row).prev.reviewStatus),
  run: async ({ ctx, actor, row, reason }) => {
    await reviewDrawnBodyImpl(ctx, actor, {
      waterBodyId: waterBodyIdOf(row),
      verdict: meta(row).prev.reviewStatus as 'approved' | 'rejected',
      reason,
    });
  },
};

const waterBodyIdOf = (row: Doc<'moderationActions'>) => row.targetId as Id<'waterBodies'>;

// ── Sub-areas ─────────────────────────────────────────────────────────────────────────────────────

const subAreaId = (row: Doc<'moderationActions'>) => row.targetId as Id<'waterBodySubAreas'>;

/**
 * create_sub_area → delisted, through `remove`; and the landmarks the bay retired when it was drawn
 * (D202 — the one it was drawn from in Places, or one its name claimed) come back, through the
 * landmark's own restore (founder call 2026-11-25): undoing the bay must not take the place off the
 * map with it. See {@link restoreLandmarksRetiredBy}.
 */
const undoCreateSubArea: UndoHandler = {
  undoTakesAway: () => UNDO_POLICY.create_sub_area.takesAway(),
  run: async ({ ctx, actor, row, reason }) => {
    await removeSubAreaImpl(ctx, actor, { subAreaId: subAreaId(row), reason });
    await restoreLandmarksRetiredBy(ctx, actor, row);
  },
};

/**
 * Bring back the landmarks the bay retired at or after `row` and still holds retired — each one's
 * newest row the bay's `promote_landmark` — so one a person removed since stays removed. One a
 * write's rule now refuses (another bay names it, the lake is at its cap) stays retired, and the
 * bay's undo still lands. Each restore names the bay (`withBay`), so the bay's return can retire it
 * again ({@link reRetireLandmarksRestoredWith}).
 *
 * Only the removals since `row` are read, the oldest first — a bay's own come first, so removals made
 * later (a catalog run's drops) can neither push them past the read's bound nor cost the undo a read
 * of the lake's whole history.
 */
async function restoreLandmarksRetiredBy(
  ctx: MutationCtx,
  actor: Doc<'profiles'>,
  row: Doc<'moderationActions'>,
): Promise<void> {
  const bay = await ctx.db.get(subAreaId(row));
  if (!bay) return;
  const removedSince = await ctx.db
    .query('bodyLandmarks')
    .withIndex('by_water_body_removed', (q) =>
      q.eq('waterBodyId', bay.waterBodyId).gte('removedAt', row.createdAt),
    )
    .take(MAX_LANDMARKS_PER_BODY);
  for (const landmark of removedSince) {
    const newest = await ctx.db
      .query('moderationActions')
      .withIndex('by_target', (q) =>
        q.eq('targetType', 'bodyLandmark').eq('targetId', landmark._id),
      )
      .order('desc')
      .first();
    if (newest?.action !== 'promote_landmark' || meta(newest).subAreaId !== bay._id) continue;
    try {
      await restoreLandmarkImpl(ctx, actor, {
        landmarkId: landmark._id,
        reason: `Back on the map: the bay that replaced "${landmark.name}" was undone`,
        withBay: bay._id,
      });
    } catch (error) {
      // The restore refuses before it writes, so a refusal leaves nothing half done.
      if (!(error instanceof ConvexError)) throw error;
    }
  }
}

/**
 * The other direction: a bay coming back by an undo of its removal retires again the landmarks that
 * removal's undo-run brought back — the landmark restores written in the same transaction as `row`
 * (one clock, so at its `createdAt`) naming this bay — while each is still live and that restore is
 * still its newest row. A bay restored by hand meets no such rows and retires only what its name
 * claims, as any restore does.
 */
async function reRetireLandmarksRestoredWith(
  ctx: MutationCtx,
  actor: Doc<'profiles'>,
  row: Doc<'moderationActions'>,
): Promise<void> {
  const bay = await ctx.db.get(subAreaId(row));
  if (!bay || bay.removedAt !== undefined) return;
  const sameWrite = await ctx.db
    .query('moderationActions')
    .withIndex('by_created_at', (q) => q.eq('createdAt', row.createdAt))
    .take(UNDO_SAME_WRITE_ROWS);
  for (const restore of sameWrite) {
    if (restore.targetType !== 'bodyLandmark' || restore.action !== 'restore') continue;
    if (meta(restore).withBay !== bay._id) continue;
    const id = restore.targetId as Id<'bodyLandmarks'>;
    const landmark = await ctx.db.get(id);
    if (!landmark || landmark.removedAt !== undefined) continue;
    const newest = await ctx.db
      .query('moderationActions')
      .withIndex('by_target', (q) => q.eq('targetType', 'bodyLandmark').eq('targetId', id))
      .order('desc')
      .first();
    if (newest?._id !== restore._id) continue;
    await retireAsPromoted(ctx, actor._id, id, bay.waterBodyId, bay._id);
  }
}

/**
 * The most audit rows one transaction is read for: a bay's removal, and a landmark restore for each
 * landmark it had retired — a handful in practice; a lake's whole landmark cap at worst.
 */
const UNDO_SAME_WRITE_ROWS = MAX_LANDMARKS_PER_BODY + 8;

/** redraw_sub_area → the outline (and mouth) it replaced, through the redraw path, re-stamping. */
const undoRedrawSubArea: UndoHandler = {
  blocked: (row) => (meta(row).prev?.snapshot === true ? null : PREDATES),
  undoTakesAway: () => UNDO_POLICY.redraw_sub_area.takesAway(),
  run: async (call) => {
    const prev = await snapshotOf<RedrawSnapshot>(call);
    await redrawSubAreaImpl(call.ctx, call.actor, {
      subAreaId: subAreaId(call.row),
      polygon: prev.polygon,
      mouth: prev.mouth,
      reason: call.reason,
    });
  },
};

/** rename_sub_area → the name and aliases it replaced. */
const undoRenameSubArea: UndoHandler = {
  blocked: needsPrev,
  undoTakesAway: (row) => UNDO_POLICY.rename_sub_area.takesAway(meta(row).prev),
  run: async ({ ctx, actor, row, reason }) => {
    const prev = meta(row).prev as { name: string; aliases: string[] };
    const after = meta(row).aliases as string[] | undefined;
    await renameSubAreaImpl(ctx, actor, {
      subAreaId: subAreaId(row),
      name: prev.name,
      aliases: prev.aliases,
      // The same compare-and-set as the edit: refused if the bay's aliases moved since.
      ...(after !== undefined ? { expectedAliases: after } : {}),
      reason,
    });
  },
};

const SUB_AREA: TargetUndo = {
  /** A delist → restored (re-clipped against today's outline, as any restore is). */
  remove: {
    blocked: (row) =>
      meta(row).automatic === true
        ? 'The system delisted this when its lake changed; redraw it to fit, then restore it.'
        : null,
    undoTakesAway: never,
    run: async ({ ctx, actor, row, reason }) => {
      await restoreSubAreaImpl(ctx, actor, { subAreaId: subAreaId(row), reason });
      // A removal that was a bay's undo brought its landmarks back; the bay's return retires them.
      await reRetireLandmarksRestoredWith(ctx, actor, row);
    },
  },
  /** A restore → delisted again, and the landmarks its return retired back on the map. */
  restore: {
    undoTakesAway: () => true,
    run: async ({ ctx, actor, row, reason }) => {
      await removeSubAreaImpl(ctx, actor, { subAreaId: subAreaId(row), reason });
      await restoreLandmarksRetiredBy(ctx, actor, row);
    },
  },
};

// ── Landmarks ─────────────────────────────────────────────────────────────────────────────────────

const landmarkId = (row: Doc<'moderationActions'>) => row.targetId as Id<'bodyLandmarks'>;

/** create_landmark → removed. */
const undoCreateLandmark: UndoHandler = {
  undoTakesAway: () => UNDO_POLICY.create_landmark.takesAway(),
  run: async ({ ctx, actor, row, reason }) => {
    await removeLandmarkImpl(ctx, actor, { landmarkId: landmarkId(row), reason });
  },
};

/**
 * Why a landmark's undo is refused on a clash its write's rule found — what clashed; and, when the
 * refusal comes from running it (`runUndo`, which a list of changes may have offered), that a list
 * can't check this in advance (B01-3h).
 */
export function undoClashRefusal(clash: string, fromRun: boolean): string {
  const base = `${clash.replace(/\.$/, '')}, so this undo can’t bring the old name back`;
  return fromRun ? `${base} — a list of changes can’t check that in advance.` : `${base}.`;
}

/**
 * A list's answer when a bay on the lake answers to one of the old names: the bay's outline decides
 * whether it names that point (`bayNaming`), and a list reads no outline — so it says where to look,
 * never a guess (B01-3u).
 */
export const UNDO_BAY_NAME_ON_LANDMARK =
  'A bay on this lake answers to the old name — open this landmark to see whether this undo can bring it back.';

/** edit_landmark → the name, aliases, kind and point it replaced. */
const undoEditLandmark: UndoHandler = {
  blocked: (row) => {
    if (meta(row).corpusName !== undefined) {
      return 'This spelling came from the place-names queue; edit the landmark to take it off.';
    }
    return needsPrev(row);
  },
  undoTakesAway: (row) => UNDO_POLICY.edit_landmark.takesAway(meta(row).prev),
  // A merge's fold and a catalog run change a landmark's spellings with no row on it: the undo
  // compares the spellings the edit left with the landmark as it stands (B01-3d). Where one landmark
  // is in view (the toast, its own history, `runUndo`), the edit's own rule runs too — a landmark
  // already there under the old names, or a bay that answers to one (B01-3h). **A list page reads
  // the body's short list of names instead** (`lib/bodyNames`, B01-3u): the duplicate rule exactly,
  // and a bay answering to an old name sends the reader to the landmark. A body whose list isn't
  // built yet, or is capped, keeps the spellings-only check (the write still runs the whole rule).
  refusalCost: (scope) =>
    scope === 'list'
      ? { bytes: ROW_MAX.landmark + ROW_MAX.bodyNames, reads: 2 }
      : { bytes: ROW_MAX.landmark, reads: 1 },
  refusal: async (ctx, row, read) => {
    const id = ctx.db.normalizeId('bodyLandmarks', row.targetId);
    const current = id ? await read.row('landmark', id) : null;
    if (current === null) return 'That landmark no longer exists';
    const spellings = listChangedRefusal(
      current.aliases,
      meta(row).aliases as string[] | undefined,
      'this landmark’s other spellings',
    );
    // `runUndo` leaves the rule to the write it runs, which reads the lists once and says a clash
    // plainly (`clashMessage`) — never twice in one mutation.
    if (spellings !== null || 'insert' in ctx.db) return spellings;
    const prev = meta(row).prev as LandmarkEditPrev;
    const names = normalizeLandmarkNames(prev.name, prev.aliases);
    if (names === null) return null;
    if (read.scope === 'list') {
      const list = await read.bodyNames(current.waterBodyId);
      const answer =
        list === null
          ? undefined
          : nameListRefusal(list, { kind: prev.kind, point: prev.point, ...names }, current._id);
      if (answer === undefined || answer === null) return null;
      return answer === NAMES_NEED_THE_BAY
        ? UNDO_BAY_NAME_ON_LANDMARK
        : undoClashRefusal(answer, false);
    }
    // Where one landmark is in view: the whole rule, uncharged, as the edit reads it.
    const clash = landmarkEditRefusal(
      await liveLandmarksForBody(ctx, current.waterBodyId),
      await liveBaysForNaming(ctx, current.waterBodyId),
      { kind: prev.kind, point: prev.point, ...names },
      current._id,
    );
    return clash === null ? null : undoClashRefusal(clash, false);
  },
  run: async ({ ctx, actor, row, reason }) => {
    const prev = meta(row).prev as LandmarkEditPrev;
    const after = meta(row).aliases as string[] | undefined;
    const current = await ctx.db.get(landmarkId(row));
    if (!current) throw new ConvexError('That landmark no longer exists');
    const moved = current.point.lat !== prev.point.lat || current.point.lng !== prev.point.lng;
    await updateLandmarkImpl(ctx, actor, {
      landmarkId: landmarkId(row),
      name: prev.name,
      aliases: prev.aliases,
      ...(after !== undefined ? { expectedAliases: after } : {}),
      clashMessage: (clash) => undoClashRefusal(clash, true),
      kind: prev.kind,
      // Only a point that moved goes back, so an unmoved one keeps its bay stamp and its row says so.
      ...(moved ? { point: prev.point } : {}),
      reason,
    });
  },
};

const LANDMARK: TargetUndo = {
  /** A removal → restored. One a merge folded into another label undoes with the merge. */
  remove: {
    blocked: (row) =>
      meta(row).mergedIntoId !== undefined
        ? 'A merge folded this into another landmark; it comes back with the merge.'
        : null,
    undoTakesAway: never,
    run: async ({ ctx, actor, row, reason }) => {
      await restoreLandmarkImpl(ctx, actor, { landmarkId: landmarkId(row), reason });
    },
  },
  /**
   * A restore → retired again exactly as it was: the catalogs' drop, a merge's fold, or a person's
   * removal, with the removal time and ownership it had. A restore from before `prev` can't say
   * which, so it is refused rather than turned into a person's removal.
   */
  restore: {
    blocked: needsPrev,
    undoTakesAway: () => true,
    run: async ({ ctx, actor, row, reason }) => {
      await unrestoreLandmarkImpl(ctx, actor, {
        landmarkId: landmarkId(row),
        prev: meta(row).prev as LandmarkRestorePrev,
        reason,
      });
    },
  },
};

// ── A body's removal ──────────────────────────────────────────────────────────────────────────────

const waterBodyId = (row: Doc<'moderationActions'>) => row.targetId as Id<'waterBodies'>;

const WATER_BODY: TargetUndo = {
  /** A removal → restored, which is an activation like any restore (A07b). */
  remove: {
    undoTakesAway: never,
    run: async ({ ctx, actor, row, reason }) => {
      await restoreBodyImpl(ctx, actor, { waterBodyId: waterBodyId(row), note: reason });
    },
  },
  /** A restore → removed again, for the reason it was removed. */
  restore: {
    blocked: needsPrev,
    undoTakesAway: () => true,
    run: async ({ ctx, actor, row, reason }) => {
      await removeBodyImpl(ctx, actor, {
        waterBodyId: waterBodyId(row),
        reason: meta(row).prev.removalReason,
        auditReason: reason,
      });
    },
  },
};

/** set_aliases → the list it replaced, through the same write (and its refusals). */
const undoAliases: UndoHandler = {
  blocked: needsPrev,
  undoTakesAway: () => UNDO_POLICY.set_aliases.takesAway(undefined),
  // A merge carries a loser's list to its survivor with no row on the survivor: an undo that would put
  // back a list that has moved since is refused, so never offered (B01-3g).
  refusal: async (ctx, row, read) => {
    const id = ctx.db.normalizeId('waterBodies', row.targetId);
    const body = id ? await read.row('waterBody', id) : null;
    const refused = editRefusal(body);
    if (refused !== null || body === null) return refused;
    return listChangedRefusal(
      body.moderatorAliases ?? [],
      meta(row).moderatorAliases ?? [],
      'this body’s aliases',
    );
  },
  run: ({ ctx, actor, row, reason }) =>
    setAliasesImpl(ctx, actor, {
      waterBodyId: row.targetId as Id<'waterBodies'>,
      aliases: (meta(row).prev.moderatorAliases as string[] | undefined) ?? [],
      expected: (meta(row).moderatorAliases as string[] | undefined) ?? [],
      reason,
    }).then(() => undefined),
};

/**
 * set_moderator_towns → the pinned towns it replaced, through the same write. Refused (never offered)
 * when the body was merged away or its pins moved since — a merge folds a loser's pins into its
 * survivor with no row on the survivor, so the list it would put back may no longer follow.
 */
const undoModeratorTowns: UndoHandler = {
  // A row written before D270 that set the list it found changed nothing: nothing to put back.
  blocked: (row) => {
    const missing = needsPrev(row);
    if (missing !== null) return missing;
    const set = (meta(row).moderatorTownKeys as string[] | undefined) ?? [];
    const prev = (meta(row).prev.moderatorTownKeys as string[] | undefined) ?? [];
    return set.length === prev.length && set.every((key, i) => key === prev[i])
      ? NOTHING_TO_UNDO
      : null;
  },
  // The undo moves the list from what this row set back to what it replaced: it takes away when it
  // removes a pin this row added — the forward write's own rule, never "only when it clears".
  undoTakesAway: (row) =>
    UNDO_POLICY.set_moderator_towns.takesAway({
      from: (meta(row).moderatorTownKeys as string[] | undefined) ?? [],
      to: (meta(row).prev.moderatorTownKeys as string[] | undefined) ?? [],
    }),
  refusal: async (ctx, row, read) => {
    const id = ctx.db.normalizeId('waterBodies', row.targetId);
    const body = id ? await read.row('waterBody', id) : null;
    const refused = editRefusal(body);
    if (refused !== null || body === null) return refused;
    return listChangedRefusal(
      body.moderatorTownKeys ?? [],
      (meta(row).moderatorTownKeys as string[] | undefined) ?? [],
      'this body’s pinned towns',
    );
  },
  run: ({ ctx, actor, row, reason }) =>
    setModeratorTownsImpl(ctx, actor, {
      waterBodyId: row.targetId as Id<'waterBodies'>,
      townKeys: (meta(row).prev.moderatorTownKeys as string[] | undefined) ?? [],
      expected: (meta(row).moderatorTownKeys as string[] | undefined) ?? [],
      reason,
      restoring: true,
    }).then(() => undefined),
};

/** set_class → the class it replaced: the moderator's, or the catalogs' class it displaced. */
const undoClass: UndoHandler = {
  blocked: needsPrev,
  undoTakesAway: () => UNDO_POLICY.set_class.takesAway(undefined),
  run: ({ ctx, actor, row, reason }) => {
    const prev = meta(row).prev as {
      moderatorClass: Doc<'waterBodies'>['type'] | null;
      type: Doc<'waterBodies'>['type'];
    };
    return setClassImpl(ctx, actor, {
      waterBodyId: row.targetId as Id<'waterBodies'>,
      bodyClass: prev.moderatorClass,
      catalogClass: prev.type,
      reason,
    }).then(() => undefined);
  },
};

/** choose_depth_source → the choice it replaced (or the ladder), through the same write. */
const undoDepthSource: UndoHandler = {
  blocked: needsPrev,
  undoTakesAway: () => UNDO_POLICY.choose_depth_source.takesAway(undefined),
  // A loader run changes a body's candidates with no row: the choice it puts back has to still be
  // there, and still leave the mean no deeper than the max — the write's own rule, on the body now.
  refusal: async (ctx, row, read) => {
    const m = meta(row) as { measure: 'mean' | 'max'; prev: { choice: DepthSource | null } };
    const id = ctx.db.normalizeId('waterBodies', row.targetId);
    const body = id ? await read.row('waterBody', id) : null;
    const refused = editRefusal(body);
    if (refused !== null || body === null) return refused;
    const settled = depthChoiceOutcome(body, m.measure, m.prev.choice);
    return 'refusal' in settled ? settled.refusal : null;
  },
  run: ({ ctx, actor, row, reason }) => {
    const m = meta(row) as { measure: 'mean' | 'max'; prev: { choice: DepthSource | null } };
    return chooseDepthSourceImpl(ctx, actor, {
      waterBodyId: row.targetId as Id<'waterBodies'>,
      measure: m.measure,
      source: m.prev.choice,
      reason,
    }).then(() => undefined);
  },
};

/**
 * set_imagery_override → the call it replaced (or none), through the same write. Putting back a hide
 * takes a pass from skaters — and so does putting back *no call* over a show, since the gate that hid
 * the pass decides again.
 */
const undoImageryOverride: UndoHandler = {
  blocked: needsPrev,
  undoTakesAway: (row) => {
    const m = meta(row) as { action: unknown; prev: { action: unknown } };
    return (
      UNDO_POLICY.set_imagery_override.takesAway(m.prev.action) ||
      (m.prev.action === null && m.action === 'show')
    );
  },
  run: ({ ctx, actor, row, reason }) => {
    const m = meta(row) as {
      season: string;
      granuleId: string;
      prev: { action: 'show' | 'hide' | null; reason: string | null };
    };
    return setOverrideImpl(ctx, actor, {
      waterBodyId: row.targetId as Id<'waterBodies'>,
      season: m.season,
      granuleId: m.granuleId,
      action: m.prev.action,
      ...(m.prev.reason !== null ? { reason: m.prev.reason } : {}),
      undoReason: reason,
    }).then(() => undefined);
  },
};

/**
 * set_put_in → by the row's direction:
 * - `promoted` → demoted (the source and name it replaced); `demoted` → promoted again (B01-3d);
 * - `placed` (or a row from `setOfficial` before the direction was recorded) → the put-in removed
 *   (D300), refused once anything hangs off it (`placementRefusalOf`); `unplaced` → placed again
 *   where it was, by its name, through `setOfficial`'s own path.
 */
type PutInDirection = 'promoted' | 'demoted' | 'placed' | 'unplaced';
const directionOf = (row: Doc<'moderationActions'>): PutInDirection | null => {
  const m = meta(row) as { direction?: unknown; putInId?: unknown };
  if (
    m.direction === 'promoted' ||
    m.direction === 'demoted' ||
    m.direction === 'placed' ||
    m.direction === 'unplaced'
  ) {
    return m.direction;
  }
  // A placement recorded before its direction was: `setOfficial` wrote the put-in it made.
  return m.direction === undefined && typeof m.putInId === 'string' ? 'placed' : null;
};

const undoPutIn: UndoHandler = {
  blocked: (row) => (directionOf(row) === null ? PREDATES : null),
  undoTakesAway: (row) => UNDO_POLICY.set_put_in.takesAway(directionOf(row)),
  // A hide is audited on the put-in and an import moves or drops a launch with no row, so neither
  // overtakes this body's row: the launch is read as it stands, by the write's own checks. A launch
  // row is bounded at its writers (`ROW_MAX.launch`, B01-3h), so the body's hidden launches the
  // suppression rule reads can be reserved: the launch and up to `SUPPRESSION_ROWS_READ` of them.
  // A placement's removal reads the launch, whether a photo of it exists, and the body's alerts to
  // one past `PLACEMENT_ALERTS_READ`; placing it again reads the body, for its outline.
  refusalCost: (_scope, row) => {
    const direction = directionOf(row);
    if (direction === 'placed') {
      return {
        bytes: ROW_MAX.launch + ROW_MAX.small + ROW_MAX.accessAlert * (PLACEMENT_ALERTS_READ + 1),
        reads: 3,
        docs: 2 + PLACEMENT_ALERTS_READ + 1,
      };
    }
    if (direction === 'unplaced') return { bytes: ROW_MAX.waterBody, reads: 1 };
    return {
      bytes: ROW_MAX.launch * (2 + SUPPRESSION_ROWS_READ),
      reads: 2,
      docs: 2 + SUPPRESSION_ROWS_READ,
    };
  },
  refusal: async (ctx, row, read) => {
    const m = meta(row) as {
      putInId: Id<'putIns'>;
      coord: { lat: number; lng: number };
      name?: string;
    };
    const direction = directionOf(row);
    const recorded = { coord: m.coord, name: m.name ?? null };
    if (direction === 'placed') {
      const launch = await read.row('launch', m.putInId);
      const photo = await read.take('small', 1, async () => {
        const one = await placementPhoto(ctx, m.putInId);
        return one ? [one] : [];
      });
      // One past the bound, so a body with more alerts than the check reads is refused, not decided
      // on a window.
      const alerts = launch
        ? await read.take('accessAlert', PLACEMENT_ALERTS_READ + 1, () =>
            bodyAlerts(ctx, launch.waterBodyId).take(PLACEMENT_ALERTS_READ + 1),
          )
        : [];
      if (alerts.length > PLACEMENT_ALERTS_READ) return PLACEMENT_ALERTS_UNCHECKED;
      return placementRefusalOf(launch, recorded, { photo: photo.length > 0, alerts });
    }
    if (direction === 'unplaced') {
      // Placed again as `setOfficial` places: refused where that would be — the body gone, or its
      // outline redrawn away from the spot.
      const body = await read.row('waterBody', row.targetId as Id<'waterBodies'>);
      if (!body) return 'That body no longer exists.';
      const outsideM = distanceToPolygonMeters(
        m.coord,
        body.polygon as unknown as Polygon | MultiPolygon,
      );
      return outsideM > OPERATOR_PUT_IN_SNAP_MAX_M
        ? 'The lake’s outline moved away from that spot since, so undo can’t place it again.'
        : null;
    }
    const launch = await read.row('launch', m.putInId);
    if (launch === null) return 'That put-in no longer exists';
    // One past the bound, so a body with more than the check reads is refused, not decided on a window.
    const hidden = await read.take('launch', SUPPRESSION_ROWS_READ + 1, () =>
      hiddenLaunches(ctx, launch.waterBodyId).take(SUPPRESSION_ROWS_READ + 1),
    );
    const refused = launchRefusalOf(launch, hidden);
    if (refused !== null) return refused;
    return directionRefusal(launch, direction === 'promoted' ? 'demote' : 'promote', recorded);
  },
  run: async ({ ctx, actor, row, reason }) => {
    const m = meta(row) as {
      putInId: Id<'putIns'>;
      coord: { lat: number; lng: number };
      name?: string;
      prev: {
        source: 'osm' | 'derived' | 'official';
        name: string | null;
        createdByUserId?: Id<'profiles'> | null;
      };
    };
    const direction = directionOf(row);
    if (direction === 'placed') {
      await unplacePutInImpl(ctx, actor, {
        putInId: m.putInId,
        expected: { coord: m.coord, name: m.name ?? null },
        reason,
      });
      return;
    }
    if (direction === 'unplaced') {
      await placePutInImpl(ctx, actor, {
        waterBodyId: row.targetId as Id<'waterBodies'>,
        coord: m.coord,
        ...(m.name !== undefined ? { name: m.name } : {}),
        reason,
      });
      return;
    }
    if (direction === 'promoted') {
      await demotePutInImpl(ctx, actor, {
        putInId: m.putInId,
        prev: {
          source: m.prev.source as 'osm' | 'derived',
          name: m.prev.name,
          createdByUserId: m.prev.createdByUserId ?? null,
        },
        expected: { coord: m.coord, name: m.name ?? null },
        reason,
      });
      return;
    }
    // The demotion recorded where the launch was and what it was called once demoted: re-promoting
    // a launch an import moved or renamed since is refused, as the other direction is (Greptile).
    await promotePutInImpl(ctx, actor, {
      putInId: m.putInId,
      ...(m.prev.name !== null ? { name: m.prev.name } : {}),
      reason,
      expected: { coord: m.coord, name: m.name ?? null },
    });
  },
};

// ── Lots and links (D300) ─────────────────────────────────────────────────────────────────────────

interface LinkPrev {
  parkingAreaId: Id<'parkingAreas'> | null;
  approachKindOverride: Doc<'putIns'>['approachKindOverride'] | null;
}

/** Which of `set_parking_area`'s three rows this is: a lot placed, a lot's removal, or a link. */
type ParkingRow = 'lotPlaced' | 'lotRemoved' | 'lotEdited' | 'link';
const parkingRowOf = (row: Doc<'moderationActions'>): ParkingRow | null => {
  const m = meta(row) as { prev?: unknown; removed?: unknown };
  if (row.targetType === 'putIn') return m.prev === undefined ? null : 'link';
  if (m.removed === true) return 'lotRemoved';
  if (m.prev === null) return 'lotPlaced';
  return m.prev === undefined ? null : 'lotEdited';
};

/**
 * set_parking_area → by its target (D300):
 * - **on a lot placed by hand** (`prev: null`): the lot deleted with its lake links, refused once
 *   anything hangs off it (`lotRemovalRefusalOf`); **its removal** (`removed`): the lot placed again,
 *   where it was, by its name, for the lakes it served (a new lot, as a placement makes);
 * - **on a lot edited** (`prev` the lot's old fields): not built yet;
 * - **on a put-in** (a link): only which lot (or none) put back, through `setPutInAccessImpl` — the
 *   hike-in gate and the access-kind recompute included — and the walk routed again.
 */
const undoParkingArea: UndoHandler = {
  blocked: (row) => {
    const kind = parkingRowOf(row);
    if (kind === null) return PREDATES;
    return kind === 'lotEdited' ? 'Undoing a lot’s edit isn’t built yet.' : null;
  },
  undoTakesAway: (row) => UNDO_POLICY.set_parking_area.takesAway(parkingRowOf(row) === 'lotPlaced'),
  // A lot's row weighs at most a document (its name is uncapped on an imported lot), as an old
  // put-in's does; the joins and the alert are small.
  refusalCost: (_scope, row) => {
    const kind = parkingRowOf(row);
    if (kind === 'lotPlaced') {
      return {
        bytes: ROW_MAX.putIn + ROW_MAX.launch + ROW_MAX.small + ROW_MAX.accessAlert,
        reads: 4,
      };
    }
    if (kind === 'link') return { bytes: ROW_MAX.putIn * 2, reads: 2 };
    return null;
  },
  refusal: async (ctx, row, read) => {
    const kind = parkingRowOf(row);
    if (kind === 'lotPlaced') {
      const m = meta(row) as { coord: LatLng; name?: string };
      const lotId = ctx.db.normalizeId('parkingAreas', row.targetId);
      if (!lotId) return 'That lot is already gone.';
      const lot = await read.row('putIn', lotId);
      const putIn = await read.take('launch', 1, async () => {
        const one = await ctx.db
          .query('putIns')
          .withIndex('by_parking_area', (q) => q.eq('parkingAreaId', lotId))
          .first();
        return one ? [one] : [];
      });
      const photo = await read.take('small', 1, async () => {
        const one = await ctx.db
          .query('accessPhotos')
          .withIndex('by_parking_area', (q) => q.eq('parkingAreaId', lotId))
          .first();
        return one ? [one] : [];
      });
      const alert = await read.take('accessAlert', 1, async () => {
        const one = await ctx.db
          .query('accessAlerts')
          .withIndex('by_parking_area_status_kind_expires_at', (q) => q.eq('parkingAreaId', lotId))
          .first();
        return one ? [one] : [];
      });
      return lotRemovalRefusalOf(
        lot as Doc<'parkingAreas'> | null,
        { coord: m.coord, name: m.name ?? null },
        { putIn: putIn.length > 0, photo: photo.length > 0, alert: alert.length > 0 },
      );
    }
    if (kind !== 'link') return null;
    const { prev } = meta(row) as { prev: LinkPrev };
    const putIn = await read.row('launch', row.targetId as Id<'putIns'>);
    const lot = prev.parkingAreaId === null ? 'none' : await read.row('putIn', prev.parkingAreaId);
    return relinkRefusalOf(
      putIn,
      lot as Doc<'parkingAreas'> | null | 'none',
      putIn?.approachKindOverride ?? null,
    );
  },
  run: async ({ ctx, actor, row, reason }) => {
    const kind = parkingRowOf(row);
    const m = meta(row) as {
      coord: LatLng;
      name?: string;
      waterBodyIds?: Id<'waterBodies'>[];
      amenities?: Doc<'parkingAreas'>['amenities'];
      capacity?: number;
      fee?: boolean;
      prev: LinkPrev | null;
    };
    if (kind === 'lotPlaced') {
      await removeOfficialLotImpl(ctx, actor, {
        parkingAreaId: row.targetId as Id<'parkingAreas'>,
        expected: { coord: m.coord, name: m.name ?? null },
        reason,
      });
      return;
    }
    if (kind === 'lotRemoved') {
      // The lakes it served, as they stand: one merged away since is its survivor; one gone, dropped.
      const lakes: Id<'waterBodies'>[] = [];
      for (const id of (m.waterBodyIds ?? []) as Id<'waterBodies'>[]) {
        const lake = await resolveSurvivor(ctx, id);
        if (lake !== null && !lakes.includes(lake._id)) lakes.push(lake._id);
      }
      if (lakes.length === 0) throw new ConvexError('Every lake this lot served is gone.');
      await setOfficialParkingImpl(ctx, actor, {
        coord: m.coord,
        ...(m.name !== undefined ? { name: m.name } : {}),
        amenities: m.amenities ?? [],
        ...(m.capacity !== undefined ? { capacity: m.capacity } : {}),
        ...(m.fee !== undefined ? { fee: m.fee } : {}),
        waterBodyIds: lakes,
        reason,
      });
      return;
    }
    const prev = m.prev as LinkPrev;
    await setPutInAccessImpl(ctx, actor, {
      putInId: row.targetId as Id<'putIns'>,
      ...(prev.parkingAreaId !== null
        ? { parkingAreaId: prev.parkingAreaId }
        : { clearParking: true }),
      reason,
    });
  },
};

/** Verb-level handlers (verbs only this area writes). */
export const BODY_UNDO_HANDLERS: Partial<Record<ModerationAction, UndoHandler>> = {
  set_curated_boost: undoCuratedBoost,
  set_reference_links: undoReferenceLinks,
  set_aliases: undoAliases,
  set_moderator_towns: undoModeratorTowns,
  set_class: undoClass,
  set_water_body_name: undoWaterBodyName,
  set_lake_depth: undoLakeDepth,
  choose_depth_source: undoDepthSource,
  set_put_in: undoPutIn,
  set_parking_area: undoParkingArea,
  set_imagery_override: undoImageryOverride,
  set_satellite_imagery: undoSatelliteImagery,
  set_weather_sample_points: undoWeatherSamplePoints,
  set_public_access: undoPublicAccess,
  set_included_by_request: undoIncludedByRequest,
  set_standing: undoStanding,
  activate_body: undoStanding,
  demote_body: undoStanding,
  approve_waterbody: undoReview,
  reject_waterbody: undoReview,
  return_to_review: undoReturnToReview,
  create_sub_area: undoCreateSubArea,
  redraw_sub_area: undoRedrawSubArea,
  rename_sub_area: undoRenameSubArea,
  create_landmark: undoCreateLandmark,
  edit_landmark: undoEditLandmark,
};

/** `hide` / `remove` / `restore` for the target kinds this area owns. */
export const BODY_TARGET_UNDO: Partial<Record<ModerationTargetType, TargetUndo>> = {
  waterbody: WATER_BODY,
  waterBodySubArea: SUB_AREA,
  bodyLandmark: LANDMARK,
};
