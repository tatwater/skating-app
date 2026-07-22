import { usePathname, useRouter } from 'expo-router';
import { Button } from 'tamagui';
import { useMapSelection } from './MapSelectionContext';

/**
 * "Back to the lake you're on" (founder call, 2026-07-21) — the lake-scoped cousin of a map app's
 * "jump to me". It appears whenever GPS has resolved to a water body **and** the skater has navigated or
 * panned away from it, and tapping it re-selects that lake — reusing the exact select-and-frame path the
 * once-per-open auto-select uses, so the hazard layer follows and the lake frames back into the drawer's
 * uncovered space. It's the manual sibling of `shouldAutoSelectOnIce`: auto-select fires once on open,
 * this is how you get back any time after.
 *
 * Gated on GPS-resolves-to-a-lake, **not** on on-ice mode being armed — it's useful while just exploring.
 */
export function BackToLakeButton() {
  const router = useRouter();
  const pathname = usePathname();
  const { onIceWaterBodyId, hazardDraft } = useMapSelection();

  // Nothing to go back to if GPS hasn't resolved a lake; hidden while you're already looking at it; and
  // out of the way during a hazard capture (the adjust bar owns the screen then).
  if (!onIceWaterBodyId || hazardDraft) return null;
  if (pathname === `/water/${onIceWaterBodyId}`) return null;

  return (
    <Button
      position="absolute"
      top={112}
      right={16}
      zIndex={30}
      size="$3"
      backgroundColor="$surface"
      borderColor="$border"
      borderWidth={1}
      onPress={() => router.navigate({ pathname: '/water/[id]', params: { id: onIceWaterBodyId } })}
      accessibilityLabel="Back to the lake you're on"
    >
      📍 Your lake
    </Button>
  );
}
