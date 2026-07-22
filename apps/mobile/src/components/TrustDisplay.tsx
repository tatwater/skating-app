import { TRUST_CLASS_COLORS, TRUST_CLASS_LABELS, type TrustClass } from '@skating/core';
import { Text, useTheme, XStack, YStack } from 'tamagui';
import { Avatar } from './Avatar';

/**
 * Trust display primitives (D50 decision 5), the mobile mirror of web's `TrustDisplay` — the cosmetic,
 * boost-only reputation signal rendered as a **class**, never a raw number. One shared `TrustAvatar`
 * (a colored ring + corner dot around the author avatar) is used *everywhere* an author appears (feed
 * cards, comments, report/hazard/bounty authors); the `TrustClassChip` is the labelled pill on the
 * profile page.
 *
 * A `null` class is a real state — a below-`trusted` account past the New window — and renders **no**
 * ring and **no** chip (we never render "Not trusted"). Colors/labels are single-sourced in
 * `@skating/core` so web (CSS) and mobile (RN) stay in lockstep. The class colors are raw hex, so they
 * ride through the RN `style` prop (Tamagui's shorthand color props only accept theme tokens).
 */

/**
 * A ringed avatar: the base `Avatar` wrapped in the class color (an outer color ring, a surface-colored
 * gap, then the avatar) plus a corner dot. `null` ⇒ a plain avatar with no ring/dot.
 */
export function TrustAvatar({
  displayName,
  imageUrl,
  trustClass,
  size = 40,
}: {
  displayName: string;
  imageUrl?: string;
  trustClass?: TrustClass | null;
  size?: number;
}) {
  const theme = useTheme();
  const color = trustClass ? TRUST_CLASS_COLORS[trustClass] : undefined;
  const label = trustClass ? TRUST_CLASS_LABELS[trustClass] : undefined;

  if (!color) {
    return <Avatar displayName={displayName} imageUrl={imageUrl} size={size} />;
  }

  // The gap ring reads the page surface so the class color renders as a ring, not a fill — the RN
  // analog of web's stacked box-shadows. Two 2px layers (color, then surface) grow the box by 8px.
  const surface = theme.surface?.val ?? '#ffffff';
  const dot = Math.max(8, Math.round(size / 4));

  return (
    <YStack
      borderRadius={9999}
      padding={2}
      style={{ backgroundColor: color }}
      accessibilityLabel={label ? `${label} skater` : undefined}
    >
      <YStack borderRadius={9999} padding={2} style={{ backgroundColor: surface }}>
        <Avatar displayName={displayName} imageUrl={imageUrl} size={size} />
      </YStack>
      <YStack
        position="absolute"
        right={0}
        bottom={0}
        width={dot}
        height={dot}
        borderRadius={dot / 2}
        borderWidth={2}
        style={{ backgroundColor: color, borderColor: surface }}
      />
    </YStack>
  );
}

/** The labelled class pill for the profile page. `null` ⇒ renders nothing (no "Not trusted", D50). */
export function TrustClassChip({ trustClass }: { trustClass: TrustClass | null }) {
  if (!trustClass) return null;
  const color = TRUST_CLASS_COLORS[trustClass];
  return (
    <XStack
      alignItems="center"
      gap="$1.5"
      borderRadius={9999}
      paddingHorizontal={10}
      paddingVertical={2}
      borderWidth={1}
      style={{ backgroundColor: `${color}1a`, borderColor: `${color}66` }}
    >
      <YStack width={6} height={6} borderRadius={3} style={{ backgroundColor: color }} />
      <Text fontSize={12} fontWeight="500" style={{ color }}>
        {TRUST_CLASS_LABELS[trustClass]}
      </Text>
    </XStack>
  );
}
