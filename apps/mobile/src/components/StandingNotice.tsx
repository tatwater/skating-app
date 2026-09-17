import {
  type BodyStanding,
  describeStanding,
  INACTIVE_BADGE,
  type StandingInput,
  standingOf,
} from '@skating/core';
import { Paragraph, XStack, YStack } from 'tamagui';
import { Badge } from './detailUi';

/**
 * Why this lake is not on the active map (A07b) — the mobile half of web's `StandingNotice`, same
 * sentence from `describeStanding`, rendered under the title on any body that is not `active`.
 */
export function StandingNotice({ body }: { body: StandingInput }) {
  return <StandingNoticeView standing={standingOf(body)} />;
}

export function StandingNoticeView({ standing }: { standing: BodyStanding }) {
  const line = describeStanding(standing);
  if (line === null) return null;
  return (
    <YStack gap="$1" paddingTop="$1" testID="standing-notice">
      <XStack>
        <Badge>{standing.standing === 'removed' ? 'Removed' : INACTIVE_BADGE}</Badge>
      </XStack>
      <Paragraph color="$foregroundMuted" fontSize={13}>
        {line}
      </Paragraph>
    </YStack>
  );
}
