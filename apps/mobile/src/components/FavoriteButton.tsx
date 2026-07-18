import { api } from '@skating/convex/api'
import type { Id } from '@skating/convex/dataModel'
import { type DirectionsPlatform, directionsUrl } from '@skating/core'
import { useMutation, useQuery } from 'convex/react'
import { Linking, Platform } from 'react-native'
import { Button, Text } from 'tamagui'

/**
 * Favorite toggle (Phase 4, decision #1) — the mobile mirror of web's `FavoriteButton`. Favoriting a
 * lake makes its reports notify by default, boost + badge in the feed, and highlight on the map. Uses
 * the reactive `isFavorite` query; the mutation requires auth.
 */
export function FavoriteButton({ waterBodyId }: { waterBodyId: Id<'waterBodies'> }) {
  const favorited = useQuery(api.waterBodyFavorites.isFavorite, { waterBodyId })
  const toggle = useMutation(api.waterBodyFavorites.toggle)
  const isFav = favorited === true

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
  )
}

/** Detect the directions platform — Apple Maps on iOS, Google Maps elsewhere. */
function detectPlatform(): DirectionsPlatform {
  return Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web'
}

/**
 * Directions button (Phase 4, decision #7) — opens the platform maps app to the lake's highest-priority
 * **put-in coord** (official first, else the top derived cluster), never the on-water centroid. Renders
 * nothing until a put-in is known (nothing safe to route to yet).
 */
export function DirectionsButton({ waterBodyId }: { waterBodyId: Id<'waterBodies'> }) {
  const markers = useQuery(api.putIns.listForBody, { waterBodyId })
  const target = markers?.[0]
  if (!target) return null

  return (
    <Button
      size="$3"
      chromeless
      borderWidth={1}
      borderColor="$border"
      onPress={() => void Linking.openURL(directionsUrl(target.coord, detectPlatform()))}
    >
      <Text color="$foreground">Directions{target.source === 'official' ? '' : ' (approx.)'}</Text>
    </Button>
  )
}
