import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { bandsIn, copernicusUrl, linkCoordinate, type SatelliteImageryMode } from '@skating/core';
import { useMutation } from 'convex/react';
import { useEffect, useMemo, useState } from 'react';

import {
  isFailed,
  read,
  useConsoleReadSet,
  useExternalRead,
} from '@/components/admin/reads/consoleReads';
import { ReadNote } from '@/components/admin/reads/ReadNote';
import { useUndo } from '@/components/admin/shell/undo';
import { UNAVAILABLE } from '@/components/kit/unavailable-button';
import { useFreezeUpTimeline } from '@/components/useFreezeUpTimeline';
import { env } from '@/lib/env';
import { useRole } from '@/lib/useRole';
import { sendFor, useBodyHold } from '../../frame/currentBody';
import type { BodyTabProps, BodyTabRegistration } from '../../frame/tabRegistry';
import { LoadingSection, TabBody, useTickingNow } from '../tabParts';
import { ImageryDockView } from './ImageryDockView';
import { ImageryTabView } from './ImageryTabView';
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
  const { reads: got, retry } = useConsoleReadSet({
    body: read(api.waterBodies.get, { waterBodyId: bodyId as Id<'waterBodies'> }),
  });
  const result = got.body;
  const body =
    result !== undefined && !isFailed(result) && result?.available === true ? result.body : null;
  const { band } = parsePassAddress(lit);
  // The archive is read outside Convex, in the same registry: Try again lets go of it for a
  // commit (`live` false), so it is asked again.
  const archive = useExternalRead(`imagery-archive:${bodyId}`);
  const timeline = useFreezeUpTimeline({ body, band, enabled: body !== null && archive.live });
  const rows: PassRow[] | undefined = useMemo(
    () => (timeline.timeline === null ? undefined : passRows(timeline.timeline.stops)),
    [timeline.timeline],
  );
  // The registry holds no wait for a reader outside Convex, so the archive's own is held here: from
  // Try again (`asked`), through the commit it is asked afresh (`asking`, the timeline's own fetch
  // started in that commit's effects, declared before this one), until its loading settles — a
  // failure again or the passes. Meanwhile the note stays, as *Trying again…*.
  const [archiveWait, setArchiveWait] = useState<'none' | 'asked' | 'asking'>('none');
  useEffect(() => {
    if (archiveWait === 'asked' && archive.live) setArchiveWait('asking');
    else if (archiveWait === 'asking' && !timeline.loading) setArchiveWait('none');
  }, [archiveWait, archive.live, timeline.loading]);
  const waiting = archiveWait !== 'none';
  // Try again re-runs the failed body read and lets go of the archive.
  const tryAgain = () => {
    retry();
    if (timeline.error) setArchiveWait('asked');
    archive.retry();
  };
  return {
    result,
    body,
    band,
    rows,
    timeline,
    retry: tryAgain,
    archiveError: timeline.error || waiting,
    archivePending: waiting,
  };
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
  return <ImageryReads {...props} />;
}

function ImageryReads(props: BodyTabProps) {
  const { lit, setLit } = useLit(props);
  const waterBodyId = props.bodyId as Id<'waterBodies'>;
  const { result, body, band, rows, timeline, retry, archiveError, archivePending } = usePasses(
    props.bodyId,
    lit,
  );
  const setMode = useMutation(api.waterBodies.setSatelliteImagery);
  const { can } = useRole();
  const { announce } = useUndo();
  const hold = useBodyHold();
  // Copernicus' window is the last 14 days from now: moved on daily.
  const now = useTickingNow(86_400_000);

  if (result === undefined) {
    return (
      <TabBody aria-busy="true">
        {/* The tab's note, mounted from the first state, so a failure's words are announced. */}
        <ReadNote reads={[result]}>This body couldn’t be read</ReadNote>
        <LoadingSection lines={4} />
        <LoadingSection lines={3} />
      </TabBody>
    );
  }
  if (isFailed(result)) {
    return (
      <TabBody>
        <ReadNote reads={[result]}>This body couldn’t be read</ReadNote>
      </TabBody>
    );
  }
  if (body === null) return null;
  const coord = linkCoordinate(body);
  const { granuleId } = parsePassAddress(lit);
  return (
    <ImageryTabView
      season={timeline.season === null ? null : winterWord(timeline.season)}
      rows={rows}
      archiveError={archiveError}
      archiveUnconfigured={!env.imageryArchiveUrl}
      onRetry={retry}
      retryPending={archivePending}
      lit={granuleId}
      onLitChange={(id) => setLit(passAddress(band, id))}
      // The pass override's writer isn't on the server yet: drawn, and not available yet.
      {...(can('body.water') ? { onOverride: UNAVAILABLE } : {})}
      satellite={{
        bodyId: waterBodyId,
        mode: body.satelliteImagery ?? 'auto',
        name: body.name,
        areaSqM: body.surfaceAreaSqM,
        url: coord === undefined ? null : copernicusUrl(coord, now),
      }}
      {...(can('body.water')
        ? {
            onSatelliteChange: async (mode: SatelliteImageryMode) => {
              await sendFor(hold, {
                body: waterBodyId,
                write: () => setMode({ waterBodyId, mode }),
                receipt: (subject) =>
                  announce({
                    title: 'Satellite link set',
                    target: { targetType: 'waterbody', targetId: waterBodyId },
                    subject,
                  }),
                what: 'The satellite link',
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
