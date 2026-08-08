import { Button } from 'tamagui';

/**
 * The way home, offered only once home has left the screen — the mobile mirror of web's.
 *
 * The map used to be fenced: the camera's `maxBounds` was the five-state box and MapLibre refused
 * to pan past it. That fence existed because outside the box there was nothing to draw — the
 * basemap archive was a bbox extract and the world ended at its edge. With a whole-planet overview
 * archive underneath, it doesn't. So the fence came down (founder, 2026-08-05) and this took its
 * place: a wanderer pays one tap, everyone else sees nothing, because `isRegionOffscreen` hides it
 * the moment any sliver of the five states is in view.
 *
 * Sits above the map and below the drawer, clear of `BackToLakeButton` in the top-right — the two
 * answer different questions ("where is my lake" against "where is the map") and can coexist.
 */
export function ReturnToRegion({ visible, onReturn }: { visible: boolean; onReturn: () => void }) {
  if (!visible) return null;

  return (
    <Button
      position="absolute"
      bottom={24}
      alignSelf="center"
      zIndex={30}
      size="$3"
      backgroundColor="$surface"
      borderColor="$border"
      borderWidth={1}
      onPress={onReturn}
      accessibilityLabel="Back to the Northeast"
    >
      Back to the Northeast
    </Button>
  );
}
