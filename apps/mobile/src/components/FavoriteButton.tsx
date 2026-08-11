import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import {
  chooseAccessTarget,
  type DirectionsPlatform,
  directionsUrl,
  isHikeIn,
} from '@skating/core';
import { useMutation, useQuery } from 'convex/react';
import { Linking, Platform } from 'react-native';
import { Button, Text } from 'tamagui';

/**
 * Favorite toggle (Phase 4, decision #1) — the mobile mirror of web's `FavoriteButton`. Favoriting a
 * lake makes its reports notify by default, boost + badge in the feed, and highlight on the map. Uses
 * the reactive `isFavorite` query; the mutation requires auth.
 */
export function FavoriteButton({ waterBodyId }: { waterBodyId: Id<'waterBodies'> }) {
  const favorited = useQuery(api.waterBodyFavorites.isFavorite, { waterBodyId });
  const toggle = useMutation(api.waterBodyFavorites.toggle);
  const isFav = favorited === true;

  return (
    <Button
      size="$3"
      chromeless={!isFav}
      borderWidth={1}
      borderColor={isFav ? '$primary' : '$border'}
      onPress={() => void toggle({ waterBodyId })}
      disabled={favorited === undefined}
      aria-label={isFav ? 'Remove from favorites' : 'Add to favorites'}
    >
      <Text color={isFav ? '$primary' : '$foreground'}>{isFav ? '★ Favorited' : '☆ Favorite'}</Text>
    </Button>
  );
}

/** Detect the directions platform — Apple Maps on iOS, Google Maps elsewhere. */
function detectPlatform(): DirectionsPlatform {
  return Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web';
}

/**
 * Directions button (Phase 4 decision #7; re-targeted by N6d / D72) — opens the platform maps app to
 * the **parking area** when the chosen launch has one, else to the launch itself.
 *
 * The change is the phase's whole point: routing a car to a put-in on a hike-in pond hands a maps app
 * a destination it cannot reach, and the skater finds out at the trailhead. `directionsUrl` is
 * unchanged; only the coordinate handed to it moved. The choice runs through `chooseAccessTarget` so
 * this button and the web one cannot recommend different ways in.
 *
 * Falls back to the derived clusters when a lake has no stored access point — those have no id and no
 * parking, so they can't go through the resolver, but a lake whose only signal is "people put in
 * around here" should still offer directions exactly as it did before.
 */
export function DirectionsButton({ waterBodyId }: { waterBodyId: Id<'waterBodies'> }) {
  const access = useQuery(api.accessPoints.accessForBody, { waterBodyId });
  const markers = useQuery(api.putIns.listForBody, { waterBodyId });

  const target = access
    ? chooseAccessTarget(access.putIns, access.parking, new Set(access.blockedIds))
    : null;
  const fallback = !target ? markers?.[0] : undefined;
  const coord = target?.coord ?? fallback?.coord;
  if (!coord) return null;

  const approximate = target
    ? target.via === 'put_in' && target.putIn.source !== 'official'
    : fallback?.source !== 'official';

  return (
    <Button
      size="$3"
      chromeless
      borderWidth={1}
      borderColor="$border"
      onPress={() => void Linking.openURL(directionsUrl(coord, detectPlatform()))}
    >
      <Text color="$foreground">
        {target?.via === 'parking' ? 'Directions to parking' : 'Directions'}
        {approximate ? ' (approx.)' : ''}
        {isHikeIn(target?.approachKind) ? ' · hike-in' : ''}
      </Text>
    </Button>
  );
}
