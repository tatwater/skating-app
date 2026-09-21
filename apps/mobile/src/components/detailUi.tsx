import { humanizeEnum } from '@skating/core';
import type { ReactNode } from 'react';
import { H4, Paragraph, Spinner, Text, XStack, YStack } from 'tamagui';

/**
 * Small shared Tamagui pieces for the map detail drawers (§6) — the mobile analog of web's
 * `DrawerStates` + the badge/section helpers, themed via `@skating/design` tokens (D7/D34).
 */

/** Loading state while a detail query resolves. */
export function DetailLoading() {
  return (
    <YStack padding="$4" alignItems="center">
      <Spinner color="$primary" />
    </YStack>
  );
}

/** Friendly not-found / removed state (distinct from a blank), mirroring web's `UnavailableState`. */
export function Unavailable({ title, message }: { title: string; message: string }) {
  return (
    <YStack gap="$2" padding="$2">
      <H4 color="$foreground">{title}</H4>
      <Paragraph color="$foregroundMuted">{message}</Paragraph>
    </YStack>
  );
}

/** A labeled section block. */
export function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <YStack gap="$1.5">
      <Text color="$foregroundMuted" fontSize={11} letterSpacing={1.5} textTransform="uppercase">
        {label}
      </Text>
      {children}
    </YStack>
  );
}

/**
 * An outline pill (chip). `tone="solid"` renders the filled variant used for skate quality;
 * `tone="danger"` the warning fill an author's "Don't go" wears (A10 / D190, D3).
 */
export function Badge({
  children,
  tone = 'outline',
}: {
  children: ReactNode;
  tone?: 'outline' | 'solid' | 'danger';
}) {
  const fill = tone === 'solid' ? '$primary' : tone === 'danger' ? '$danger' : 'transparent';
  const text =
    tone === 'solid'
      ? '$primaryForeground'
      : tone === 'danger'
        ? '$dangerForeground'
        : '$foreground';
  return (
    <XStack
      borderWidth={1}
      borderColor={tone === 'outline' ? '$border' : fill}
      backgroundColor={fill}
      borderRadius="$4"
      paddingHorizontal="$2.5"
      paddingVertical="$1"
      alignSelf="flex-start"
    >
      <Text color={text} fontSize={12}>
        {children}
      </Text>
    </XStack>
  );
}

/** A wrapped row of humanized enum chips (ice types, surface tags). */
export function Chips({ values }: { values: string[] }) {
  return (
    <XStack gap="$1.5" flexWrap="wrap">
      {values.map((value) => (
        <Badge key={value}>{humanizeEnum(value)}</Badge>
      ))}
    </XStack>
  );
}
