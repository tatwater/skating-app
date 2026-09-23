import type { ReactNode } from 'react';
import { Text, XStack, YStack } from 'tamagui';

/**
 * One section of the sheet (A10 / D187, re-skinned A10-6 / D206): a header row that is a status
 * square, the section's name as an instrument label, its one-line summary once it is filled, and
 * the collapse caret; the body underneath while it is open.
 *
 * **The square is the section's state**, legend-free: hollow = nothing yet, filled = has data,
 * amber = the minimum set still wants it (D189). An open section sits on the panel surface with
 * bracket corners — *this is the one being edited* — and a collapsed one is a flat row.
 *
 * The header never moves and never reorders — the fixed order is the point. Collapsing is the
 * author's tap on the header, not something the sheet does under their finger.
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
    <YStack
      borderTopWidth={1}
      borderTopColor="$border"
      backgroundColor={collapsed ? 'transparent' : '$surface'}
      position="relative"
    >
      {collapsed ? null : <Brackets />}
      <XStack
        alignItems="center"
        gap={9}
        height={40}
        paddingHorizontal={12}
        onPress={onToggle}
        pressStyle={{ opacity: 0.7 }}
        accessibilityRole="button"
        accessibilityState={{ expanded: !collapsed }}
        accessibilityLabel={filled ? `${label}: ${summary}` : label}
      >
        <StatusSquare state={gap ? 'needed' : filled ? 'filled' : 'empty'} />
        <Eyebrow color={gap ? '$warning' : '$foregroundMuted'}>{label}</Eyebrow>
        {gap ? <Eyebrow color="$warning">· needed</Eyebrow> : null}
        <XStack flex={1} />
        {filled && collapsed ? (
          <Text color="$foreground" fontSize={12.5} numberOfLines={1} flexShrink={1}>
            {summary}
          </Text>
        ) : null}
        <Text color="$foregroundMuted" fontSize={10}>
          {collapsed ? '▼' : '▲'}
        </Text>
      </XStack>
      {collapsed ? null : (
        <YStack gap="$2.5" paddingLeft={28} paddingRight={12} paddingBottom={12}>
          {children}
        </YStack>
      )}
    </YStack>
  );
}

/** The section's name as the instrument label it is: mono, caps, tracked. */
export function Eyebrow({
  children,
  color = '$foregroundMuted',
}: {
  children: ReactNode;
  color?: '$foregroundMuted' | '$warning' | '$primary' | '$foreground';
}) {
  return (
    <Text
      color={color}
      fontFamily="$mono"
      fontSize={10.5}
      letterSpacing={1.4}
      textTransform="uppercase"
      fontWeight="500"
    >
      {children}
    </Text>
  );
}

/** A section's state, as a 7-dp square. Hollow, filled, or amber for needed (D189). */
export function StatusSquare({ state }: { state: 'empty' | 'filled' | 'needed' | 'ice' }) {
  const color =
    state === 'filled'
      ? '$foreground'
      : state === 'needed'
        ? '$warning'
        : state === 'ice'
          ? '$primary'
          : '$borderStrong';
  return (
    <YStack
      width={7}
      height={7}
      borderWidth={1}
      borderColor={color}
      backgroundColor={state === 'empty' ? 'transparent' : color}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    />
  );
}

/** The bracket corners of an open section: one L on the top-left, one on the bottom-right. */
function Brackets({ color = '$borderStrong' }: { color?: '$borderStrong' | '$primary' }) {
  return (
    <>
      <YStack
        position="absolute"
        left={0}
        top={-1}
        width={8}
        height={8}
        borderLeftWidth={1}
        borderTopWidth={1}
        borderColor={color}
        pointerEvents="none"
      />
      <YStack
        position="absolute"
        right={0}
        bottom={0}
        width={8}
        height={8}
        borderRightWidth={1}
        borderBottomWidth={1}
        borderColor={color}
        pointerEvents="none"
      />
    </>
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

/** A small label above a sub-row inside a section ("Surface", "Drifts"). */
export function SubLabel({ children }: { children: ReactNode }) {
  return (
    <Text
      color="$foregroundMuted"
      fontFamily="$mono"
      fontSize={10}
      letterSpacing={1}
      textTransform="uppercase"
      paddingTop={4}
    >
      {children}
    </Text>
  );
}

/**
 * A question block inside a section — the where question, the put-in question — the one thing on
 * the sheet that borders in ice: the lake inside it is an input while it is open. Its head names
 * the question and carries *Done*.
 */
export function QuestionBlock({
  title,
  onDone,
  extra,
  children,
}: {
  title: string;
  onDone: () => void;
  /** Between the title and *Done* — a count, a skip. */
  extra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <YStack
      gap="$2"
      borderWidth={1}
      borderColor="$primary"
      borderRadius="$xs"
      backgroundColor="$background"
      padding={10}
    >
      <XStack alignItems="center" gap={10}>
        <Eyebrow color="$primary">{title}</Eyebrow>
        <XStack flex={1} />
        {extra}
        <XStack
          height={24}
          paddingHorizontal={9}
          alignItems="center"
          borderRadius="$xs"
          backgroundColor="$foreground"
          onPress={onDone}
          pressStyle={{ opacity: 0.7 }}
          accessibilityRole="button"
          accessibilityLabel="Done"
        >
          <Text
            color="$background"
            fontSize={11}
            fontWeight="700"
            letterSpacing={0.8}
            textTransform="uppercase"
          >
            Done
          </Text>
        </XStack>
      </XStack>
      {children}
    </YStack>
  );
}
