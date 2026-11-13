import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { type HazardShape, hazardFootprint, type Season, seasonOf } from '@skating/core';
import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery } from 'convex/react';
import { useEffect, useMemo, useState } from 'react';

import { errorText } from '@/components/admin/adminUi';
import { useUndo } from '@/components/admin/shell/undo';
import { useRole } from '@/lib/useRole';

import { featureGlyph } from './featureGlyph';
import { type FeatureRowWithGlyph, HazardsTabView } from './HazardsTabView';
import { type HazardsMapData, hazardsMapScene } from './hazardsMap';
import { archivedRows, type FeatureInput, featureRows, hazardRows } from './hazardsModel';
import type { BodyTabProps, BodyTabRegistration } from './tabContract';

/**
 * Body › Hazards, wired: the season's hazards (`hazards.listForBody`, the map layer's own read, so
 * the list and the map can't disagree — stale ones included, annotated, never filtered), the
 * archived ones (the same read with `includeArchived`), the known features
 * (`bodyFeatures.listForBody`), and the recurrence patterns still waiting
 * (`recurrence.listForBodyAdmin`). Demote writes `bodyFeatures.demote` (`corpus.preIce`) with
 * its reason, announced to the shell's Undo (which says when there is none).
 *
 * Not drawn, for want of a writer or a read (seam requests): Mark a hazard and Add a feature
 * (map modes, which wait), Edit shape (no mutation), the two winters' strip (no per-day read) and
 * the watch's opening date (admin-only today).
 */
export function HazardsTab({ bodyId: id, lit = null, onLitChange }: BodyTabProps) {
  const waterBodyId = id as Id<'waterBodies'>;
  const now = useHourClock();
  const current = seasonOf(now);
  const [season, setSeason] = useState<Season>(current);
  const result = useQuery(api.waterBodies.get, { waterBodyId });
  const hazards = useQuery(api.hazards.listForBody, { waterBodyId, season });
  const withArchived = useQuery(api.hazards.listForBody, {
    waterBodyId,
    season,
    includeArchived: true,
  });
  const features = useQuery(api.bodyFeatures.listForBody, { waterBodyId });
  const { can } = useRole();
  const clusters = useQuery(
    api.recurrence.listForBodyAdmin,
    can('body.read') ? { waterBodyId } : 'skip',
  );
  const demote = useMutation(api.bodyFeatures.demote);
  const { announce } = useUndo();
  const navigate = useNavigate();

  const featureView = useMemo(
    () => (features === undefined ? undefined : withGlyphs(features)),
    [features],
  );

  if (result === undefined || result === null || !result.available) return null;
  const name = result.body.name ?? 'this body';
  return (
    <HazardsTabView
      season={season}
      currentSeason={current}
      onSeasonChange={setSeason}
      bodyName={name.replace(/ (Lake|Pond|Reservoir)$/, '')}
      watchOpenedAt={null}
      hazards={hazards === undefined ? undefined : hazardRows(hazards, now)}
      archived={withArchived === undefined ? undefined : archivedRows(withArchived)}
      features={featureView}
      winters={null}
      patternsWaiting={
        clusters === undefined
          ? null
          : clusters.filter(
              (c) => c.suppressedAt === undefined && c.promotedToFeatureId === undefined,
            ).length
      }
      onOpenRecurrence={() => void navigate({ to: '/admin/recurrence' })}
      {...(can('corpus.preIce')
        ? {
            onDemote: async (featureId: string, reason: string) => {
              try {
                await demote({ bodyFeatureId: featureId as Id<'bodyFeatures'>, reason });
              } catch (err) {
                throw new Error(errorText(err));
              }
              await announce({
                title: 'Known feature demoted',
                target: { targetType: 'bodyFeature', targetId: featureId },
              });
            },
          }
        : {})}
      lit={lit}
      onLitChange={(next) => onLitChange?.(next)}
    />
  );
}

/** Each feature's row with its glyph, drawn from its own footprint. */
function withGlyphs(features: readonly FeatureInput[]): FeatureRowWithGlyph[] {
  const rows = featureRows(features);
  return rows.map((row, i) => {
    const f = features[i] as FeatureInput;
    let glyph: FeatureRowWithGlyph['glyph'] = null;
    try {
      glyph = featureGlyph(
        hazardFootprint({
          geometryKind: f.geometryKind,
          geometry: f.geometry as HazardShape['geometry'],
          ...(f.radiusMeters !== undefined ? { radiusMeters: f.radiusMeters } : {}),
          ...(f.bufferMeters !== undefined ? { bufferMeters: f.bufferMeters } : {}),
        }),
      );
    } catch {
      // A shape that can't be grown draws no glyph; its row still says what and where.
    }
    return { ...row, glyph };
  });
}

/** The map's data: this season's hazards and the features, kept until either read changes. */
function useHazardsMapData(bodyId: string): HazardsMapData | undefined {
  const waterBodyId = bodyId as Id<'waterBodies'>;
  const hazards = useQuery(api.hazards.listForBody, { waterBodyId });
  const features = useQuery(api.bodyFeatures.listForBody, { waterBodyId });
  return useMemo(
    () => (hazards === undefined || features === undefined ? undefined : { hazards, features }),
    [hazards, features],
  );
}

/** The Hazards tab's registration in the frame's registry. */
export const HAZARDS_TAB: BodyTabRegistration = {
  Wiring: HazardsTab,
  map: { useData: useHazardsMapData, describe: hazardsMapScene },
};

/** Ages are hours and days: the clock moves on hourly. */
function useHourClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 3_600_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}
