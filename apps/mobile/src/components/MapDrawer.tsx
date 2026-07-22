import BottomSheet, { BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { useRouter } from 'expo-router';
import { type ReactNode, useCallback, useEffect, useMemo, useRef } from 'react';
import { useTheme } from 'tamagui';
import { DrawerScrollContext } from './DrawerScrollContext';

/** Snap points: a low peek (map tappable above it, for put-in-pin drop), normal, and expanded. */
export const DRAWER_SNAP_POINTS = ['16%', '58%', '94%'] as const;
export const DRAWER_PEEK = 0;
export const DRAWER_NORMAL = 1;

/** Fraction of the screen the drawer covers at a settled snap index (`-1` closed → 0). */
export function coveredFractionForIndex(index: number): number {
  if (index < 0) return 0;
  return (Number.parseFloat(DRAWER_SNAP_POINTS[index] ?? '0') || 0) / 100;
}

/**
 * The bottom-sheet drawer that hosts a water-body / report detail over the persistent map (§F, D47)
 * — the mobile mirror of web's `DetailSheet`. Selection is URL-backed (`/water/[id]`, `/report/[id]`)
 * so it's deep-linkable off-platform; the sheet is **non-modal with no backdrop**, so the map behind
 * stays pannable and tappable while the drawer is open — which the report form's put-in-pin placement
 * (§E) relies on. Swiping the sheet fully down (its own gesture) navigates back to the bare map (`/`).
 *
 * `snapIndex` is route-driven: `-1` closed, `DRAWER_PEEK` while a put-in pin is being placed (so the
 * map above is tappable without unmounting the half-filled form), `DRAWER_NORMAL` otherwise. We drive
 * it imperatively because `@gorhom/bottom-sheet`'s `index` prop is only the initial snap. Closing the
 * sheet keeps its children mounted, so form state survives the peek.
 */
export function MapDrawer({
  snapIndex,
  onCoveredFractionChange,
  children,
}: {
  snapIndex: number;
  /** Called with the covered-screen fraction whenever the sheet settles (drag or programmatic). */
  onCoveredFractionChange?: (fraction: number) => void;
  children: ReactNode;
}) {
  const ref = useRef<BottomSheet>(null);
  const scrollRef = useRef<React.ComponentRef<typeof BottomSheetScrollView>>(null);
  const router = useRouter();
  const theme = useTheme();
  const snapPoints = useMemo(() => [...DRAWER_SNAP_POINTS], []);

  useEffect(() => {
    if (snapIndex < 0) ref.current?.close();
    else ref.current?.snapToIndex(snapIndex);
  }, [snapIndex]);

  // Exposed to drawer content (e.g. a deep-linked `?action=confirm` hazard) so it can pull a
  // below-the-fold control into view. Stable identity so consumers can depend on it in an effect.
  const scrollToY = useCallback((y: number) => {
    scrollRef.current?.scrollTo({ y, animated: true });
  }, []);
  const scrollApi = useMemo(() => ({ scrollToY }), [scrollToY]);

  return (
    <BottomSheet
      ref={ref}
      index={snapIndex < 0 ? -1 : snapIndex}
      snapPoints={snapPoints}
      enablePanDownToClose
      // The user swiping the sheet fully down pops back to the map. Navigating to `/` is idempotent,
      // so the programmatic `close()` on unmount/navigation doesn't cause a loop.
      onClose={() => router.navigate('/')}
      // Report the settled position so the map can re-fit the lake into the uncovered area.
      onChange={(index) => onCoveredFractionChange?.(coveredFractionForIndex(index))}
      backgroundStyle={{ backgroundColor: theme.surface?.val }}
      handleIndicatorStyle={{ backgroundColor: theme.foregroundMuted?.val }}
    >
      <BottomSheetScrollView ref={scrollRef} contentContainerStyle={{ padding: 16, gap: 12 }}>
        <DrawerScrollContext.Provider value={scrollApi}>{children}</DrawerScrollContext.Provider>
      </BottomSheetScrollView>
    </BottomSheet>
  );
}
