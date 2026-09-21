import type { ReactNode } from 'react';
import { Text, XStack, YStack } from 'tamagui';

/**
 * One section of the sheet (A10 / D187): a header row that is the section's name, its one-line
 * summary once it is filled, and the collapse toggle; the body underneath while it is open.
 *
 * The header never moves and never reorders — the fixed order is the point. Collapsing is the
 * author's tap on the header, not something the sheet does under their finger: a section that
 * auto-collapsed after the first chip would yank the row the next chip is on. A section opened
 * from a draft or an edit starts collapsed to its summary (the reducer holds that), so the review
 * reads as a list of what was said; a fresh sheet starts open.
 *
 * `gap` marks a section the minimum set still wants (D189) after a *Post* attempt — a quiet mark
 * beside the name, not a red field.
 */
export function SheetSection({
  label,
  summary,
  collapsed,
  onToggle,
  gap = false,
  children,
}: {
  label: string;
  /** Empty when the section has nothing yet; the header then reads the name alone. */
  summary: string;
  collapsed: boolean;
  onToggle: () => void;
  gap?: boolean;
  children: ReactNode;
}) {
  const filled = summary.length > 0;
  return (
    <YStack gap="$2.5" paddingVertical="$3" borderTopWidth={1} borderTopColor="$border">
      <XStack
        alignItems="center"
        gap="$2"
        onPress={onToggle}
        pressStyle={{ opacity: 0.7 }}
        accessibilityRole="button"
        accessibilityState={{ expanded: !collapsed }}
        accessibilityLabel={filled ? `${label}: ${summary}` : label}
      >
        <Text
          color={gap ? '$warning' : '$foregroundMuted'}
          fontSize={11}
          letterSpacing={1.5}
          textTransform="uppercase"
        >
          {label}
        </Text>
        {gap ? (
          <Text color="$warning" fontSize={11}>
            · needed
          </Text>
        ) : null}
        <XStack flex={1} />
        {filled && collapsed ? (
          <Text color="$foreground" fontSize={13} numberOfLines={1} flexShrink={1}>
            {summary}
          </Text>
        ) : null}
        <Text color="$foregroundMuted" fontSize={12}>
          {collapsed ? '⌄' : '⌃'}
        </Text>
      </XStack>
      {collapsed ? null : children}
    </YStack>
  );
}

/** A quiet helper line under a row — a suggestion's source, a note on what the row means. */
export function SheetHint({ children }: { children: ReactNode }) {
  return (
    <Text color="$foregroundMuted" fontSize={12} lineHeight={16}>
      {children}
    </Text>
  );
}

/** A small label above a sub-row inside a section ("Coverage", "Drifts"). */
export function SubLabel({ children }: { children: ReactNode }) {
  return (
    <Text color="$foreground" fontSize={13} fontWeight="600">
      {children}
    </Text>
  );
}
