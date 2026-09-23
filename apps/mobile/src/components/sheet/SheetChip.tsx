import type { ChipField, ChipTier, ReportSheetState, SheetFieldKey } from '@skating/core';
import type { ReactNode } from 'react';
import { Text, XStack, YStack } from 'tamagui';

/**
 * The sheet's chip (A10 / D188, re-skinned A10-6 / D206), in its three tiers. The tier is whose
 * words the value came from, and the drawing says so without a legend — and without a color,
 * because color on this sheet is rationed by meaning (D206):
 *
 * - **solid** — the author tapped it: **inverted ink**, the foreground as fill, the background as
 *   text.
 * - **extracted** — read from the author's own writing (A10-4): the same inversion, weaker — the
 *   muted foreground as fill — with a ✎. Pre-selected, but visibly less than a tap (founder call
 *   2026-09-23).
 * - **ghost** — someone else implied it: a dashed outline and a leading `+`, muted. An offer.
 * - **danger** — *don't go* (D190), the one chip that wears red.
 *
 * Two pixels of radius, one hairline, a 32-dp height so a row stays tappable while more chips fit.
 * One component for every chip row on the sheet, so the tiers cannot drift between sections.
 */
export function SheetChip({
  label,
  tier,
  onPress,
  onLongPress,
  danger = false,
  compact = false,
  trailing,
}: {
  label: string;
  /** `undefined` = an unselected, plain option (the row's own vocabulary, nobody suggested it). */
  tier?: ChipTier;
  onPress: () => void;
  onLongPress?: () => void;
  /** The warning treatment — *don't go* (D190). */
  danger?: boolean;
  compact?: boolean;
  /** A small mark after the label — the `where` a chip carries. */
  trailing?: ReactNode;
}) {
  const selected = tier === 'solid' || tier === 'extracted';
  const fill =
    tier === 'solid'
      ? danger
        ? '$danger'
        : '$foreground'
      : tier === 'extracted'
        ? '$foregroundMuted'
        : 'transparent';
  const border =
    tier === 'solid'
      ? danger
        ? '$danger'
        : '$foreground'
      : tier === 'extracted'
        ? '$foregroundMuted'
        : tier === 'ghost'
          ? '$borderStrong'
          : danger
            ? '$danger'
            : '$border';
  const color =
    tier === 'solid'
      ? danger
        ? '$dangerForeground'
        : '$background'
      : tier === 'extracted'
        ? '$background'
        : tier === 'ghost'
          ? '$foregroundMuted'
          : danger
            ? '$danger'
            : '$foreground';
  return (
    <XStack
      borderWidth={1}
      borderStyle={tier === 'ghost' ? 'dashed' : 'solid'}
      borderColor={border}
      backgroundColor={fill}
      borderRadius="$xs"
      height={compact ? 26 : 32}
      paddingHorizontal={compact ? 9 : 11}
      alignItems="center"
      gap={5}
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
      <Text color={color} fontSize={compact ? 12 : 13.5} fontWeight={selected ? '600' : '500'}>
        {label}
      </Text>
      {trailing}
      {tier === 'extracted' ? (
        <Text color={color} opacity={0.7} fontSize={10} accessibilityElementsHidden>
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
  trailing,
}: {
  sheet: ReportSheetState;
  field: K;
  options: readonly V[];
  label: (value: V) => string;
  onSelect: (value: V) => void;
  onDeselect: (key: string) => void;
  /** Which option wears the warning treatment. */
  danger?: V;
  /** Rendered after the row — a where affordance, a helper line. */
  children?: ReactNode;
  /** A mark after a selected chip's label, by its key (the `where` it carries). */
  trailing?: (key: string) => ReactNode;
}) {
  const chips = (sheet.fields[field] as ChipField<unknown>).chips;
  return (
    <YStack gap="$2">
      <XStack gap={6} flexWrap="wrap">
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
              trailing={selected && trailing ? trailing(option) : undefined}
              onPress={() => (selected ? onDeselect(option) : onSelect(option))}
            />
          );
        })}
      </XStack>
      {children}
    </YStack>
  );
}
