import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import {
  BODY_FEATURE_CAVEAT,
  confirmerSummary,
  disputedNote,
  FOOTPRINT_IS_APPROXIMATE,
  formatLocationLine,
  freshnessLabel,
  type HazardFreshness,
  type HazardType,
  type HazardVerdict,
  hazardTypeLabel,
  healingNote,
  isLeaving,
  isPassageMarker,
  stalenessCaveat,
  type TrustClass,
  verdictHelp,
  verdictLabel,
} from '@skating/core';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery } from 'convex/react';
import { ConvexError } from 'convex/values';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { HazardModeratorControls } from './admin/HazardModeratorControls';
import { DetailSkeleton, UnavailableState } from './DrawerStates';
import { useMapSelection } from './MapSelectionContext';
import { FlagDialog } from './SafetyControls';
import { ThumbControl } from './ThumbControl';
import { TrustAvatar } from './TrustDisplay';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Separator } from './ui/separator';
import { SheetDescription, SheetHeader, SheetTitle } from './ui/sheet';
import { WeatherStrip } from './WeatherStrip';

/** The plain data a hazard renders from — decoupled from Convex so `HazardView` is testable. */
export interface HazardViewData {
  hazardId: string;
  waterBodyId: string;
  bodyName?: string;
  /** The named sub-area the footprint sits in (N2/D60), composed ahead of the lake. */
  subAreaName?: string;
  type: HazardType;
  freshness: HazardFreshness;
  provisional: boolean;
  healing: boolean;
  /** A suggested crossing somebody has reported closed — one vote short of retiring it (D64). */
  disputed: boolean;
  archived: boolean;
  description?: string;
  /**
   * Rendered as "… by <name>" (with a `TrustAvatar` ring) when present. The container resolves it from
   * the hazard's author via `profiles.publicByIds`; until then the author line is simply omitted.
   */
  reporterName?: string;
  reporterImageUrl?: string;
  /** The reporter's cosmetic trust class (D50) — the `TrustAvatar` ring color; `null`/absent ⇒ no ring. */
  reporterTrustClass?: TrustClass | null;
  firstReportedAt: number;
  lastConfirmedAt: number;
  confirmCount: number;
  /** Public confirmers, in vote order — private profiles are counted in `confirmCount`, never named. */
  confirmerNames?: string[];
  photos: { photoId: string; url: string | null; thumbUrl: string | null; caption?: string }[];
}

/**
 * The verdicts, in the order they're offered — destructive last, and `never_existed` last of all: it
 * is the only one that is a claim about the *report* rather than about the ice (D65), and the only one
 * that puts the pin in front of a moderator.
 */
const VERDICTS: HazardVerdict[] = [
  'still_there',
  'healing_unsafe',
  'fully_healed',
  'never_existed',
];

function formatWhen(at: number): string {
  const hours = (Date.now() - at) / 3_600_000;
  if (hours < 1) return 'less than an hour ago';
  if (hours < 24) return `${Math.round(hours)} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/**
 * Presentational hazard renderer.
 *
 * Every word describing hazard *state* comes from `@skating/core`'s copy helpers rather than being
 * written here — that's the point of centralizing them: the D3 rule "we never assert ice is safe" is
 * enforced by one tested module instead of by reviewing every component that mentions a hazard.
 */
export function HazardView({
  data,
  onConfirm,
  confirming,
  confirmError,
  flagControl,
  thumbControl,
  weatherStrip,
  action,
}: {
  data: HazardViewData;
  onConfirm?: (verdict: HazardVerdict) => void;
  confirming?: boolean;
  /**
   * Why the last verdict didn't land. A dropped confirmation must say so: silently swallowing it
   * leaves the skater believing they've warned the next person when they haven't (D3).
   */
  confirmError?: string | null;
  /**
   * The flag control, injected by the container. It needs a Convex mutation, and this component is
   * deliberately Convex-free so it can be rendered from a fixture in a test.
   */
  flagControl?: ReactNode;
  /** The helpful/unhelpful thumbs control, injected by the container (Convex-free view, D40). */
  thumbControl?: ReactNode;
  /** The recent-weather strip node (Phase 10 / §3); the container builds it so the view stays Convex-free. */
  weatherStrip?: ReactNode;
  /**
   * Deep-link intent (D54 Layer 2). `confirm` lands from an on-ice notification tap and scrolls the
   * three-tier confirm control into view. It never *expands* the destructive "fully healed" step —
   * that stays gated behind its own second tap even when deep-linked, because a false all-clear is
   * the worst outcome this screen can produce (D3).
   */
  action?: 'confirm';
}) {
  // The destructive verdict gets a confirm step. It's the only one that retires a pin for everyone,
  // and a mis-tap that clears a real hazard is the worst outcome this UI can produce (D3).
  const [pendingHealed, setPendingHealed] = useState(false);
  const passage = isPassageMarker(data.type);

  // When deep-linked with `?action=confirm`, bring the confirm control into view. Guarded on the
  // section actually rendering (`onConfirm && !archived`) so we never scroll to nothing on a retired
  // hazard. Focus (not just scroll) so a keyboard/screen-reader user also lands on the control.
  const confirmSectionRef = useRef<HTMLDivElement>(null);
  const confirmVisible = Boolean(onConfirm) && !data.archived;
  useEffect(() => {
    if (action !== 'confirm' || !confirmVisible) return;
    const node = confirmSectionRef.current;
    if (!node) return;
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    node.focus({ preventScroll: true });
  }, [action, confirmVisible]);

  return (
    <>
      <SheetHeader>
        <SheetTitle>{hazardTypeLabel(data.type)}</SheetTitle>
        <SheetDescription>
          {data.bodyName ? (
            <Link
              to="/water/$id"
              params={{ id: data.waterBodyId }}
              className="underline underline-offset-2"
            >
              {formatLocationLine({
                ...(data.subAreaName !== undefined ? { subAreaName: data.subAreaName } : {}),
                bodyName: data.bodyName,
              })}
            </Link>
          ) : null}
        </SheetDescription>
      </SheetHeader>

      <div className="space-y-4 px-4 pb-6">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={data.freshness === 'fresh' ? 'default' : 'secondary'}>
            {freshnessLabel(data.freshness)}
          </Badge>
          {data.provisional ? <Badge variant="outline">Unconfirmed</Badge> : null}
          {data.disputed ? <Badge variant="secondary">Disputed</Badge> : null}
          {data.healing ? <Badge variant="secondary">Reported healing</Badge> : null}
          {passage ? <Badge variant="outline">Crossing point</Badge> : null}
          {data.archived ? <Badge variant="outline">Retired</Badge> : null}
        </div>

        <div className="flex items-center gap-2 text-foreground-muted text-sm">
          {data.reporterName ? (
            <TrustAvatar
              displayName={data.reporterName}
              imageUrl={data.reporterImageUrl}
              trustClass={data.reporterTrustClass}
              size={20}
            />
          ) : null}
          <span>
            Reported {formatWhen(data.firstReportedAt)}
            {data.reporterName ? ` by ${data.reporterName}` : ''}
            {data.confirmCount > 0
              ? // Named where the skater's profile is public, counted where it isn't (D65): a
                // confirmation from someone you can look up carries weight a bare number doesn't, and
                // it discloses more than a report does, so it follows the consent already given.
                ` · ${confirmerSummary(data.confirmerNames ?? [], data.confirmCount)?.toLowerCase()}`
              : ' · nobody else has confirmed it yet'}
            .
          </span>
        </div>

        {/* The sentence that has to do the work of not sounding like an all-clear. */}
        {data.freshness !== 'fresh' ? (
          <p className="rounded-md bg-surface-muted p-3 text-sm">{stalenessCaveat(data.type)}</p>
        ) : null}
        {/* A disputed crossing outranks a healing note: "the ridge is closed here" is a stronger
            claim than "the crossing is dicey", and it is the one to read first (D64). */}
        {data.disputed ? (
          <p className="rounded-md bg-surface-muted p-3 text-sm">{disputedNote()}</p>
        ) : data.healing ? (
          <p className="rounded-md bg-surface-muted p-3 text-sm">{healingNote(data.type)}</p>
        ) : null}

        {data.description ? <p className="text-sm">{data.description}</p> : null}

        {weatherStrip}

        {data.photos.length > 0 ? (
          <div className="grid grid-cols-2 gap-2">
            {data.photos.map((photo) =>
              photo.thumbUrl ? (
                <img
                  key={photo.photoId}
                  src={photo.thumbUrl}
                  alt={photo.caption ?? `${hazardTypeLabel(data.type)} photo`}
                  className="h-32 w-full rounded-md object-cover"
                />
              ) : null,
            )}
          </div>
        ) : null}

        <p className="text-foreground-muted text-xs">{FOOTPRINT_IS_APPROXIMATE}</p>

        {onConfirm && !data.archived ? (
          <>
            <Separator />
            {/* tabIndex -1 makes this focusable for the `?action=confirm` deep link without adding it
                to the tab order. `scroll-mt-4` leaves a little breathing room above when scrolled to. */}
            <div
              ref={confirmSectionRef}
              tabIndex={-1}
              className="scroll-mt-4 space-y-2 outline-none"
            >
              <h3 className="font-medium text-sm">
                {passage ? 'Been through here?' : 'Seen this recently?'}
              </h3>
              {VERDICTS.map((verdict) => {
                const destructive = verdict === 'fully_healed';
                if (destructive && pendingHealed) {
                  return (
                    <div
                      key={verdict}
                      className="space-y-2 rounded-md border border-destructive p-3"
                    >
                      <p className="text-sm">
                        This retires the marker for everyone once one more skater agrees. Only if
                        the ice here is genuinely sound.
                      </p>
                      <div className="flex gap-2">
                        <Button
                          variant="destructive"
                          size="sm"
                          disabled={confirming}
                          onClick={() => {
                            setPendingHealed(false);
                            onConfirm(verdict);
                          }}
                        >
                          Yes, it's fully healed
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => setPendingHealed(false)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  );
                }
                return (
                  <button
                    key={verdict}
                    type="button"
                    disabled={confirming}
                    onClick={() => (destructive ? setPendingHealed(true) : onConfirm(verdict))}
                    className={`w-full rounded-md border p-3 text-left disabled:opacity-50 ${
                      destructive
                        ? 'border-border text-foreground-muted hover:bg-surface-muted'
                        : 'border-border hover:bg-surface-muted'
                    }`}
                  >
                    <span className={destructive ? 'text-sm' : 'font-medium text-sm'}>
                      {verdictLabel(verdict, data.type)}
                    </span>
                    <span className="block text-foreground-muted text-xs">
                      {verdictHelp(verdict, data.type)}
                    </span>
                  </button>
                );
              })}
              {confirmError ? (
                <p role="alert" className="text-destructive text-sm">
                  {confirmError}
                </p>
              ) : null}
            </div>
          </>
        ) : null}

        {thumbControl ? (
          <>
            <Separator />
            {thumbControl}
          </>
        ) : null}

        {flagControl ? (
          <>
            <Separator />
            {flagControl}
          </>
        ) : null}
      </div>
    </>
  );
}

/** Container: resolves the hazard + its photos, pushes map focus, and wires the confirm mutation. */
export function HazardDetail({ hazardId, action }: { hazardId: string; action?: 'confirm' }) {
  const hazard = useQuery(api.hazards.get, { hazardId: hazardId as Id<'hazards'> });
  const photos = useQuery(api.photos.getHazardUrls, { hazardId: hazardId as Id<'hazards'> });
  const body = useQuery(api.waterBodies.get, hazard ? { waterBodyId: hazard.waterBodyId } : 'skip');
  const reporters = useQuery(
    api.profiles.publicByIds,
    hazard ? { profileIds: [hazard.createdByUserId] } : 'skip',
  );
  // Who has confirmed it (D65). Only names that came back — a private profile confirms without being
  // named, and `confirmCount` is what keeps that honest rather than a shorter list quietly meaning
  // fewer people looked.
  const confirmations = useQuery(api.hazardConfirmations.listForHazard, {
    hazardId: hazardId as Id<'hazards'>,
  });
  const confirmerNames = (confirmations ?? [])
    .filter((c) => c.verdict === 'still_there' && c.displayName !== undefined)
    .map((c) => c.displayName as string);
  const me = useQuery(api.profiles.current, {});
  const confirm = useMutation(api.hazardConfirmations.confirm);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const { setFocus, setHighlightWaterBodyId } = useMapSelection();

  useEffect(() => {
    if (!hazard) return;
    const centre = {
      lat: (hazard.bbox.minLat + hazard.bbox.maxLat) / 2,
      lng: (hazard.bbox.minLng + hazard.bbox.maxLng) / 2,
    };
    setFocus({ ...centre, zoom: 14 });
    setHighlightWaterBodyId(hazard.waterBodyId);
  }, [hazard, setFocus, setHighlightWaterBodyId]);

  if (hazard === undefined) return <DetailSkeleton />;
  if (hazard === null) {
    return (
      <UnavailableState
        title="Hazard not found"
        // Deliberately does not say the hazard is gone: it may have been hidden by a moderator, and
        // "removed from view" must never be reported to a skater as "no longer there" (D3).
        message="This marker isn't available. The link may be broken, or it may have been removed from the map."
      />
    );
  }

  const bodyName = body?.available ? body.body.name : undefined;
  const reporter = reporters?.[hazard.createdByUserId];
  const isOwn = me?._id === hazard.createdByUserId;

  const handleConfirm = async (verdict: HazardVerdict) => {
    setConfirming(true);
    setConfirmError(null);
    try {
      await confirm({
        hazardId: hazardId as Id<'hazards'>,
        verdict,
        via: 'app_open_nearby',
      });
    } catch (err) {
      // A vote that didn't land has to say so. Web has no offline queue (that's the mobile flush
      // service), so the only honest thing here is to tell the skater it didn't send — silence would
      // let them walk away believing they'd warned the next person.
      setConfirmError(
        err instanceof ConvexError
          ? String(err.data)
          : err instanceof Error
            ? err.message
            : 'Could not record that — check your connection and try again.',
      );
    } finally {
      setConfirming(false);
    }
  };

  return (
    <HazardView
      data={{
        hazardId,
        waterBodyId: hazard.waterBodyId,
        bodyName,
        subAreaName: hazard.subAreaName,
        type: hazard.type,
        freshness: hazard.freshness,
        provisional: hazard.provisional,
        healing: hazard.healingState === 'healing_unsafe',
        disputed: hazard.healingState === 'disputed',
        // Any non-active status is "retired" for display (unified with mobile): a new status defaults to
        // hidden strip / no-confirm rather than silently rendering as active.
        archived: hazard.status !== 'active',
        description: hazard.description,
        // Phase 6 wires the reporter through `publicByIds` so the author line carries the TrustAvatar
        // ring + avatar (superseding Phase 9.5's plain `hazard.reporterName`).
        reporterName: reporter?.displayName,
        reporterImageUrl: reporter?.profileImageUrl,
        reporterTrustClass: reporter?.trustClass,
        firstReportedAt: hazard.firstReportedAt,
        lastConfirmedAt: hazard.lastConfirmedAt,
        confirmCount: hazard.confirmCount,
        confirmerNames,
        photos: photos ?? [],
      }}
      weatherStrip={
        // Only active hazards show recent weather — a retired/archived pin needn't hit Open-Meteo (§3).
        hazard.status !== 'active' ? undefined : (
          <WeatherStrip
            hazardId={hazard._id}
            label="Recent weather here"
            caveat={hazard.snowHidden ? 'Possibly snow-hidden.' : undefined}
          />
        )
      }
      confirming={confirming}
      confirmError={confirmError}
      action={action}
      flagControl={
        <div className="flex flex-col gap-2">
          <FlagDialog targetType="hazard" targetId={hazardId} />
          <HazardModeratorControls hazardId={hazardId} />
        </div>
      }
      thumbControl={
        <ThumbControl
          targetType="hazard"
          targetId={hazardId}
          canRate={!!me && !isOwn && !isLeaving(me)}
        />
      }
      // A pending deletion closes the confirm loop entirely (D62 amendment): `hazardConfirmations.confirm`
      // is a contribution, and withholding the *handler* is what removes the three-tier control rather
      // than leaving it there to be pressed and refused.
      {...(isLeaving(me) ? {} : { onConfirm: handleConfirm })}
    />
  );
}

/** The always-on note under a known seasonal feature (D53) — no age, no confirm loop. */
export function BodyFeatureNote() {
  return <p className="text-foreground-muted text-xs">{BODY_FEATURE_CAVEAT}</p>;
}
