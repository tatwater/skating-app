import { usePathname, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button } from 'tamagui';
import { SEARCH_BAR_SLOT } from './LakeSearch';
import { useMapSelection } from './MapSelectionContext';

/**
 * "Back to the ice you're on" (founder call, 2026-07-21) — the lake-scoped cousin of a map app's
 * "jump to me". It appears whenever GPS has resolved to a water body **and** the skater has navigated or
 * panned away from it, and tapping it re-selects that lake — reusing the exact select-and-frame path the
 * once-per-open auto-select uses, so the hazard layer follows and the lake frames back into the drawer's
 * uncovered space. It's the manual sibling of `shouldAutoSelectOnIce`: auto-select fires once on open,
 * this is how you get back any time after.
 *
 * Gated on GPS-resolves-to-a-lake, **not** on on-ice mode being armed — it's useful while just exploring.
 * It is also the inverse of `OnIceDock`'s button, which shows only once the skater *has* selected the
 * water they're standing on: between them, that water has exactly one affordance on screen at a time.
 *
 * ## It says "ice", and it gets out of the way (founder, 2026-08-26)
 *
 * "Your lake" was wrong twice over. The app is not lakes — it's rivers, bays and reservoirs too — and
 * the button was pinned at `top: 112` with a `zIndex` above the sheet, so it sat on the search bar on a
 * tall phone and floated over a fully-opened drawer. So: it clears whatever the top of the map is
 * currently spending (the search bar, when the search bar is up), and it paints *below* the sheet.
 * Being covered by a sheet the skater pulled to full height is the honest outcome — the map is gone,
 * and one drag brings both back.
 */
export function BackToLakeButton() {
  const router = useRouter();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const { onIceWaterBodyId, hazardDraft } = useMapSelection();

  // Nothing to go back to if GPS hasn't resolved a lake; hidden while you're already looking at it; and
  // out of the way during a hazard capture (the adjust bar owns the screen then).
  if (!onIceWaterBodyId || hazardDraft) return null;
  if (pathname === `/water/${onIceWaterBodyId}`) return null;

  // `LakeSearch` is on screen exactly on the bare map (it scoots off the top the moment a body is
  // selected), so that is the one route where this has to start below it.
  const searchVisible = pathname === '/';

  return (
    <Button
      position="absolute"
      top={insets.top + 8 + (searchVisible ? SEARCH_BAR_SLOT : 0)}
      right={16}
      // Below the sheet (`DRAWER_Z_INDEX` is 25), unlike the hazard surfaces beside it in the layout.
      zIndex={20}
      size="$3"
      backgroundColor="$surface"
      borderColor="$border"
      borderWidth={1}
      onPress={() => router.navigate({ pathname: '/water/[id]', params: { id: onIceWaterBodyId } })}
      accessibilityLabel="Back to the ice you're on"
    >
      📍 Your ice
    </Button>
  );
}
