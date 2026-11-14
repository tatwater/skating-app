import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { bandsIn, copernicusUrl, linkCoordinate, type SatelliteImageryMode } from '@skating/core';
import { useMutation } from 'convex/react';
import { useEffect, useMemo, useState } from 'react';

import { errorText } from '@/components/admin/adminUi';
import { ReadBoundary } from '@/components/admin/bodies/ReadBoundary';
import { useUndo } from '@/components/admin/shell/undo';
import { useFreezeUpTimeline } from '@/components/useFreezeUpTimeline';
import { env } from '@/lib/env';
import { useRole } from '@/lib/useRole';

import type { BodyTabProps, BodyTabRegistration } from '../../frame/tabRegistry';
import { ReadFailed } from '../hazards/kit-candidates/read-failed';
import { read, useTabReads } from '../hazards/tabReads';
import { LoadingSection, TabBody } from '../tabParts';
import { ImageryDockView } from './ImageryDockView';
import { ImageryTabView, UNAVAILABLE } from './ImageryTabView';
import { type ImageryMapData, imageryMapScene } from './imageryMap';
import {
  type PassRow,
  parsePassAddress,
  passAddress,
  passRows,
  selectedPass,
  winterWord,
} from './imageryModel';

/**
 * Body › Imagery, wired. The passes are the app's own freeze-up timeline (`useFreezeUpTimeline`,
 * read from the imagery archive the skater's stepper reads: the season's frames, each pass's
 * measured cloud and coverage, and the two gates), so the console and the app can't disagree
 * about which passes skaters land on. The season is the archive's own, which ends by the thaw
 * rule alone; nothing here adds an end. The satellite link writes through
 * `waterBodies.setSatelliteImagery` (`body.water`) with the shell's Undo.
 *
 * The staff call on a pass (show a hidden pass anyway, hide a shown one) has no writer on the
 * server yet: for a viewer who will make it, the call is drawn and says *Not available yet*, and
 * every pass is the gates' own.
 *
 * The body is read through the tabs' shared reads, and the archive beside it: loading holds the
 * card's place, an archive that couldn't be read says so — a fact about the archive, never about
 * the lake — with *Try again*, which pauses every reader of this tab (the inspector, the dock and
 * the map) for a commit, so the archive is asked afresh; an archive this deployment has no address
 * for says that instead.
 *
 * **The lit pass is the frame's `?lit=`** (`pass:<band>.<granuleId>`), so the inspector, the dock
 * and the map read one address — and the band rides in it. Without a frame (`onLitChange` absent)
 * the tab keeps it itself.
 */

/** The body and the season's passes in the lit address's band. */
function usePasses(bodyId: string, lit: string | null | undefined) {
  const { got, retry, live } = useTabReads(`imagery:${bodyId}`, {
    body: read(api.waterBodies.get, { waterBodyId: bodyId as Id<'waterBodies'> }),
  });
  const result = got.body;
  const body =
    result !== undefined && !(result instanceof Error) && result?.available === true
      ? result.body
      : null;
  const { band } = parsePassAddress(lit);
  // A retry's paused commit lets go of the archive too, so it is asked again.
  const timeline = useFreezeUpTimeline({ body, band, enabled: body !== null && live });
  const rows: PassRow[] | undefined = useMemo(
    () => (timeline.timeline === null ? undefined : passRows(timeline.timeline.stops)),
    [timeline.timeline],
  );
  return { result, body, band, rows, timeline, retry };
}

/** The lit address, the frame's or the tab's own. */
function useLit({ lit, onLitChange }: BodyTabProps) {
  const [own, setOwn] = useState<string | null>(null);
  return onLitChange === undefined
    ? { lit: own, setLit: setOwn }
    : { lit: lit ?? null, setLit: onLitChange };
}

/** The inspector: the lit pass's card, the passes, the satellite link. */
export function ImageryTab(props: BodyTabProps) {
  return (
    <ReadBoundary
      resetKey={props.bodyId}
      fallback={<ReadFailed>This tab couldn’t be drawn</ReadFailed>}
    >
      <ImageryReads {...props} />
    </ReadBoundary>
  );
}

function ImageryReads(props: BodyTabProps) {
  const { lit, setLit } = useLit(props);
  const waterBodyId = props.bodyId as Id<'waterBodies'>;
  const { result, body, band, rows, timeline, retry } = usePasses(props.bodyId, lit);
  const setMode = useMutation(api.waterBodies.setSatelliteImagery);
  const { can } = useRole();
  const { announce } = useUndo();
  const now = useDayClock();

  if (result === undefined) {
    return (
      <TabBody aria-busy="true">
        <LoadingSection lines={4} />
        <LoadingSection lines={3} />
      </TabBody>
    );
  }
  if (result instanceof Error) {
    return <ReadFailed onRetry={retry}>This body couldn’t be read</ReadFailed>;
  }
  if (body === null) return null;
  const coord = linkCoordinate(body);
  const { granuleId } = parsePassAddress(lit);
  return (
    <ImageryTabView
      season={timeline.season === null ? null : winterWord(timeline.season)}
      rows={rows}
      archiveError={timeline.error}
      archiveUnconfigured={!env.imageryArchiveUrl}
      onRetry={retry}
      lit={granuleId}
      onLitChange={(id) => setLit(passAddress(band, id))}
      // The pass override's writer isn't on the server yet: drawn, and not available yet.
      {...(can('body.water') ? { onOverride: UNAVAILABLE } : {})}
      satellite={{
        mode: body.satelliteImagery ?? 'auto',
        name: body.name,
        areaSqM: body.surfaceAreaSqM,
        url: coord === undefined ? null : copernicusUrl(coord, now),
      }}
      {...(can('body.water')
        ? {
            onSatelliteChange: async (mode: SatelliteImageryMode) => {
              try {
                await setMode({ waterBodyId, mode });
              } catch (err) {
                throw new Error(errorText(err));
              }
              await announce({
                title: 'Satellite link set',
                target: { targetType: 'waterbody', targetId: waterBodyId },
              });
            },
          }
        : {})}
    />
  );
}

/**
 * The dock at the map's foot: the passes as notches, the lit pass's caption, the band. The frame
 * mounts it in the map's foot slot; it reads the same `?lit=` as the inspector.
 */
export function ImageryDock(props: BodyTabProps) {
  const { lit, setLit } = useLit(props);
  const { band, rows, timeline } = usePasses(props.bodyId, lit);
  if (rows === undefined) return null;
  return (
    <ImageryDockView
      rows={rows}
      selected={selectedPass(rows, parsePassAddress(lit).granuleId)}
      onSelect={(i) => {
        const row = rows[i];
        if (row !== undefined) setLit(passAddress(band, row.id));
      }}
      bands={timeline.index === null ? [band] : bandsIn(timeline.index)}
      band={band}
      // A new band opens on its own default pass.
      onBandChange={(next) => setLit(passAddress(next))}
    />
  );
}

/**
 * The map's data: the passes in the lit address's band (a band chosen in the dock), and the
 * archive's season for the picture's credit, kept until they change.
 */
function useImageryMapData(bodyId: string, lit: string | null): ImageryMapData | undefined {
  const { band, rows, timeline } = usePasses(bodyId, lit);
  const season = timeline.season;
  return useMemo(
    () => (rows === undefined ? undefined : { rows, band, season }),
    [rows, band, season],
  );
}

/** The Imagery tab's registration in the frame's registry: the inspector, the map and the dock. */
export const IMAGERY_TAB: BodyTabRegistration<ImageryMapData> = {
  Wiring: ImageryTab,
  map: { useData: useImageryMapData, describe: imageryMapScene },
  Dock: ImageryDock,
};

/** Copernicus' window is the last 14 days from now: moved on daily. */
function useDayClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 86_400_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}
