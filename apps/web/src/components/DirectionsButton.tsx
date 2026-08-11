import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import {
  chooseAccessTarget,
  type DirectionsPlatform,
  directionsUrl,
  isHikeIn,
} from '@skating/core';
import { useQuery } from 'convex/react';
import { buttonVariants } from './ui/button';

/** Detect the platform for the directions deep link — Apple Maps on iOS, Google Maps elsewhere. */
function detectPlatform(): DirectionsPlatform {
  if (typeof navigator === 'undefined') return 'web';
  return /iPhone|iPad|iPod/.test(navigator.userAgent) ? 'ios' : 'web';
}

/**
 * Directions button on the lake detail drawer (Phase 4 decision #7; re-targeted by N6d / D72).
 *
 * **What changed, and why it is the whole point of the phase.** This used to route a car to a *put-in*
 * coord. For a drive-up launch that is right; for a hike-in pond it is a destination a maps app cannot
 * route to, and the skater finds out at the trailhead, in winter, an hour from home. So the target is
 * now the **parking area** when the launch has one, and the drawer's approach line says what remains
 * on foot.
 *
 * `directionsUrl` itself is unchanged — the fix is entirely in which coordinate is handed to it, which
 * is why D72 could be additive. The choice lives in `chooseAccessTarget` so this button and the mobile
 * one cannot disagree about which way in they are recommending.
 *
 * Renders nothing when a lake has no known access point. That is most of the corpus, and it is the
 * honest answer: the alternative is the on-water centroid, which routes you into the lake.
 */
export function DirectionsButton({ waterBodyId }: { waterBodyId: Id<'waterBodies'> }) {
  const access = useQuery(api.accessPoints.accessForBody, { waterBodyId });
  const legacy = useQuery(api.putIns.listForBody, { waterBodyId });

  const target = access
    ? chooseAccessTarget(access.putIns, access.parking, new Set(access.blockedIds))
    : null;

  // Fall back to the derived clusters when nothing is stored. They have no parking and no id, so they
  // cannot go through the resolver — but a lake whose only access signal is "people put in around
  // here" should still offer directions, exactly as it did before this phase.
  const fallback = !target && legacy && legacy.length > 0 ? legacy[0] : null;
  const coord = target?.coord ?? fallback?.coord;
  if (!coord) return null;

  const approximate = target
    ? target.via === 'put_in' && target.putIn.source !== 'official'
    : fallback?.source !== 'official';

  return (
    <a
      href={directionsUrl(coord, detectPlatform())}
      target="_blank"
      rel="noopener noreferrer"
      className={buttonVariants({ variant: 'outline' })}
    >
      {target?.via === 'parking' ? 'Directions to parking' : 'Directions'}
      {approximate ? ' (approx. put-in)' : ''}
      {isHikeIn(target?.approachKind) ? ' · hike-in' : ''}
    </a>
  );
}
