import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { type HazardShape, hazardFootprint, type Season, seasonOf } from '@skating/core';
import { useNavigate } from '@tanstack/react-router';
import { useMutation } from 'convex/react';
import { useEffect, useMemo, useState } from 'react';

import { errorText } from '@/components/admin/adminUi';
import { ReadBoundary } from '@/components/admin/bodies/ReadBoundary';
import { useUndo } from '@/components/admin/shell/undo';
import { useRole } from '@/lib/useRole';
import type { BodyTabProps, BodyTabRegistration } from '../../frame/tabRegistry';
import { LoadingSection, TabBody } from '../tabParts';
import { featureGlyph } from './featureGlyph';
import { type FeatureRowWithGlyph, HazardsTabView, type Read, UNAVAILABLE } from './HazardsTabView';
import { type HazardsMapData, hazardsMapScene, seasonOfLit, winterLit } from './hazardsMap';
import {
  archivedRows,
  type DailyHazards,
  type FeatureInput,
  featureRows,
  hazardRows,
  type Winters,
  wintersFrom,
} from './hazardsModel';
import { ReadFailed } from './kit-candidates/read-failed';
import { read, useTabReads } from './tabReads';

/**
 * Body › Hazards, wired:
 *
 * - **the season's hazards** (`hazards.listForBody`, the map layer's own read, so the list and the
 *   map can't disagree — stale ones included, annotated, never filtered) and the archived ones (the
 *   same read with `includeArchived`);
 * - **the winters, a day at a time** (`bodyConsole.dailyHazards`): the season on screen, and last
 *   winter beside an empty current one. Each day's known count, and the archived hazards that may
 *   have been on the lake — drawn as *at least*, never as a smaller count or as clear — with the
 *   watch's opening day;
 * - **the known features** (`bodyFeatures.listForBody`) and the recurrence patterns still waiting
 *   (`recurrence.listForBodyAdmin`, `body.read`).
 *
 * Demote writes `bodyFeatures.demote` (`corpus.preIce`) with its reason, announced to the shell's
 * Undo (which says when there is none). Mark a hazard, Add a feature and Edit shape have no writer
 * yet: for a viewer who could use them, each is drawn and says *Not available yet*.
 *
 * Every read is keyed on its values and comes back as a value, a wait or a failure, which the view
 * draws in its own place with *Try again*; the tab opens on the current winter, empty or not, and
 * a past one only by choosing it (the lit address carries the choice, so the map follows).
 */
export function HazardsTab(props: BodyTabProps) {
  return (
    <ReadBoundary
      resetKey={props.bodyId}
      fallback={<ReadFailed>This tab couldn’t be drawn</ReadFailed>}
    >
      <HazardsReads {...props} />
    </ReadBoundary>
  );
}

/** The reads this tab and its map share: one key, so Try again re-runs them for both. */
const readsKey = (bodyId: string) => `hazards:${bodyId}`;

function HazardsReads({ bodyId: id, lit: framed = null, onLitChange }: BodyTabProps) {
  const waterBodyId = id as Id<'waterBodies'>;
  // The reads hold their arguments for the hour; ages read the minute, so none looks fresher.
  const now = useHourClock();
  const ageNow = useMinuteClock();
  const current = seasonOf(now);
  // The lit address is the frame's when it has one (the URL keeps it), else the tab's own.
  const [own, setOwn] = useState<string | null>(null);
  const lit = onLitChange === undefined ? own : framed;
  const setLit = onLitChange ?? setOwn;
  // The winter on screen is the lit address's: the current one unless a past one was chosen.
  const season: Season = seasonOfLit(lit, current);
  const setSeason = (next: Season) => setLit(winterLit(next, current));
  const { can } = useRole();
  const { got, retry } = useTabReads(readsKey(id), {
    body: read(api.waterBodies.get, { waterBodyId }),
    hazards: read(api.hazards.listForBody, { waterBodyId, season }),
    withArchived: read(api.hazards.listForBody, { waterBodyId, season, includeArchived: true }),
    features: read(api.bodyFeatures.listForBody, { waterBodyId }),
    clusters: can('body.read') ? read(api.recurrence.listForBodyAdmin, { waterBodyId }) : null,
    daily: read(api.bodyConsole.dailyHazards, { waterBodyId, season, now }),
    // Last winter's record sits beside the current one; a past winter is drawn alone.
    lastWinter:
      season === current
        ? read(api.bodyConsole.dailyHazards, { waterBodyId, season: season - 1, now })
        : null,
  });
  const demote = useMutation(api.bodyFeatures.demote);
  const { announce } = useUndo();
  const navigate = useNavigate();

  const features = got.features;
  const featureView = useMemo(() => readOf(features, (f) => withGlyphs(f)), [features]);
  const { hazards, withArchived, clusters, daily, lastWinter } = got;
  const winters = useMemo(
    (): Read<Winters> => wintersOf(daily, season === current ? lastWinter : null, now),
    [daily, lastWinter, season, current, now],
  );

  const body = got.body;
  if (body === undefined) {
    return (
      <TabBody aria-busy="true">
        <LoadingSection lines={3} />
        <LoadingSection lines={2} />
      </TabBody>
    );
  }
  if (body instanceof Error) {
    return <ReadFailed onRetry={retry}>This body couldn’t be read</ReadFailed>;
  }
  if (body === null || !body.available) return null;
  const name = body.body.name ?? 'this body';
  const featureTools = can('corpus.preIce');
  const opened = daily instanceof Error || daily === undefined ? null : daily.watchOpensOn;
  return (
    <HazardsTabView
      season={season}
      currentSeason={current}
      onSeasonChange={setSeason}
      bodyName={name.replace(/ (Lake|Pond|Reservoir)$/, '')}
      watchOpenedAt={season === current ? opened : null}
      hazards={readOf(hazards, (h) => hazardRows(h, ageNow))}
      archived={readOf(withArchived, archivedRows)}
      features={featureView}
      winters={winters}
      patternsWaiting={
        can('body.read')
          ? readOf(
              clusters,
              (c) =>
                c.filter((x) => x.suppressedAt === undefined && x.promotedToFeatureId === undefined)
                  .length,
            )
          : null
      }
      onRetry={retry}
      onOpenRecurrence={() => void navigate({ to: '/admin/recurrence' })}
      {...(featureTools
        ? {
            onMarkHazard: UNAVAILABLE,
            onAddFeature: UNAVAILABLE,
            onEditShape: UNAVAILABLE,
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
      onLitChange={setLit}
    />
  );
}

/** A read as the view takes it: mapped when it landed, `'error'` when it failed. */
function readOf<T, U>(r: T | undefined | Error, map: (value: T) => U): Read<U> {
  if (r === undefined) return undefined;
  if (r instanceof Error) return 'error';
  return map(r);
}

/** The winters, once every strip's read has landed; a failure in either fails the block. */
function wintersOf(
  daily: DailyHazards | undefined | Error,
  lastWinter: DailyHazards | undefined | Error | null,
  now: number,
): Read<Winters> {
  if (daily instanceof Error || lastWinter instanceof Error) return 'error';
  if (daily === undefined || lastWinter === undefined) return undefined;
  return wintersFrom(lastWinter === null ? [daily] : [daily, lastWinter], now) ?? undefined;
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

/**
 * The map's data: the hazards of the winter the lit address is in (the one the list shows) and the
 * features, kept until either read changes. A failed read draws nothing of its own on the map; the
 * tab says what failed.
 */
function useHazardsMapData(bodyId: string, lit: string | null): HazardsMapData | undefined {
  const waterBodyId = bodyId as Id<'waterBodies'>;
  const current = seasonOf(useHourClock());
  const season = seasonOfLit(lit, current);
  const { got } = useTabReads(readsKey(bodyId), {
    hazards: read(api.hazards.listForBody, { waterBodyId, season }),
    features: read(api.bodyFeatures.listForBody, { waterBodyId }),
  });
  const { hazards, features } = got;
  return useMemo(
    () =>
      hazards === undefined ||
      features === undefined ||
      hazards instanceof Error ||
      features instanceof Error
        ? undefined
        : { hazards, features, season, current },
    [hazards, features, season, current],
  );
}

/** The Hazards tab's registration in the frame's registry. */
export const HAZARDS_TAB: BodyTabRegistration<HazardsMapData> = {
  Wiring: HazardsTab,
  map: { useData: useHazardsMapData, describe: hazardsMapScene },
};

/** The reads' clock: on the hour, so the reads it keys hold their arguments for the hour. */
function useHourClock(): number {
  const [now, setNow] = useState(() => onTheHour(Date.now()));
  useEffect(() => {
    const id = window.setInterval(() => setNow(onTheHour(Date.now())), 60_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

const onTheHour = (at: number) => Math.floor(at / 3_600_000) * 3_600_000;

/** Since anyone last looked, as the minute has it: an age never reads younger than it is. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}
