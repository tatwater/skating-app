import { DETAIL_TAB_LABELS, DETAIL_TABS, type DetailTab } from '@skating/core';
import { Button, XStack } from 'tamagui';

/**
 * The three-segment control over the water-body sheet's content groups (N6h/H) — the native
 * counterpart of web's shadcn `Tabs`. Not shadcn: those primitives are web-only whichever library
 * backs them, so this is three equal-width buttons with the platform's `tab`/`tablist` roles and
 * `selected` state, which is what a screen reader needs and all a segmented control is.
 *
 * It pins to the top of the sheet once scrolled to — but not by itself. `MapDrawer`'s scroll view
 * wraps a single Expo Router `<Slot />`, and React Native can only stick a *direct* child of a scroll
 * view, so `WaterBodyDetail` teleports this strip into the drawer's pinned slot (`DrawerPinned`) and
 * everything that belongs above it into the head slot. See `MapDrawer` for the three-child layout and
 * why the alternative — mounting the strip outside the scroll view — would have put tabs above the
 * lake's own name. Founder call, 2026-09-11: pin it, in this PR.
 */
export function DetailTabStrip({
  value,
  onChange,
}: {
  value: DetailTab;
  onChange: (next: DetailTab) => void;
}) {
  return (
    <XStack
      accessibilityRole="tablist"
      accessibilityLabel="Lake detail sections"
      borderBottomWidth={1}
      borderColor="$border"
    >
      {DETAIL_TABS.map((id) => {
        const selected = id === value;
        return (
          <Button
            key={id}
            flex={1}
            size="$3"
            chromeless
            borderRadius={0}
            borderBottomWidth={2}
            borderBottomColor={selected ? '$primary' : 'transparent'}
            color={selected ? '$foreground' : '$foregroundMuted'}
            fontWeight={selected ? '600' : '400'}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => onChange(id)}
          >
            {DETAIL_TAB_LABELS[id]}
          </Button>
        );
      })}
    </XStack>
  );
}
