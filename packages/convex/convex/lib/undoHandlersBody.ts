/**
 * Undo handlers for the Body console's levers: a body's identity, water, access ruling, standing and removal; sub-areas; landmarks (D226, B01 §11). Composed into `UNDO_HANDLERS` by `undoHandlers.ts`;
 * the shapes are `undoTypes.ts`'s.
 *
 * Every handler runs the forward verb's own helper with the value the row recorded as `prev`, so the
 * side effects run again: a boost re-scores and re-cells, a ruling re-derives standing, a redraw
 * re-stamps reports and hazards, a restore re-clips. Nothing here patches a row back by hand.
 */

import { type BodyStanding, type DepthSource, standingOf } from '@skating/core';
import { ConvexError } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import { setOverrideImpl } from '../imageryOverrides';
import {
  type LandmarkEditPrev,
  type LandmarkRestorePrev,
  removeLandmarkImpl,
  restoreLandmarkImpl,
  unrestoreLandmarkImpl,
  updateLandmarkImpl,
} from '../landmarks';
import { demotePutInImpl, directionRefusal, launchRefusal, promotePutInImpl } from '../putIns';
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
import { listChangedRefusal } from './listCas';
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
  refusal: async (ctx, row, read) => {
    const id = ctx.db.normalizeId('waterBodies', row.targetId);
    const body = id ? await read('waterBody', id) : null;
    if (body === null) return 'Water body not found';
    const prev = await readSnapshot<{ weatherSamplePoints: { lat: number; lng: number }[] }>(
      ctx,
      row._id,
    );
    if (prev === null) return PREDATES;
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
  // A merge's fold and a catalog run change a landmark's spellings with no row on it: the undo
  // compares the spellings the edit left with the landmark as it stands (B01-3d).
  refusal: async (ctx, row, read) => {
    const id = ctx.db.normalizeId('bodyLandmarks', row.targetId);
    const current = id ? await read('landmark', id) : null;
    if (current === null) return 'That landmark no longer exists';
    return listChangedRefusal(
      current.aliases,
      meta(row).aliases as string[] | undefined,
      'this landmark’s other spellings',
    );
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
  blocked: needsPrev,
  undoTakesAway: (row) =>
    UNDO_POLICY.set_moderator_towns.takesAway(
      (meta(row).prev.moderatorTownKeys as string[] | undefined) ?? [],
    ),
  refusal: async (ctx, row) => {
    const id = ctx.db.normalizeId('waterBodies', row.targetId);
    const body = id ? await undoRead(ctx, 'waterBody', id) : null;
    if (body === undefined) return UNDO_CHECKED_ELSEWHERE;
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
    const body = id ? await read('waterBody', id) : null;
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
 * set_put_in → a promotion undone (the source and name it replaced), or that undo undone (promoted
 * again). A row from `setOfficial` placing a new point has no undo yet.
 */
const undoPutIn: UndoHandler = {
  blocked: (row) => {
    const direction = (meta(row) as { direction?: unknown }).direction;
    return direction === 'promoted' || direction === 'demoted'
      ? null
      : 'Undoing a newly placed official put-in is not built yet.';
  },
  undoTakesAway: (row) =>
    UNDO_POLICY.set_put_in.takesAway((meta(row) as { direction?: unknown }).direction),
  // A hide is audited on the put-in and an import moves or drops a launch with no row, so neither
  // overtakes this body's row: the launch is read as it stands, by the write's own checks.
  refusal: async (ctx, row, read) => {
    const m = meta(row) as {
      putInId: Id<'putIns'>;
      coord: { lat: number; lng: number };
      direction: 'promoted' | 'demoted';
      name?: string;
    };
    const launch = await read('putIn', m.putInId);
    const refused = await launchRefusal(ctx, launch);
    if (refused !== null || launch === null) return refused;
    return directionRefusal(launch, m.direction === 'promoted' ? 'demote' : 'promote', {
      coord: m.coord,
      name: m.name ?? null,
    });
  },
  run: async ({ ctx, actor, row, reason }) => {
    const m = meta(row) as {
      putInId: Id<'putIns'>;
      coord: { lat: number; lng: number };
      direction: 'promoted' | 'demoted';
      name?: string;
      prev: {
        source: 'osm' | 'derived' | 'official';
        name: string | null;
        createdByUserId?: Id<'profiles'> | null;
      };
    };
    if (m.direction === 'promoted') {
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
  set_imagery_override: undoImageryOverride,
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
