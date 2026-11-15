import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { type HazardShape, hazardFootprint, type Season, seasonOf } from '@skating/core';
import { useNavigate } from '@tanstack/react-router';
import { useMutation } from 'convex/react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { errorText } from '@/components/admin/adminUi';
import {
  isFailed,
  type Loadable,
  read,
  useConsoleReadSet,
} from '@/components/admin/reads/consoleReads';
import { ReadNote } from '@/components/admin/reads/ReadNote';
import { useMinuteNow } from '@/components/admin/shell/presence';
import { useUndo } from '@/components/admin/shell/undo';
import { UNAVAILABLE } from '@/components/kit/unavailable-button';
import { useRole } from '@/lib/useRole';
import type { BodyTabProps, BodyTabRegistration } from '../../frame/tabRegistry';
import { LoadingSection, TabBody } from '../tabParts';
import { featureGlyph } from './featureGlyph';
import { type FeatureRowWithGlyph, HazardsTabView, type Read } from './HazardsTabView';
import { type HazardsMapData, hazardsMapScene, seasonOfLit, winterLit } from './hazardsMap';
import {
  archivedRows,
  type DailyHazards,
  dailyClock,
  type FeatureInput,
  featureRows,
  type HazardInput,
  hazardRows,
  type Winters,
  wintersFrom,
} from './hazardsModel';

/**
 * Body › Hazards, wired:
 *
 * - **the season's hazards** (`hazards.listForBody`, the map layer's own read, so the list and the
 *   map can't disagree — stale ones included, annotated, never filtered) and the archived ones (the
 *   same read with `includeArchived`);
 * - **the winters, a day at a time** (`bodyConsole.dailyHazards`): the season on screen, and last
 *   winter beside an empty current one. Each day's known count, and the archived hazards that may
 *   have been on the lake — said as *at least*, never as a smaller count or as clear — with the
 *   watch's opening day. An archived hazard, whose end isn't recorded, is one mark on the day it
 *   was first reported, taken from the archived list; that list is read for the winter on screen
 *   only, so last winter's strip beside it draws no marks and says so;
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
  return <HazardsReads {...props} />;
}

function HazardsReads({ bodyId: id, lit: framed = null, onLitChange }: BodyTabProps) {
  const waterBodyId = id as Id<'waterBodies'>;
  // The reads hold their arguments for the hour; ages read the minute, so none looks an hour fresher.
  const now = useHourClock();
  // Since anyone last looked, to the minute: an age lags by a minute at most, never by an hour.
  const ageNow = useMinuteNow();
  const current = seasonOf(now);
  // The lit address is the frame's when it has one (the URL keeps it), else the tab's own.
  const [own, setOwn] = useState<string | null>(null);
  const lit = onLitChange === undefined ? own : framed;
  const setLit = onLitChange ?? setOwn;
  // The winter on screen is the lit address's: the current one unless a past one was chosen.
  const season: Season = seasonOfLit(lit, current);
  const setSeason = (next: Season) => setLit(winterLit(next, current));
  const { can } = useRole();
  const {
    reads: got,
    retry,
    pending,
  } = useConsoleReadSet({
    body: read(api.waterBodies.get, { waterBodyId }),
    hazards: read(api.hazards.listForBody, { waterBodyId, season }),
    withArchived: read(api.hazards.listForBody, { waterBodyId, season, includeArchived: true }),
    features: read(api.bodyFeatures.listForBody, { waterBodyId }),
    clusters: can('body.read') ? read(api.recurrence.listForBodyAdmin, { waterBodyId }) : null,
    daily: read(api.bodyConsole.dailyHazards, {
      waterBodyId,
      season,
      now: dailyClock(season, now),
    }),
    // Last winter's record sits beside the current one; a past winter is drawn alone.
    lastWinter:
      season === current
        ? read(api.bodyConsole.dailyHazards, {
            waterBodyId,
            season: season - 1,
            now: dailyClock(season - 1, now),
          })
        : null,
  });
  const demote = useMutation(api.bodyFeatures.demote);
  const { announce } = useUndo();
  const navigate = useNavigate();

  const features = got.features;
  const featureView = useMemo(() => readOf(features, (f) => withGlyphs(f)), [features]);
  const { hazards, withArchived, clusters } = got;
  // The day-by-day reads take the hour: a new hour is a new read, which keeps the winter it had
  // until its fresh answer lands rather than going back to a skeleton once an hour.
  const heldDaily = useHeldThroughClock(got.daily, `daily:${id}:${season}`, now);
  const daily = heldDaily.value;
  const lastWinter = useHeldThroughClock(got.lastWinter, `daily:${id}:${season - 1}`, now).value;
  // Last winter is drawn only beside an empty current one (the view's rule): over a list it is
  // neither waited on nor a failure of the strip that is drawn.
  const beside = season === current && !(Array.isArray(hazards) && hazards.length > 0);
  // Drawn against the hour the winter on screen was read for: a held answer read before the day
  // turned has no entry for the new day, which this hour's clock would draw as *No hazard reports*.
  const drawnAt = heldDaily.at;
  const winters = useMemo(
    (): Read<Winters> => wintersOf(daily, withArchived, beside ? lastWinter : null, drawnAt),
    [daily, withArchived, lastWinter, beside, drawnAt],
  );

  const body = got.body;
  if (body === undefined) {
    return (
      <TabBody aria-busy="true">
        {/* The tab's note, mounted from the first state, so a failure's words are announced. */}
        <ReadNote reads={[body]}>This body couldn’t be read</ReadNote>
        <LoadingSection lines={3} />
        <LoadingSection lines={2} />
      </TabBody>
    );
  }
  if (isFailed(body)) {
    return (
      <TabBody>
        <ReadNote reads={[body]}>This body couldn’t be read</ReadNote>
      </TabBody>
    );
  }
  if (body === null || !body.available) return null;
  const name = body.body.name ?? 'this body';
  const featureTools = can('corpus.preIce');
  const opened = isFailed(daily) || daily === undefined ? null : daily.watchOpensOn;
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
      retryPending={pending}
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
function readOf<T, U>(r: Loadable<T>, map: (value: T) => U): Read<U> {
  if (r === undefined) return undefined;
  if (isFailed(r)) return 'error';
  return map(r as T);
}

/**
 * The winters, once every strip's read — and the archived list its marks come from — has landed; a
 * failure in either day-by-day read fails the block. A failed archived list leaves the winter on
 * screen without marks, saying so, rather than without its strip (the list's own note says it
 * failed). Last winter beside it has no list read, so no marks.
 */
export function wintersOf(
  daily: Loadable<DailyHazards>,
  list: Loadable<readonly HazardInput[]>,
  lastWinter: Loadable<DailyHazards> | null,
  now: number,
): Read<Winters> {
  if (isFailed(daily) || isFailed(lastWinter)) return 'error';
  if (daily === undefined || lastWinter === undefined || list === undefined) return undefined;
  const d = daily as DailyHazards;
  const marks = isFailed(list) ? null : (list as readonly HazardInput[]);
  return (
    wintersFrom(lastWinter === null ? [d] : [d, lastWinter as DailyHazards], now, [marks, null]) ??
    undefined
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

/**
 * The map's data: the hazards of the winter the lit address is in (the one the list shows) and the
 * features, kept until either read changes. A failed read draws nothing of its own on the map; the
 * tab says what failed.
 */
function useHazardsMapData(bodyId: string, lit: string | null): HazardsMapData | undefined {
  const waterBodyId = bodyId as Id<'waterBodies'>;
  const current = seasonOf(useHourClock());
  const season = seasonOfLit(lit, current);
  const { reads: got } = useConsoleReadSet({
    hazards: read(api.hazards.listForBody, { waterBodyId, season }),
    features: read(api.bodyFeatures.listForBody, { waterBodyId }),
  });
  const { hazards, features } = got;
  return useMemo(
    () =>
      hazards === undefined || features === undefined || isFailed(hazards) || isFailed(features)
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

/**
 * A read whose argument moves with the clock, held through the clock's turn: while the new read is
 * on its way, the last answer for the same `key` (the body and winter) stands, with `at`, the clock
 * it was read for — so it is drawn against that clock, never a later one it doesn't cover.
 * A failure is never held over (the next load after it is a load), and another key starts clean.
 */
function useHeldThroughClock<T>(
  value: Loadable<T>,
  key: string,
  clock: number,
): { value: Loadable<T>; at: number } {
  const held = useRef<{ key: string; value: T; at: number } | null>(null);
  if (isFailed(value)) held.current = null;
  else if (value !== undefined) held.current = { key, value: value as T, at: clock };
  if (value === undefined && held.current !== null && held.current.key === key) {
    return { value: held.current.value, at: held.current.at };
  }
  return { value, at: clock };
}

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
