import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { formatAlertLine, revealPlaceholder } from '@skating/core';
import { useQuery } from 'convex/react';
import { Paragraph, Text, YStack } from 'tamagui';

/**
 * NWS active alerts on a lake sheet (N6c B5, D74) — the mobile half of the web `AlertStrip`.
 *
 * **Visually distinct and attributed.** Everything else in this sheet is ours; this is the National
 * Weather Service speaking, and the two carry very different kinds of authority. It sits at the top,
 * above the forward forecast, because an official warning outranks a prediction.
 *
 * A plain query with no fetch behind it — the cron owns the network — so opening a sheet costs one
 * bounded table read no matter how many skaters open the same lake.
 */
export function AlertStrip({
  waterBodyId,
  reveal = false,
}: {
  waterBodyId: Id<'waterBodies'>;
  /** N6c-2's reveal flag — states the absence instead of hiding the strip. */
  reveal?: boolean;
}) {
  const alerts = useQuery(api.weatherAlerts.listForBody, { waterBodyId });
  if ((!alerts || alerts.length === 0) && !reveal) return null;

  return (
    <YStack
      gap="$1"
      padding="$3"
      borderRadius="$3"
      borderWidth={1}
      borderColor="$warning"
      backgroundColor="$surfaceMuted"
      accessibilityLabel="National Weather Service alerts"
    >
      <Text color="$foregroundMuted" fontSize={11} textTransform="uppercase">
        Weather alerts
      </Text>
      {!alerts || alerts.length === 0 ? (
        <Paragraph color="$foregroundMuted" fontSize={14} fontStyle="italic">
          {revealPlaceholder('active alerts')}
        </Paragraph>
      ) : null}
      {(alerts ?? []).map((alert) => (
        <YStack key={alert.id} gap="$1">
          <Paragraph color="$foreground" fontSize={14}>
            {formatAlertLine(alert)}
          </Paragraph>
          {/* NWS's own headline, never paraphrased — the value of this strip is that the words are
              theirs. */}
          {alert.headline ? (
            <Text color="$foregroundMuted" fontSize={11}>
              {alert.headline}
            </Text>
          ) : null}
        </YStack>
      ))}
      <Text color="$foregroundMuted" fontSize={11}>
        Issued by the US National Weather Service. Alerts may cover a wider area than this lake.
      </Text>
    </YStack>
  );
}
