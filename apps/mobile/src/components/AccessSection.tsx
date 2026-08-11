import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { chooseAccessTarget, describeApproach, isHikeIn } from '@skating/core';
import { useMutation, useQuery } from 'convex/react';
import { useState } from 'react';
import { Button, Paragraph, Text, XStack, YStack } from 'tamagui';
import { Badge, Section } from './detailUi';

/** How each alert reason reads. Short, because it sits beside a launch name on a phone. */
const REASON_LABELS: Record<string, string> = {
  road_closed: 'Road closed',
  gate_locked: 'Gate locked',
  not_plowed: 'Not plowed',
  lot_full: 'Lot full',
  private_no_access: 'Private — no access',
  other: 'Access problem',
};

const AMENITY_LABELS: Record<string, string> = {
  toilets: 'Toilets',
  trail: 'Trail',
  boat_ramp: 'Boat ramp',
};

/**
 * How you get onto this lake — the mobile half of web's `AccessSection` (N6d / D72, D73, D87).
 *
 * Deliberately the same shape as the web one, down to the copy: the two surfaces answer the same
 * question and a skater who checks at home and again in the car should read the same sentence. What
 * differs is only the framing components.
 *
 * Renders nothing when there is no access data, which is most of the corpus — a section saying "we
 * don't know where to park" on 20,000 lakes is worse than no section.
 */
export function AccessSection({ waterBodyId }: { waterBodyId: Id<'waterBodies'> }) {
  const access = useQuery(api.accessPoints.accessForBody, { waterBodyId });
  const vote = useMutation(api.accessAlerts.vote);
  const [busy, setBusy] = useState<string | null>(null);

  if (!access || (access.putIns.length === 0 && access.parking.length === 0)) return null;

  const target = chooseAccessTarget(access.putIns, access.parking, new Set(access.blockedIds));
  const approach = target ? describeApproach(target) : null;
  const alerts = access.alerts ?? [];
  const amenities = [
    ...new Set(access.parking.flatMap((p) => p.amenities.map((a) => AMENITY_LABELS[a] ?? a))),
  ];

  const nameFor = (alert: (typeof alerts)[number]) =>
    alert.putInId
      ? (access.putIns.find((p) => p.id === alert.putInId)?.name ?? 'a launch')
      : (access.parking.find((p) => p.id === alert.parkingAreaId)?.name ?? 'the parking area');

  return (
    <Section label="Getting there">
      {target ? (
        <XStack gap="$2" alignItems="center" flexWrap="wrap">
          <Paragraph flexShrink={1}>
            {target.via === 'parking'
              ? `Park at ${target.parking?.name ?? 'the lot'}, then put in at ${target.putIn.name ?? 'the shore'}.`
              : `Put in at ${target.putIn.name ?? 'the shore'}.`}
          </Paragraph>
          {/* Derived from `approachKind`, never entered — the chip exists so nobody discovers the walk
              at the trailhead. */}
          {isHikeIn(target.approachKind) ? <Badge>Hike-in</Badge> : null}
        </XStack>
      ) : null}

      {/* The hedge ("about" vs "at least") is decided in core: a straight-line fallback under-reports,
          so it is a floor rather than an estimate (D87). */}
      {approach ? <Paragraph color="$foregroundMuted">{approach}</Paragraph> : null}

      {amenities.length > 0 ? (
        <Text color="$foregroundMuted" fontSize={12}>
          {amenities.join(' · ')}
        </Text>
      ) : null}

      {/* Drive time and the walk are never summed (D72 amendment) — two lines, deliberately. */}

      {alerts.map((alert) => (
        <YStack
          key={alert.id}
          gap="$1"
          padding="$2"
          borderWidth={1}
          borderColor="$border"
          borderRadius="$2"
        >
          <Text fontWeight="600">
            {REASON_LABELS[alert.reason] ?? 'Access problem'} — {nameFor(alert)}
            {alert.official ? ' (confirmed by a moderator)' : ''}
          </Text>
          {alert.note ? <Paragraph color="$foregroundMuted">{alert.note}</Paragraph> : null}
          {alert.official ? null : (
            <XStack gap="$2">
              <Button
                size="$2"
                chromeless
                borderWidth={1}
                borderColor="$border"
                disabled={busy === alert.id}
                onPress={async () => {
                  setBusy(alert.id);
                  try {
                    await vote({ accessAlertId: alert.id, verdict: 'still_blocked' });
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                <Text>Still blocked</Text>
              </Button>
              <Button
                size="$2"
                chromeless
                borderWidth={1}
                borderColor="$border"
                disabled={busy === alert.id}
                onPress={async () => {
                  setBusy(alert.id);
                  try {
                    await vote({ accessAlertId: alert.id, verdict: 'open' });
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                <Text>It's open</Text>
              </Button>
            </XStack>
          )}
        </YStack>
      ))}
    </Section>
  );
}
