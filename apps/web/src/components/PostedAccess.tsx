import {
  describePostedAccess,
  describePostedAccessNow,
  POSTED_ACCESS_TIMEZONE,
  type PostedAccess as PostedAccessRule,
  postedAccessStateAt,
  revealPlaceholder,
} from '@skating/core';
import { useEffect, useState } from 'react';

/**
 * What the sign says, and what it means right now (N6e).
 *
 * **Two lines, and neither replaces the other.** `January 1 – March 15 · sunrise to sunset` is the
 * durable, checkable fact — it is what you plan tomorrow against, and it is what a reader can go and
 * verify against the sign. `Closed now · opens 6:42 AM` is that rule's consequence at one instant. A
 * drawer showing only the first makes a skater do sunrise arithmetic in a car park; one showing only
 * the second is unverifiable and useless for planning.
 *
 * **It annotates and never suppresses.** Nothing here disables a button, hides a report form, or
 * greys the directions out — the `AccessSection` invariant, and Phase 10's never-hide rule. A skater
 * on the ice at dusk is exactly the person who most needs to file, and a posted rule is a fact about
 * permission rather than a fact about safety.
 *
 * Rendered against **one** target. The body's rule governs the ice; a put-in's or a lot's governs that
 * access point; the three are never combined into an "effective" rule, because a lake open around the
 * clock with one lot shut at dusk is not a lake shut at dusk.
 */
export function PostedAccess({
  rule,
  coord,
  reveal = false,
}: {
  rule?: PostedAccessRule;
  /** The lake's `interiorPoint` (never `centroid` — it sits on the shoreline), or the point's `coord`. */
  coord?: { lat: number; lng: number };
  /** N6c-2's reveal flag — states the absence instead of hiding the strip. */
  reveal?: boolean;
}) {
  const { described, nowLine, closed } = usePostedAccessLines(rule, coord);

  if (!rule && !reveal) return null;

  return (
    <div className="flex flex-col gap-1">
      <h3 className="font-mono text-foreground-muted text-xs uppercase tracking-widest">
        Posted rules
      </h3>
      {described ? <p className="text-foreground text-sm">{described}</p> : null}
      {nowLine ? (
        <p
          className={
            closed
              ? 'font-medium text-amber-700 text-sm dark:text-amber-400'
              : 'text-foreground-muted text-sm'
          }
        >
          {nowLine}
        </p>
      ) : null}
      {rule?.note ? <p className="text-foreground-muted text-xs">{rule.note}</p> : null}
      {!rule ? (
        <p className="text-foreground-muted text-sm italic">{revealPlaceholder('posted rules')}</p>
      ) : null}
    </div>
  );
}

/**
 * The same rule on one line, for a put-in or lot row inside `AccessSection`.
 *
 * No heading and no note: those rows are already dense, and the heading would repeat once per access
 * point on a lake with four of them. The full text stays available on the body's strip.
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
    <p className="text-xs">
      <span className="text-foreground-muted">{described}</span>
      {nowLine ? (
        <span className={closed ? 'text-amber-700 dark:text-amber-400' : 'text-foreground-muted'}>
          {` · ${nowLine}`}
        </span>
      ) : null}
    </p>
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
 * Re-render once a minute so "Closed now · opens 6:42 AM" doesn't go stale in an open drawer.
 *
 * A minute rather than a second: every value this drives is rendered to the minute, so a faster tick
 * would repaint without ever changing a character. The interval is skipped entirely when there is no
 * rule, which is the great majority of bodies.
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
