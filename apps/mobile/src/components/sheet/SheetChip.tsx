import type { ChipField, ChipTier, ReportSheetState, SheetFieldKey } from '@skating/core';
import type { ReactNode } from 'react';
import { Text, XStack, YStack } from 'tamagui';

/**
 * The sheet's chip (A10 / D188), in its three tiers. The tier is whose words the value came from,
 * and the drawing says so without a legend:
 *
 * - **solid** — the author tapped it: filled, `$primary`.
 * - **ghost** — someone else implied it: a dashed outline and a leading `+`, muted text. Reads as
 *   an offer, never as a fill; a tap makes it solid.
 * - **extracted** — read from the author's own writing (A10-4): the primary outline and a small
 *   *from your writing* mark. Pre-selected, so it draws as a selection, but hollow, so the author
 *   sees which chips they typed rather than tapped.
 *
 * One component for every chip row on the sheet, so the tiers cannot drift between sections.
 */
export function SheetChip({
  label,
  tier,
  onPress,
  onLongPress,
  danger = false,
  compact = false,
}: {
  label: string;
  /** `undefined` = an unselected, plain option (the row's own vocabulary, nobody suggested it). */
  tier?: ChipTier;
  onPress: () => void;
  onLongPress?: () => void;
  /** The warning treatment — *don't go* (D190). Solid only. */
  danger?: boolean;
  compact?: boolean;
}) {
  const selected = tier === 'solid' || tier === 'extracted';
  const fill = tier === 'solid' ? (danger ? '$danger' : '$primary') : 'transparent';
  const border =
    tier === 'solid'
      ? danger
        ? '$danger'
        : '$primary'
      : tier === 'extracted'
        ? '$primary'
        : tier === 'ghost'
          ? '$borderStrong'
          : '$border';
  const color =
    tier === 'solid'
      ? danger
        ? '$dangerForeground'
        : '$primaryForeground'
      : tier === 'ghost'
        ? '$foregroundMuted'
        : '$foreground';
  return (
    <XStack
      borderWidth={1}
      borderStyle={tier === 'ghost' ? 'dashed' : 'solid'}
      borderColor={border}
      backgroundColor={fill}
      borderRadius="$10"
      paddingHorizontal={compact ? '$2.5' : '$3'}
      paddingVertical={compact ? '$1' : '$1.5'}
      alignItems="center"
      gap="$1"
      pressStyle={{ opacity: 0.7 }}
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={
        tier === 'ghost'
          ? `${label}, suggested`
          : tier === 'extracted'
            ? `${label}, from your writing`
            : label
      }
    >
      {tier === 'ghost' ? (
        <Text color="$foregroundMuted" fontSize={compact ? 12 : 13}>
          +
        </Text>
      ) : null}
      <Text color={color} fontSize={compact ? 12 : 13} fontWeight={selected ? '600' : '400'}>
        {label}
      </Text>
      {tier === 'extracted' ? (
        <Text color="$primary" fontSize={10} accessibilityElementsHidden>
          ✎
        </Text>
      ) : null}
    </XStack>
  );
}

/**
 * A row of chips over one reducer field: the field's own vocabulary as plain options, with the
 * reducer's chips (ghosts, extractions, the author's taps) drawn in their tiers on top. Tapping a
 * selected chip deselects it; tapping anything else selects it. The order is the vocabulary's,
 * never a suggestion's — nothing reorders (D187).
 */
export function ChipRow<K extends SheetFieldKey, V extends string>({
  sheet,
  field,
  options,
  label,
  onSelect,
  onDeselect,
  danger,
  children,
}: {
  sheet: ReportSheetState;
  field: K;
  options: readonly V[];
  label: (value: V) => string;
  onSelect: (value: V) => void;
  onDeselect: (key: string) => void;
  /** Which option wears the warning treatment when solid. */
  danger?: V;
  /** Rendered after the row — a where affordance, a helper line. */
  children?: ReactNode;
}) {
  const chips = (sheet.fields[field] as ChipField<unknown>).chips;
  return (
    <YStack gap="$2">
      <XStack gap="$2" flexWrap="wrap">
        {options.map((option) => {
          const chip = chips.find((c) => c.key === option);
          const tier = chip?.tier;
          const selected = tier === 'solid' || tier === 'extracted';
          return (
            <SheetChip
              key={option}
              label={label(option)}
              tier={tier}
              danger={danger === option}
              onPress={() => (selected ? onDeselect(option) : onSelect(option))}
            />
          );
        })}
      </XStack>
      {children}
    </YStack>
  );
}
