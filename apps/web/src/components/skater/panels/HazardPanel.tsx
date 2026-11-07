import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import {
  ALSO_A_KNOWN_FEATURE,
  confirmerClause,
  consensusSummary,
  disputedNote,
  expiredCrossingNote,
  formatSeason,
  freshnessLabel,
  type HazardVerdict,
  hazardTypeLabel,
  healingNote,
  isLeaving,
  isPassageMarker,
  seasonOf,
  stalenessCaveat,
} from '@skating/core';
import { useMutation, useQuery } from 'convex/react';
import { useMemo, useState } from 'react';

import { useAnalytics, type HazardVerdict as VerdictEvent } from '@/lib/analytics';

import { HazardModeratorControls } from '../../admin/HazardModeratorControls';
import { panelMapSpec } from '../map/mapSpec';
import { useMapSpec } from '../map/useMapSpec';
import { FlagDialog } from './FlagDialog';
import { type HazardPanelData, HazardPanelView } from './HazardPanelView';
import { InsetCard, PanelLoading, PanelUnavailable } from './InsetCard';
import { panelTriggerKey, useClosePanel, usePanelViewed } from './panelNavigation';
import { dayLabel } from './panelTime';
import { RatingsRow, writeError } from './RatingsRow';
import { PANEL_LOADING_SPEC } from './ReportPanel';
import { WeatherSince } from './WeatherSince';

/**
 * The verdict as the analytics taxonomy names it (D240) — the author's own claim, as labeled. "Never
 * was" has no name in the taxonomy yet, so it isn't counted (a seam request, not a guess).
 */
export const VERDICT_EVENT: Readonly<Record<HazardVerdict, VerdictEvent | null>> = {
  still_there: 'still_there',
  healing_unsafe: 'healing',
  fully_healed: 'fully_healed',
  never_existed: null,
};

/**
 * `/hazard/$id` (boards 2.1–2.3): the hazard as an inset card over its lake. Reads the hazard, its
 * photos, its reporter and who confirmed it; brackets its mark on the map (`panelMapSpec` with the
 * hazard focused); and takes a verdict through `hazardConfirmations.confirm`.
 */
export function HazardPanel({ hazardId, action }: { hazardId: string; action?: 'confirm' }) {
  const hid = hazardId as Id<'hazards'>;
  const now = useMemo(() => Date.now(), []);
  const analytics = useAnalytics();
  const hazard = useQuery(api.hazards.get, { hazardId: hid });
  const photos = useQuery(api.photos.getHazardUrls, { hazardId: hid });
  const body = useQuery(api.waterBodies.get, hazard ? { waterBodyId: hazard.waterBodyId } : 'skip');
  const reporters = useQuery(
    api.profiles.publicByIds,
    hazard ? { profileIds: [hazard.createdByUserId] } : 'skip',
  );
  // The other pins drawn as one outline with this one (D80); empty for nearly every hazard.
  const cluster = useQuery(api.hazards.listClusterMembers, { hazardId: hid });
  const confirmations = useQuery(api.hazardConfirmations.listForHazard, { hazardId: hid });
  const me = useQuery(api.profiles.current, {});
  const confirm = useMutation(api.hazardConfirmations.confirm);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const bodyId = body?.available ? body.body._id : hazard?.waterBodyId;
  const spec = useMemo(
    () => (bodyId === undefined ? PANEL_LOADING_SPEC : panelMapSpec(bodyId, { hazardId })),
    [bodyId, hazardId],
  );
  useMapSpec(spec);
  usePanelViewed('hazard_viewed', hazardId);
  const lake = useMemo(() => (bodyId === undefined ? null : { bodyId }), [bodyId]);
  const close = useClosePanel(lake);
  const lakeName = body?.available ? body.body.name : null;

  const common = {
    onClose: close,
    returnKey: panelTriggerKey('hazard', hazardId),
    label: 'Hazard',
  };

  if (hazard === undefined) {
    return (
      <InsetCard {...common} backTo={null}>
        <PanelLoading />
      </InsetCard>
    );
  }
  if (hazard === null) {
    return (
      <InsetCard {...common} backTo="Explore">
        {/* Never "it's gone": it may be hidden by a moderator, and "removed from view" must not
            reach a skater as "no longer there" (D3). */}
        <PanelUnavailable title="Hazard not found">
          This marker isn’t available. The link may be broken, or it may have been removed from the
          map.
        </PanelUnavailable>
      </InsetCard>
    );
  }

  const reporter = reporters?.[hazard.createdByUserId] ?? null;
  const isOwn = me?._id === hazard.createdByUserId;
  const leaving = isLeaving(me);
  const archived = hazard.status !== 'active';
  const passage = isPassageMarker(hazard.type);
  // Named where the confirmer's profile is public, counted where it isn't (D65); the reporter's own
  // vote is never counted, so never named either (D54).
  const confirmerNames = (confirmations ?? [])
    .filter((c) => c.verdict === 'still_there' && !c.isAuthor && c.displayName !== undefined)
    .map((c) => c.displayName as string);
  const confirmed = confirmerClause(confirmerNames, hazard.confirmCount);
  const healing = hazard.healingState === 'healing_unsafe';
  const disputed = hazard.healingState === 'disputed';

  const notes: string[] = [];
  if (seasonOf(hazard.firstReportedAt) !== seasonOf(now)) {
    notes.push(
      `From the ${formatSeason(seasonOf(hazard.firstReportedAt))} season. It isn’t on the map this winter.`,
    );
  }
  if (hazard.expired) notes.push(expiredCrossingNote());
  if (cluster && cluster.length > 1) notes.push(consensusSummary(cluster.length));
  if (hazard.promotedFeatureType !== undefined) notes.push(ALSO_A_KNOWN_FEATURE);
  if (hazard.freshness !== 'fresh') notes.push(stalenessCaveat(hazard.type));
  // A disputed crossing outranks a healing note: it's the stronger claim (D64).
  if (disputed) notes.push(disputedNote());
  else if (healing) notes.push(healingNote(hazard.type));

  const badges = [
    hazard.provisional ? 'Unconfirmed' : null,
    disputed ? 'Disputed' : null,
    healing ? 'Reported healing' : null,
    passage ? 'Crossing point' : null,
    hazard.expired ? 'Aged off the map' : null,
    archived ? 'Retired' : null,
  ].filter((b): b is string => b !== null);

  const data: HazardPanelData = {
    hazardId,
    type: hazard.type,
    title: hazardTypeLabel(hazard.type),
    bodyId: bodyId ?? hazard.waterBodyId,
    bodyName: lakeName,
    ...(hazard.subAreaName !== undefined ? { subAreaName: hazard.subAreaName } : {}),
    freshnessLabel: freshnessLabel(hazard.freshness),
    fresh: hazard.freshness === 'fresh',
    badges,
    reporter:
      reporter === null
        ? null
        : {
            displayName: reporter.displayName,
            username: reporter.username,
            ...(reporter.profileImageUrl !== undefined
              ? { profileImageUrl: reporter.profileImageUrl }
              : {}),
            ...(reporter.deleted ? { deleted: true as const } : {}),
          },
    byline: [
      `Reported ${dayLabel(hazard.firstReportedAt, now)}${reporter !== null ? ` by ${reporter.displayName}` : ''}`,
      confirmed ?? 'nobody else has confirmed it yet',
    ].join(' · '),
    notes,
    ...(hazard.description !== undefined ? { description: hazard.description } : {}),
    photos: photos ?? [],
  };

  const onVerdict = async (verdict: HazardVerdict) => {
    setConfirming(true);
    setConfirmError(null);
    try {
      await confirm({ hazardId: hid, verdict, via: 'app_open_nearby' });
      const counted = VERDICT_EVENT[verdict];
      if (counted !== null) analytics.capture('hazard_verdict_submitted', { verdict: counted });
    } catch (err) {
      // Web has no offline queue: a vote that didn't land must say so, or the skater walks away
      // believing they warned the next person.
      setConfirmError(writeError(err, 'Not sent. Check your connection and try again.'));
    } finally {
      setConfirming(false);
    }
  };

  return (
    <InsetCard
      {...common}
      backTo={lakeName}
      foot={
        <>
          <RatingsRow
            targetType="hazard"
            targetId={hazardId}
            canRate={!!me && !isOwn && !leaving}
          />
          {me ? (
            <span className="ml-auto">
              <FlagDialog target="hazard" targetId={hazardId} />
            </span>
          ) : null}
        </>
      }
    >
      <HazardPanelView
        data={data}
        confirming={confirming}
        confirmError={confirmError}
        {...(action !== undefined ? { action } : {})}
        // A retired marker takes no verdicts, and neither does a leaving account (D62): withholding
        // the handler removes the control rather than leaving it to be pressed and refused.
        {...(archived || leaving || !me
          ? {}
          : { onVerdict: (v: HazardVerdict) => void onVerdict(v) })}
        weather={
          // Only an active marker fetches the weather around it.
          archived ? undefined : (
            <WeatherSince
              hazardId={hazardId}
              label="Recent weather here"
              since={`Since ${dayLabel(hazard.lastConfirmedAt, now)}`}
              {...(hazard.snowHidden ? { caveat: 'Possibly snow-hidden.' } : {})}
            />
          )
        }
        moderator={me ? <HazardModeratorControls hazardId={hazardId} /> : undefined}
      />
    </InsetCard>
  );
}
