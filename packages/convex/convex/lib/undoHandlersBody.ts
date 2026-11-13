/**
 * Undo handlers for the Body console's levers: a body's identity, water, access ruling, standing and removal; sub-areas; landmarks (D226, B01 §11). Composed into `UNDO_HANDLERS` by `undoHandlers.ts`;
 * the shapes are `undoTypes.ts`'s.
 *
 * Every handler runs the forward verb's own helper with the value the row recorded as `prev`, so the
 * side effects run again: a boost re-scores and re-cells, a ruling re-derives standing, a redraw
 * re-stamps reports and hazards, a restore re-clips. Nothing here patches a row back by hand.
 */

import { type BodyStanding, standingOf } from '@skating/core';
import { ConvexError } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import {
  type LandmarkEditPrev,
  removeLandmarkImpl,
  restoreLandmarkImpl,
  updateLandmarkImpl,
} from '../landmarks';
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
  type DepthFields,
  depthStateOf,
  removeBodyImpl,
  restoreBodyImpl,
  restoreDepthImpl,
  setCuratedBoostImpl,
  setIncludedByRequestImpl,
  setPublicAccessImpl,
  setReferenceLinksImpl,
  setSatelliteImageryImpl,
  setWaterBodyNameImpl,
  setWeatherSamplePointsImpl,
} from '../waterBodies';
import { type ModerationAction, type ModerationTargetType, readSnapshot } from './audit';
import { UNDO_POLICY } from './undoPolicy';
import { meta, PREDATES, type TargetUndo, type UndoCall, type UndoHandler } from './undoTypes';

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
  run: ({ ctx, actor, row, reason }) =>
    setReferenceLinksImpl(ctx, actor, {
      waterBodyId: row.targetId as Id<'waterBodies'>,
      links: meta(row).prev.referenceLinks as { label: string; url: string }[],
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
  run: async ({ ctx, actor, row, reason }) => {
    const waterBodyId = row.targetId as Id<'waterBodies'>;
    const body = await ctx.db.get(waterBodyId);
    if (!body) throw new ConvexError('Water body not found');
    if (JSON.stringify(depthStateOf(body)) !== JSON.stringify(depthStateOf(meta(row).after))) {
      throw new ConvexError(
        'The depth has changed since (an import or another edit); set it again rather than undo',
      );
    }
    await restoreDepthImpl(ctx, actor, {
      waterBodyId,
      fields: meta(row).prev as Partial<DepthFields>,
      reason,
    });
  },
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
 * had, as a boost's undo does. Flags the ruling closed stay closed: reopening a flag is §2's inverse,
 * not this one.
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
  },
};

/** set_included_by_request → the flag it replaced. A body admitted on a request undoes with it. */
const undoIncludedByRequest: UndoHandler = {
  blocked: (row) => {
    if (meta(row).requestId !== undefined) {
      return "This body was admitted from the catalog on a skater's request; reopening the request undoes it (§2 Inbox).";
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

// ── Sub-areas ─────────────────────────────────────────────────────────────────────────────────────

const subAreaId = (row: Doc<'moderationActions'>) => row.targetId as Id<'waterBodySubAreas'>;

/** create_sub_area → delisted, through `remove`. */
const undoCreateSubArea: UndoHandler = {
  undoTakesAway: () => UNDO_POLICY.create_sub_area.takesAway(),
  run: async ({ ctx, actor, row, reason }) => {
    await removeSubAreaImpl(ctx, actor, { subAreaId: subAreaId(row), reason });
  },
};

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
    await renameSubAreaImpl(ctx, actor, {
      subAreaId: subAreaId(row),
      name: prev.name,
      aliases: prev.aliases,
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
    },
  },
  /** A restore → delisted again. */
  restore: {
    undoTakesAway: () => true,
    run: async ({ ctx, actor, row, reason }) => {
      await removeSubAreaImpl(ctx, actor, { subAreaId: subAreaId(row), reason });
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

/** edit_landmark → the name, aliases, kind and point it replaced. */
const undoEditLandmark: UndoHandler = {
  blocked: (row) => {
    if (meta(row).corpusName !== undefined) {
      return 'This spelling came from the place-names queue; edit the landmark to take it off.';
    }
    return needsPrev(row);
  },
  undoTakesAway: (row) => UNDO_POLICY.edit_landmark.takesAway(meta(row).prev),
  run: async ({ ctx, actor, row, reason }) => {
    const prev = meta(row).prev as LandmarkEditPrev;
    const current = await ctx.db.get(landmarkId(row));
    if (!current) throw new ConvexError('That landmark no longer exists');
    const moved = current.point.lat !== prev.point.lat || current.point.lng !== prev.point.lng;
    await updateLandmarkImpl(ctx, actor, {
      landmarkId: landmarkId(row),
      name: prev.name,
      aliases: prev.aliases,
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
  /** A restore → removed again. */
  restore: {
    undoTakesAway: () => true,
    run: async ({ ctx, actor, row, reason }) => {
      await removeLandmarkImpl(ctx, actor, { landmarkId: landmarkId(row), reason });
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
        note: reason,
      });
    },
  },
};

/** Verb-level handlers (verbs only this area writes). */
export const BODY_UNDO_HANDLERS: Partial<Record<ModerationAction, UndoHandler>> = {
  set_curated_boost: undoCuratedBoost,
  set_reference_links: undoReferenceLinks,
  set_water_body_name: undoWaterBodyName,
  set_lake_depth: undoLakeDepth,
  set_satellite_imagery: undoSatelliteImagery,
  set_weather_sample_points: undoWeatherSamplePoints,
  set_public_access: undoPublicAccess,
  set_included_by_request: undoIncludedByRequest,
  set_standing: undoStanding,
  activate_body: undoStanding,
  demote_body: undoStanding,
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
