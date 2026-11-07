import { usePostHog } from '@posthog/react';
import type { HazardGeometryKind, HazardType, RequestKind } from '@skating/core';
import { useMemo } from 'react';
import { isConfigured } from './env';

/**
 * The product-analytics event contract (D235).
 *
 * ## Why a typed map and not `posthog.capture('some_string', { … })`
 *
 * An analytics event is a schema that lives in two places — the call site and every chart built on
 * it — and the second place is invisible from the first. A typo in an event name does not fail; it
 * silently starts a *new*, empty series beside the one the dashboard reads, and nobody finds out
 * until a funnel reads zero for a week. The same goes for a property renamed on one of two call
 * sites. Naming every event and its properties here makes both failures compile errors instead.
 *
 * ## The rules the properties follow
 *
 * **Never the content, only its shape.** A report's text, a comment's body, a hazard's note, a
 * lake's name and anything positional stay out. What goes in is countable: how many readings, which
 * hazard type, whether a comment was a reply. That is what answers the questions
 * `backlog/posthog.md` actually asked — funnels, retention, which surfaces get touched — and
 * nothing here needs the content to answer them.
 *
 * **Never an identifier.** No `reportId`, no `waterBodyId`, no `userId` on an event. Identity is
 * attached once, centrally, by `PostHogIdentity`; an id on an event is a join key into skater
 * content living in a third-party processor, which is a different and much larger privacy posture
 * than counting.
 *
 * **Never a safety claim (D3).** These are records of *what a person did*, never of what the ice
 * is. There is deliberately no `ice_was_good`-shaped property anywhere in this map, and an event
 * that would need one does not belong here.
 */
export interface AnalyticsEventProperties {
  /** A signed-in user's profile row was provisioned — the end of the onboarding funnel. */
  onboarding_completed: undefined;
  /** A new ice report was published. `report_count` is how many readings rode along. */
  report_posted: { report_count: number };
  /** An existing report was edited and saved. */
  report_updated: undefined;
  /**
   * A hazard was filed. `photo_count` rather than the photos, `hazard_type` rather than the note.
   */
  hazard_reported: {
    hazard_type: HazardType;
    geometry_kind: HazardGeometryKind;
    photo_count: number;
  };
  /** An existing hazard was corroborated instead of a near-duplicate being filed. */
  existing_hazard_confirmed: { confirmation_source: 'duplicate_nudge' };
  /** A request for a fresh report was posted. */
  bounty_posted: { scoped_to_sub_area: boolean };
  /** A comment or reply was created. The body never rides along. */
  comment_created: { is_reply: boolean };
  /** A lake or bay was added to favorites. */
  water_body_favorited: { target_type: FavoriteTargetType };
  /** A lake or bay was removed from favorites. */
  water_body_unfavorited: { target_type: FavoriteTargetType };
  /** A catalog or standing request was submitted, by kind. */
  water_body_request_submitted: { request_kind: RequestKind };
}

/** Whether a favorite was placed on a whole body or one of its sub-areas. */
export type FavoriteTargetType = 'water_body' | 'sub_area';

/** Every event name the app may send. Exported so the test can assert the set has not drifted. */
export type AnalyticsEventName = keyof AnalyticsEventProperties;

/**
 * `capture` arguments for one event: the properties object, or nothing at all for the events that
 * carry none. Spelled as a tuple so `capture('report_updated')` is correct *and*
 * `capture('report_posted')` is a compile error for missing its count.
 */
type CaptureArgs<K extends AnalyticsEventName> = AnalyticsEventProperties[K] extends undefined
  ? []
  : [properties: AnalyticsEventProperties[K]];

export interface Analytics {
  capture<K extends AnalyticsEventName>(name: K, ...args: CaptureArgs<K>): void;
}

/**
 * The typed `capture` for the app's product events.
 *
 * Returns a no-op when no PostHog token is configured, which is the normal state in tests and in
 * any deployment that has not been given one. Without this guard every call site would reach the
 * uninitialized `posthog-js` singleton that `usePostHog` falls back to outside a provider, which
 * does not throw but does log an error per call — so a test suite would pass while printing one
 * "You must initialize PostHog" line per interaction, and a keyless deployment would do the same
 * in a real user's console.
 */
export function useAnalytics(): Analytics {
  const posthog = usePostHog();

  return useMemo<Analytics>(
    () => ({
      capture: (name, ...args) => {
        if (!isConfigured.posthog) return;
        posthog.capture(name, args[0]);
      },
    }),
    [posthog],
  );
}
