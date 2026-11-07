import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { type AccessAlertReason, MAX_ACCESS_PHOTOS } from '@skating/core';
import { useMutation, useQuery } from 'convex/react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/kit/button';
import { Section } from '@/components/kit/section-slug';
import { Skeleton } from '@/components/kit/skeleton';
import { useAnalytics } from '@/lib/analytics';

import { usePhotoDrafts } from '../../usePhotoDrafts';
import {
  AccessAlertBox,
  AccessPhotoStrip,
  AccessProblemPopover,
  DerivedPutInCard,
  ParkingRow,
  PutInCard,
} from './access/AccessViews';
import {
  type AccessAlertModel,
  derivedPutIns,
  detectPlatform,
  lotDirections,
  lotLine,
  otherParking,
  PUT_INS_PAGE,
  type PutInCardModel,
  putInCards,
} from './access/accessModel';
import { TabStack } from './ReportsTab';

/**
 * **The Getting there tab (board 1.8).** One card per put-in — core's recommended way in first —
 * with the walk kept apart from any drive, the signs, the lot, the live access alerts and their
 * votes, photos, and directions to the lot (or the put-in). Each card's corner button opens the
 * access-problem popover (the quick path); with no stored launch to report against, "Report an
 * access problem" opens the action pane through `onReportProblem` (`?act=access-problem`).
 *
 * Renders an honest absence when nothing is on file — never a centroid to route into the lake.
 */
export interface AccessTabProps {
  /** The lake (the merge survivor's id). */
  waterBodyId: string;
  /** The bay in view (`?sub=`), when there is one. */
  subAreaId?: string;
  /** Opens the access-problem action over the sidebar (`?act=access-problem`). */
  onReportProblem: () => void;
}

export function AccessTab({ waterBodyId, subAreaId, onReportProblem }: AccessTabProps) {
  const { capture } = useAnalytics();
  const lakeId = waterBodyId as Id<'waterBodies'>;
  const access = useQuery(api.accessPoints.accessForBody, {
    waterBodyId: lakeId,
    ...(subAreaId !== undefined ? { subAreaId: subAreaId as Id<'waterBodySubAreas'> } : {}),
  });
  // The report-derived spots, only asked for when the lake has no stored launch.
  const markers = useQuery(
    api.putIns.listForBody,
    access !== undefined && access.putIns.length === 0 ? { waterBodyId: lakeId } : 'skip',
  );
  const profile = useQuery(api.profiles.current, {});
  const createAlert = useMutation(api.accessAlerts.create);
  const [shown, setShown] = useState(PUT_INS_PAGE);

  const platform = detectPlatform();
  const cards = useMemo(
    () => (access ? putInCards(access, platform, Date.now()) : []),
    [access, platform],
  );
  const derived = useMemo(
    () => (markers ? derivedPutIns(markers, platform, Date.now()) : []),
    [markers, platform],
  );
  const lots = access ? otherParking(access) : [];
  const moderator = profile?.role === 'moderator' || profile?.role === 'admin';
  const opened = (target: 'parking' | 'put_in') => () => capture('directions_opened', { target });

  if (access === undefined) {
    return (
      <TabStack>
        <Section title="Put-ins" level={2} aria-busy="true">
          <Skeleton className="h-[10rem] w-full" />
          <Skeleton className="h-[6rem] w-full" />
        </Section>
      </TabStack>
    );
  }

  const report = (card: PutInCardModel) => (reason: AccessAlertReason, note: string | undefined) =>
    createAlert({
      targetType: 'put_in',
      putInId: card.id as Id<'putIns'>,
      reason,
      ...(note ? { note } : {}),
    });

  const nothing = cards.length === 0 && derived.length === 0 && lots.length === 0;
  const pending = cards.length === 0 && markers === undefined;

  return (
    <TabStack>
      {cards.length > 0 && (
        <Section title="Put-ins" level={2} count={cards.length} data-slot="put-ins">
          {cards.slice(0, shown).map((card) => (
            <PutInCard
              key={card.id}
              card={card}
              problem={<AccessProblemPopover putInName={card.name} onPost={report(card)} />}
              alerts={card.alerts.map((alert) => (
                <ConnectedAlert key={alert.id} alert={alert} moderator={moderator} />
              ))}
              photos={
                <ConnectedPhotos putInId={card.id} name={card.name} always={card.recommended} />
              }
              onDirections={opened(card.directions.target)}
            />
          ))}
          {shown < cards.length && (
            <MoreOnScroll onReach={() => setShown((n) => n + PUT_INS_PAGE)} />
          )}
        </Section>
      )}
      {cards.length === 0 && derived.length > 0 && (
        <Section title="Put-ins" level={2} count={derived.length} data-slot="put-ins">
          {derived.map((d) => (
            <DerivedPutInCard key={d.key} model={d} onDirections={opened('put_in')} />
          ))}
        </Section>
      )}
      {lots.length > 0 && (
        <Section title="Parking" level={2} count={lots.length} data-slot="parking">
          <ul className="m-0 list-none p-0">
            {lots.map((lot) => (
              <ParkingRow
                key={lot.id}
                name={lot.name ?? 'Parking lot'}
                line={lotLine(lot)}
                directions={lotDirections(lot, platform)}
                onDirections={opened('parking')}
              />
            ))}
          </ul>
        </Section>
      )}
      {nothing && !pending && (
        <Section title="Put-ins" level={2} count={0} data-slot="put-ins">
          <p className="m-0 text-row text-fg2 [text-wrap:pretty]">
            No put-ins or parking are on file for this lake yet.
          </p>
        </Section>
      )}
      {cards.length === 0 && !pending && (
        <Button
          size="sm"
          className="self-start"
          data-attr="access-problem-act"
          onClick={onReportProblem}
        >
          Report an access problem
        </Button>
      )}
    </TabStack>
  );
}

/** Reveals the next page of cards when the list's foot scrolls into view (no button, per the board). */
function MoreOnScroll({ onReach }: { onReach: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const latest = useRef(onReach);
  latest.current = onReach;
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      latest.current();
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) latest.current();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return <div ref={ref} aria-hidden="true" data-slot="put-ins-more" className="h-px" />;
}

/** One live alert with its votes (and a moderator's retract). */
function ConnectedAlert({ alert, moderator }: { alert: AccessAlertModel; moderator: boolean }) {
  const vote = useMutation(api.accessAlerts.vote);
  const retract = useMutation(api.accessAlerts.retract);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    action()
      .catch(() => setError('Could not send that. Try again.'))
      .finally(() => setBusy(false));
  };
  const id = alert.id as Id<'accessAlerts'>;
  return (
    <AccessAlertBox
      alert={alert}
      busy={busy}
      error={error}
      onVote={(verdict) => run(() => vote({ accessAlertId: id, verdict }))}
      onRetract={moderator ? () => run(() => retract({ accessAlertId: id })) : null}
    />
  );
}

/**
 * A launch's photos. The strip shows when there are photos, and always on the recommended way in
 * (where the board draws it), so there is a place to add the first one.
 */
function ConnectedPhotos({
  putInId,
  name,
  always,
}: {
  putInId: string;
  name: string;
  always: boolean;
}) {
  const id = putInId as Id<'putIns'>;
  const photos = useQuery(api.accessPoints.listPhotos, { targetType: 'put_in', putInId: id });
  const attach = useMutation(api.accessPoints.attachPhoto);
  const detach = useMutation(api.accessPoints.detachPhoto);
  const drafts = usePhotoDrafts();
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Two steps, because the drafts hook reads its list from the last render: the picked files are
  // processed first, and the upload runs once they are on the list.
  const [armed, setArmed] = useState(false);
  const draftCount = drafts.photos.length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when picked files land on the list.
  useEffect(() => {
    if (!armed) return;
    setArmed(false);
    // Nothing made it onto the list (every file failed to process): the hook's error says why.
    if (draftCount === 0) {
      setUploading(false);
      return;
    }
    // Reuses the shipped upload pipeline unchanged (checkpointed upload, EXIF stripping, the
    // teardown sweep): commit before the attach, so an unmount mid-attach can't reclaim the rows.
    drafts.setCommitted(true);
    drafts
      .uploadAll()
      .then(async (ids) => {
        // Each photo the launch now holds is handed over as its attach lands — never removed, which
        // would delete the row and blobs the attachment points at. A failure part-way leaves only
        // the unattached ones as drafts, reclaimable once `setCommitted(false)` runs below.
        for (const photoId of ids) {
          await attach({ targetType: 'put_in', putInId: id, photoId });
          drafts.release([photoId]);
        }
        drafts.setCommitted(false);
      })
      .catch((err: unknown) => {
        drafts.setCommitted(false);
        setError(err instanceof Error ? err.message : 'Could not attach those photos');
      })
      .finally(() => setUploading(false));
  }, [armed, draftCount]);

  if (photos === undefined || (photos.length === 0 && !always)) return null;

  const add = (files: FileList) => {
    setUploading(true);
    setError(null);
    const room = MAX_ACCESS_PHOTOS - photos.length;
    drafts
      .addFiles(Array.from(files).slice(0, room))
      .then(() => setArmed(true))
      .catch(() => setUploading(false));
  };

  return (
    <AccessPhotoStrip
      name={name}
      photos={photos.map((p) => ({ id: String(p.accessPhotoId), thumbUrl: p.thumbUrl ?? null }))}
      uploading={uploading}
      error={error ?? drafts.error}
      onAdd={add}
      onRemove={(accessPhotoId) =>
        void detach({ accessPhotoId: accessPhotoId as Id<'accessPhotos'> })
      }
    />
  );
}
