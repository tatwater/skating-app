import { DETAIL_TAB_LABELS, DETAIL_TABS, type DetailTab } from '@skating/core';
import { Button, XStack } from 'tamagui';

/**
 * The three-segment control over the water-body sheet's content groups (N6h/H) — the native
 * counterpart of web's shadcn `Tabs`. Not shadcn: those primitives are web-only whichever library
 * backs them, so this is three equal-width buttons with the platform's `tab`/`tablist` roles and
 * `selected` state, which is what a screen reader needs and all a segmented control is.
 *
 * ⚠ It scrolls with the sheet rather than pinning. The plan sketched the strip "outside the scroll
 * view so it survives the 16% snap point", but `MapDrawer`'s `BottomSheetScrollView` wraps a single
 * Expo Router `<Slot />`, so `stickyHeaderIndices` cannot reach a strip nested inside this screen;
 * pinning would mean either a portal host wedged between scroll-view children or a strip above the
 * lake's own name, and both are worse than a control that scrolls. At the 58% and 94% snaps the
 * strip is on screen after the alert; at 16% the title is all that was ever meant to peek.
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
