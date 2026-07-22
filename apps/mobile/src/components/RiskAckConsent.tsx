import { openBrowserAsync } from 'expo-web-browser';
import { Anchor, Paragraph, Text, XStack, YStack } from 'tamagui';
import { DOC_URLS } from '../lib/links';
import { RISK_ACK_COPY } from '../lib/riskAck';

/**
 * The blocking assumption-of-risk acknowledgment control (D45), shared by the onboarding
 * and re-ack screens so the copy, the privacy/terms links, and — importantly — the
 * accessibility semantics stay identical.
 *
 * Accessibility (D34): the whole tappable row is exposed as a single `checkbox` element
 * whose label is the full risk copy (so a screen reader announces exactly what's being
 * consented to, plus checked/unchecked state). The decorative ☑/☐ glyph is hidden from
 * assistive tech, and the privacy/terms links are their own focusable controls.
 */
export function RiskAckConsent({ checked, onToggle }: { checked: boolean; onToggle: () => void }) {
  return (
    <YStack gap="$2">
      <XStack
        gap="$3"
        alignItems="flex-start"
        onPress={onToggle}
        accessible
        accessibilityRole="checkbox"
        accessibilityState={{ checked }}
        accessibilityLabel={`I accept the assumption-of-risk acknowledgment: ${RISK_ACK_COPY}`}
        accessibilityHint="Double tap to toggle acceptance"
      >
        <Text
          color={checked ? '$primary' : '$foregroundMuted'}
          fontSize="$6"
          accessibilityElementsHidden
          importantForAccessibility="no"
        >
          {checked ? '☑' : '☐'}
        </Text>
        <Paragraph flex={1} color="$foregroundMuted">
          {RISK_ACK_COPY}
        </Paragraph>
      </XStack>

      <XStack gap="$4">
        <Anchor color="$primary" onPress={() => openBrowserAsync(DOC_URLS.privacy)}>
          Privacy notice
        </Anchor>
        <Anchor color="$primary" onPress={() => openBrowserAsync(DOC_URLS.terms)}>
          Terms (interim)
        </Anchor>
      </XStack>
    </YStack>
  );
}
