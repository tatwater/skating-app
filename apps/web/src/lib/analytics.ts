import { usePostHog } from '@posthog/react';
import type { HazardGeometryKind, HazardType, NotificationType, RequestKind } from '@skating/core';
import type { ThemePreference } from '@skating/design';
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

  // ── The B03 skater-web taxonomy (D240), same rules: countable shape only; no text, name, id
  // ── or coordinate; nothing about the ice. Names are object_verb, past tense.

  /** A lake's page was opened, by which surface led there. */
  water_body_opened: { source: WaterBodyOpenSource };
  /** One of the lake sidebar's four tabs was brought up. */
  water_body_tab_viewed: { tab: WaterBodyTab };
  /** A report inset card was opened. */
  report_viewed: { source: PanelViewSource };
  /** A hazard inset card was opened. */
  hazard_viewed: { source: PanelViewSource };
  /** A bounty inset card was opened. */
  bounty_viewed: { source: PanelViewSource };

  /** Global search was opened. */
  search_opened: { surface: SearchOpenSurface };
  /** A search result was picked: its kind, its rank in the list, and the query's size — never its text. */
  search_result_opened: {
    result_kind: SearchResultKind;
    rank: number;
    query_length_bucket: QueryLengthBucket;
  };
  /** A query came back empty. */
  search_no_results: { query_length_bucket: QueryLengthBucket };

  /** A Latest filter changed, by which control — never to what value. */
  latest_filter_changed: { filter: LatestFilter };
  /** A report was opened out of the Latest feed. */
  latest_report_opened: undefined;
  /** A bounty was opened out of "Wanted near you". */
  wanted_bounty_opened: undefined;

  /** The report sheet opened, by which door. */
  report_sheet_opened: { entry: ReportSheetEntry };
  /** Posting was refused for missing minimum-set answers — how many, never which. */
  report_sheet_refused: { missing_count: number };
  /**
   * The sheet was left with writing in it. Fired on `pagehide` plus next-open reconciliation —
   * `beforeunload` is unreliable, so the count may arrive on the *next* visit.
   */
  report_sheet_abandoned: { sections_answered: number };
  /** A stored draft was restored into the sheet. */
  report_draft_restored: undefined;
  /** A failed post was retried from the attempt record. */
  report_post_retried: { offline: boolean };
  /** Photos joined the report, by source. */
  report_photos_added: { source: ReportPhotoSource; count: number };
  /** A GPX import began. */
  gpx_import_started: undefined;
  /** A GPX import parsed and attached. */
  gpx_import_completed: { point_count_bucket: PointCountBucket };

  /** The hazard flow began, from the lake page or stacked inside the report sheet. */
  hazard_flow_started: { entry: HazardFlowEntry };
  /**
   * A verdict on an existing hazard was submitted. The values are the author's own claims, as
   * labeled in the UI (D3: a record of what a person said they saw, never what the ice is).
   */
  hazard_verdict_submitted: { verdict: HazardVerdict };

  /** A map layer was toggled. */
  map_layer_toggled: { layer: MapLayerName; on: boolean };
  /** The imagery view opened, by band. */
  imagery_opened: { band: ImageryBand };
  /** The dock's "return to the region" was used. */
  return_to_region_used: undefined;
  /** Directions opened toward a put-in or a parking spot. */
  directions_opened: { target: DirectionsTarget };

  /** The bell opened, with how big the unread pile was. */
  notifications_opened: { unread_bucket: UnreadBucket };
  /** A notification row was followed, by its type. */
  notification_opened: { kind: NotificationType };
  /** The theme picker changed the preference. */
  theme_changed: { mode: ThemePreference };
  /** "Connect with Strava" was pressed (the OAuth leaves the app here). */
  strava_connect_started: undefined;
  /** The sign-in flow sent a code. */
  sign_in_code_sent: { method: SignInMethod };
  /** The sign-in flow completed. */
  sign_in_completed: { method: SignInMethod };
}

/** Whether a favorite was placed on a whole body or one of its sub-areas. */
export type FavoriteTargetType = 'water_body' | 'sub_area';

/**
 * The enum-valued properties of the B03 taxonomy, as const tuples so a test can walk every value
 * (D3: no value may read as a statement about the ice). The property types below derive from
 * these — one source for the type, the test, and any UI that switches over them.
 */
export const ANALYTICS_ENUMS = {
  water_body_opened_source: ['map', 'list', 'search', 'notification', 'latest', 'deep_link'],
  water_body_tab: ['reports', 'weather', 'access', 'about'],
  panel_view_source: [
    'map',
    'list',
    'search',
    'notification',
    'latest',
    'deep_link',
    'water_body',
    'profile',
  ],
  search_open_surface: ['top_bar', 'phone', 'hotkey'],
  search_result_kind: ['water_body', 'sub_area', 'skater'],
  query_length_bucket: ['1-2', '3-5', '6-11', '12+'],
  latest_filter: ['drive_time', 'posted', 'quality', 'ice_type', 'thickness', 'weather_match'],
  report_sheet_entry: [
    'top_bar',
    'water_body',
    'notification',
    'phone_tab',
    'edit',
    'recorded_skate',
  ],
  report_photo_source: ['device', 'google_photos'],
  point_count_bucket: ['1-99', '100-999', '1000-9999', '10000+'],
  hazard_flow_entry: ['water_body', 'report_sheet'],
  // The author's own claims, as labeled in the UI.
  hazard_verdict: ['still_there', 'crossed_here', 'healing', 'fully_healed', 'didnt_look'],
  // The dock's switches. Hazards are locked on, so nothing toggles them; imagery has its own event.
  map_layer_name: ['depth', 'places', 'put_ins', 'tracks', 'favorites', 'labels'],
  imagery_band: ['tc', 'vh'],
  directions_target: ['put_in', 'parking'],
  unread_bucket: ['0', '1-3', '4-9', '10+'],
  sign_in_method: ['email_code'],
} as const;

export type WaterBodyOpenSource = (typeof ANALYTICS_ENUMS.water_body_opened_source)[number];
export type WaterBodyTab = (typeof ANALYTICS_ENUMS.water_body_tab)[number];
export type PanelViewSource = (typeof ANALYTICS_ENUMS.panel_view_source)[number];
export type SearchOpenSurface = (typeof ANALYTICS_ENUMS.search_open_surface)[number];
export type SearchResultKind = (typeof ANALYTICS_ENUMS.search_result_kind)[number];
export type QueryLengthBucket = (typeof ANALYTICS_ENUMS.query_length_bucket)[number];
export type LatestFilter = (typeof ANALYTICS_ENUMS.latest_filter)[number];
export type ReportSheetEntry = (typeof ANALYTICS_ENUMS.report_sheet_entry)[number];
export type ReportPhotoSource = (typeof ANALYTICS_ENUMS.report_photo_source)[number];
export type PointCountBucket = (typeof ANALYTICS_ENUMS.point_count_bucket)[number];
export type HazardFlowEntry = (typeof ANALYTICS_ENUMS.hazard_flow_entry)[number];
export type HazardVerdict = (typeof ANALYTICS_ENUMS.hazard_verdict)[number];
export type MapLayerName = (typeof ANALYTICS_ENUMS.map_layer_name)[number];
export type ImageryBand = (typeof ANALYTICS_ENUMS.imagery_band)[number];
export type DirectionsTarget = (typeof ANALYTICS_ENUMS.directions_target)[number];
export type UnreadBucket = (typeof ANALYTICS_ENUMS.unread_bucket)[number];
export type SignInMethod = (typeof ANALYTICS_ENUMS.sign_in_method)[number];

/** A query's size without its text: the bucket is countable shape, the characters are content. */
export function bucketQueryLength(length: number): QueryLengthBucket {
  if (length <= 2) return '1-2';
  if (length <= 5) return '3-5';
  if (length <= 11) return '6-11';
  return '12+';
}

/** A GPX track's size without its path. */
export function bucketPointCount(count: number): PointCountBucket {
  if (count <= 99) return '1-99';
  if (count <= 999) return '100-999';
  if (count <= 9999) return '1000-9999';
  return '10000+';
}

/** The unread pile's size without its contents. */
export function bucketUnreadCount(count: number): UnreadBucket {
  if (count <= 0) return '0';
  if (count <= 3) return '1-3';
  if (count <= 9) return '4-9';
  return '10+';
}

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
        try {
          posthog.capture(name, args[0]);
        } catch {
          // Analytics never fails the thing it is measuring. Every call site but one sits inside
          // the `try` that reports a write back to the skater, so a throw from the SDK would turn
          // a hazard that *did* file into "Could not save that hazard" — and the honest response
          // to that message is to file the pin again, which is a duplicate hazard on the map.
          // A lost count is the cheapest possible outcome here, so swallow it.
        }
      },
    }),
    [posthog],
  );
}
