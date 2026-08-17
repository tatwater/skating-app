import {
  describePostedAccess,
  describePostedAccessNow,
  POSTED_ACCESS_TIMEZONE,
  type PostedAccess as PostedAccessRule,
  postedAccessStateAt,
  revealPlaceholder,
} from '@skating/core';
import { useEffect, useState } from 'react';
import { Paragraph, Text, YStack } from 'tamagui';
import { Section } from './detailUi';

/**
 * What the sign says, and what it means right now (N6e) — the mobile half of web's `PostedAccess`.
 *
 * **Two lines, and neither replaces the other.** `January 1 – March 15 · sunrise to sunset` is the
 * durable, checkable fact you plan tomorrow against; `Closed now · opens 6:42 AM` is that rule's
 * consequence at one instant. Both strings come from `@skating/core`, so the two platforms cannot
 * drift on what a posted rule reads like.
 *
 * **It annotates and never suppresses** — no button is disabled, no form hidden, no route greyed out.
 */
export function PostedAccess({
  rule,
  coord,
  reveal = false,
}: {
  rule?: PostedAccessRule;
  /** The lake's `interiorPoint` (never `centroid` — it sits on the shoreline), or the point's `coord`. */
  coord?: { lat: number; lng: number };
  /** N6c-2's reveal flag — states the absence instead of hiding the section. */
  reveal?: boolean;
}) {
  const { described, nowLine, closed } = usePostedAccessLines(rule, coord);

  if (!rule && !reveal) return null;

  return (
    <Section label="Posted rules">
      <YStack gap="$1">
        {described ? <Text color="$foreground">{described}</Text> : null}
        {nowLine ? (
          <Text
            color={closed ? '$warning' : '$foregroundMuted'}
            fontWeight={closed ? '600' : '400'}
          >
            {nowLine}
          </Text>
        ) : null}
        {rule?.note ? (
          <Text color="$foregroundMuted" fontSize="$1">
            {rule.note}
          </Text>
        ) : null}
        {!rule ? (
          <Paragraph color="$foregroundMuted" fontStyle="italic">
            {revealPlaceholder('posted rules')}
          </Paragraph>
        ) : null}
      </YStack>
    </Section>
  );
}

/**
 * The same rule on one line, for a launch or lot inside `AccessSection`.
 *
 * No heading and no note: those rows are already dense, and the heading would repeat once per access
 * point. The full text stays on the body's own section.
 */
export function PostedAccessLine({
  rule,
  coord,
}: {
  rule?: PostedAccessRule;
  coord?: { lat: number; lng: number };
}) {
  const { described, nowLine, closed } = usePostedAccessLines(rule, coord);
  if (!rule || !described) return null;

  return (
    <Text color={closed ? '$warning' : '$foregroundMuted'} fontSize="$1">
      {nowLine ? `${described} · ${nowLine}` : described}
    </Text>
  );
}

function usePostedAccessLines(
  rule: PostedAccessRule | undefined,
  coord?: { lat: number; lng: number },
) {
  const nowMs = useMinuteTick(rule !== undefined);

  if (!rule || !coord) {
    return { described: rule ? describePostedAccess(rule) : null, nowLine: null, closed: false };
  }
  const state = postedAccessStateAt(rule, {
    nowMs,
    lat: coord.lat,
    lon: coord.lng,
    timeZone: POSTED_ACCESS_TIMEZONE,
  });
  return {
    described: describePostedAccess(rule),
    nowLine: describePostedAccessNow(state, POSTED_ACCESS_TIMEZONE),
    closed: !state.open,
  };
}

/**
 * Re-render once a minute so "Closed now · opens 6:42 AM" doesn't go stale in an open sheet.
 *
 * A minute rather than a second: every value it drives is rendered to the minute. The interval is
 * skipped entirely when there is no rule, which is the great majority of bodies.
 */
function useMinuteTick(active: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, [active]);
  return nowMs;
}
