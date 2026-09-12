/**
 * The notification vocabulary and the inbox's rendering model (N8 / D164).
 *
 * Two things live here, and both are here because **web and mobile must agree**:
 *
 * 1. **The type list and its preference keys.** D16 says every type is toggleable, and the D78-style
 *    rule N8 adds is that a type may not exist without a producer *and* a place it renders. The list
 *    used to live only in the backend's `lib/enums.ts`, which meant the two settings pages each carried
 *    their own hand-picked subset of toggles — three of ten — and nobody could tell from either page
 *    which types the other one had. The list moves here, with a label per key, so a settings page
 *    iterates the vocabulary rather than re-typing it.
 *
 * 2. **`NotificationView` and `describeNotification`.** The server resolves a stored row (ids in a
 *    payload) into a view with names attached; the clients turn that view into a sentence and a tap
 *    target. Putting the sentence here means "Ellie found your report on Lake Morey helpful" reads
 *    identically on both surfaces, and a copy change is one edit.
 */

import type { HazardLifecyclePhase } from './hazardLifecycle';

// ── Types and preferences ────────────────────────────────────────────────────────────────────────

/**
 * Notification types (snake_case). Every one has a producer and renders in the inbox — see the N8
 * plan's Correction 2 for the four that didn't, and D165 for why that's now a rule rather than a
 * hope.
 */
export const NOTIFICATION_TYPES = [
  'activity_detected', // a recorded skate nobody was asked about (N8/B4) — our recorder only
  'bounty_request', // a bounty opened on a lake you recently reported (Phase 6)
  'hazard_confirmation', // your hazard's lifecycle moved: confirmed, disputed, healed (N8/B2)
  'bounty_answered', // a report landed on your open bounty (N8; replaces `bounty_fulfilled`)
  'report_rated', // someone found your report/hazard helpful, or corroborated your report (Phase 6)
  'report_commented', // someone commented on your report or replied to your comment (D21; N8/B1)
  'content_flag_resolved', // a moderator ruled on a flag you filed (N8/B3)
  'favorite_report', // a report on a body you favorited (Phase 4, decision #4)
  'nearby_report_digest', // daily 8pm digest of all reports within X₁ (Phase 4)
  'great_report_nearby', // a `great` report within X₂ (Phase 4)
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** The matching `notificationPrefs` keys (camelCase). D16 invariant: mirrors `NOTIFICATION_TYPES` 1:1. */
export const NOTIFICATION_PREF_KEYS = [
  'activityDetected',
  'bountyRequest',
  'hazardConfirmation',
  'bountyAnswered',
  'reportRated',
  'reportCommented',
  'contentFlagResolved',
  'favoriteReport',
  'nearbyReportDigest',
  'greatReportNearby',
] as const;
export type NotificationPrefKey = (typeof NOTIFICATION_PREF_KEYS)[number];

/** Type → pref key, so a producer can gate on the right toggle without spelling the pair twice. */
export const NOTIFICATION_PREF_KEY_FOR: Record<NotificationType, NotificationPrefKey> = {
  activity_detected: 'activityDetected',
  bounty_request: 'bountyRequest',
  hazard_confirmation: 'hazardConfirmation',
  bounty_answered: 'bountyAnswered',
  report_rated: 'reportRated',
  report_commented: 'reportCommented',
  content_flag_resolved: 'contentFlagResolved',
  favorite_report: 'favoriteReport',
  nearby_report_digest: 'nearbyReportDigest',
  great_report_nearby: 'greatReportNearby',
};

/**
 * Per-key default for a fresh profile (D16). Everything defaults ON *except* the two opt-in Phase-4
 * drive-time buckets (decision #4): favorites notify by default, but "all reports nearby" and "great
 * reports nearby" are the surfaces a user must opt into.
 */
export const NOTIFICATION_PREF_DEFAULTS: Record<NotificationPrefKey, boolean> = {
  activityDetected: true,
  bountyRequest: true,
  hazardConfirmation: true,
  bountyAnswered: true,
  reportRated: true,
  reportCommented: true,
  contentFlagResolved: true,
  favoriteReport: true,
  nearbyReportDigest: false,
  greatReportNearby: false,
};

/**
 * The settings-page label for each toggle, in the order the page shows them. Grouped so the two
 * radius-bearing Phase-4 buckets sit together at the end where their "within" rows hang off them.
 */
export const NOTIFICATION_PREF_LABELS: Record<NotificationPrefKey, string> = {
  favoriteReport: "New reports on lakes I've favorited",
  reportCommented: 'Comments on my reports and replies to my comments',
  reportRated: 'Someone found my report helpful, or backed it up',
  hazardConfirmation: 'Updates on hazards I marked',
  bountyRequest: "Someone's looking for a report on a lake I know",
  bountyAnswered: 'A report comes in on a lake I asked about',
  contentFlagResolved: 'A moderator rules on something I flagged',
  activityDetected: "Skates I recorded but haven't reported",
  nearbyReportDigest: 'Daily digest of all reports nearby',
  greatReportNearby: "Great reports nearby (I'll drive farther for perfect ice)",
};

/** The toggles a settings page renders, in display order — everything, per D16. */
export const NOTIFICATION_PREF_ORDER: readonly NotificationPrefKey[] = [
  'favoriteReport',
  'reportCommented',
  'reportRated',
  'hazardConfirmation',
  'bountyRequest',
  'bountyAnswered',
  'contentFlagResolved',
  'activityDetected',
  'nearbyReportDigest',
  'greatReportNearby',
];

// ── The resolved view ────────────────────────────────────────────────────────────────────────────

/**
 * A reference to a lake, with the name a sentence needs. `null` at the use site means the body is
 * gone — vanishingly rare (bodies are pruned by the ETL, not by users) but the sentence has to cope.
 */
export interface NotificationBodyRef {
  id: string;
  name: string;
}

/**
 * A reference to a piece of content — a report, hazard, bounty, or comment — the notification is
 * about. `available: false` is the degraded case the founder settled at scoping (N8 #5): the target
 * was hidden, removed, or never resolved, so the row is **shown, described, and not tappable**. A row
 * that silently vanished would read as a bug; a tap that lands on "not found" would read as one too.
 */
export interface NotificationContentRef {
  id: string;
  available: boolean;
}

/**
 * The people behind an actor-keyed notification, already reduced to what a sentence needs: the
 * first couple of display names and the total. Names come through `publicAuthor`, so a departed
 * skater reads as their tombstone name rather than as a hole. Blocked actors are filtered *before*
 * this is built (block == mute, Phase 3), and a notification with no unblocked actors left is
 * dropped from the list rather than rendered as "0 people".
 */
export interface NotificationActors {
  names: string[];
  count: number;
}

/** A resolved, renderable notification. One variant per type (plus the degraded fallback). */
export type NotificationView = { id: string; createdAt: number; readAt?: number } & (
  | {
      type: 'report_rated';
      kind: 'thumb';
      targetType: 'report' | 'hazard';
      target: NotificationContentRef;
      body: NotificationBodyRef | null;
      actors: NotificationActors;
    }
  | {
      type: 'report_rated';
      kind: 'corroboration';
      target: NotificationContentRef;
      body: NotificationBodyRef | null;
      /** How many later reports agreed with yours inside the settle window. */
      count: number;
    }
  | {
      type: 'report_commented';
      /** `true` when this is a reply to *your comment* rather than a comment on *your report*. */
      reply: boolean;
      target: NotificationContentRef;
      body: NotificationBodyRef | null;
      actors: NotificationActors;
      count: number;
    }
  | {
      type: 'hazard_confirmation';
      target: NotificationContentRef;
      body: NotificationBodyRef | null;
      /**
       * The lifecycle transition this reports (N8/B2) — `hazardLifecyclePhase` in `hazardLifecycle.ts`.
       * The re-check at flush is an equality on this value: if the pin has moved on again, the older
       * transition is no longer news.
       */
      phase: HazardLifecyclePhase;
    }
  | {
      type: 'content_flag_resolved';
      resolution: 'actioned' | 'dismissed';
    }
  | {
      type: 'bounty_request';
      target: NotificationContentRef;
      body: NotificationBodyRef | null;
    }
  | {
      type: 'bounty_answered';
      target: NotificationContentRef;
      body: NotificationBodyRef | null;
      count: number;
    }
  | {
      type: 'favorite_report' | 'great_report_nearby';
      target: NotificationContentRef;
      body: NotificationBodyRef | null;
      count: number;
    }
  | {
      type: 'nearby_report_digest';
      bodies: { body: NotificationBodyRef | null; target: NotificationContentRef; count: number }[];
      totalCount: number;
    }
  | {
      type: 'activity_detected';
      activityId: string;
      body: NotificationBodyRef | null;
      startTime: number;
    }
  | {
      /**
       * A stored row whose payload the resolver didn't recognise — a shape from before the payloads
       * were typed, or a type retired after the row was written. Rendered as a plain line rather than
       * hidden, for the same reason a removed target is (N8 #5). The season purge retires these.
       */
      type: 'unknown';
    }
);

// ── Rendering ────────────────────────────────────────────────────────────────────────────────────

/** Where a tap on a notification goes. Both clients map these onto their own routes. */
export type NotificationTarget =
  | { kind: 'report'; id: string }
  | { kind: 'hazard'; id: string }
  | { kind: 'bounty'; id: string }
  | { kind: 'water'; id: string }
  | { kind: 'unreported_skates' }
  | { kind: 'flags' };

export interface NotificationDescription {
  /** The one-line sentence. */
  title: string;
  /** An optional second, quieter line. */
  detail?: string;
  /** `null` when there's nowhere to go — the degraded case, or a type with no natural target. */
  target: NotificationTarget | null;
}

const UNAVAILABLE_REPORT = 'a report that’s no longer available';
const UNAVAILABLE_HAZARD = 'a hazard that’s no longer available';
const UNAVAILABLE_BOUNTY = 'a bounty that’s no longer open';

/** "Ellie", "Ellie and Sam", "Ellie, Sam and 3 others" — the actor phrase for a sentence. */
export function describeActors(actors: NotificationActors): string {
  const [first, second] = actors.names;
  if (actors.count <= 0 || first === undefined) return 'Someone';
  if (actors.count === 1) return first;
  if (actors.count === 2 && second !== undefined) return `${first} and ${second}`;
  const rest = actors.count - (second === undefined ? 1 : 2);
  if (second === undefined) return `${first} and ${rest} ${rest === 1 ? 'other' : 'others'}`;
  return `${first}, ${second} and ${rest} ${rest === 1 ? 'other' : 'others'}`;
}

function onLake(body: NotificationBodyRef | null): string {
  return body ? ` on ${body.name}` : '';
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** The tap target for a content ref, or `null` when it's degraded. */
function contentTarget(
  kind: 'report' | 'hazard' | 'bounty',
  ref: NotificationContentRef,
): NotificationTarget | null {
  return ref.available ? { kind, id: ref.id } : null;
}

/**
 * The sentence and tap target for a resolved notification. Pure, and the only place notification copy
 * lives — see the module note.
 */
export function describeNotification(view: NotificationView): NotificationDescription {
  switch (view.type) {
    case 'report_rated': {
      if (view.kind === 'thumb') {
        const who = describeActors(view.actors);
        if (!view.target.available) {
          return {
            title: `${who} found ${view.targetType === 'hazard' ? UNAVAILABLE_HAZARD : UNAVAILABLE_REPORT} helpful`,
            target: null,
          };
        }
        const noun = view.targetType === 'hazard' ? 'hazard' : 'report';
        return {
          title: `${who} found your ${noun}${onLake(view.body)} helpful`,
          target: contentTarget(view.targetType, view.target),
        };
      }
      if (!view.target.available) {
        return { title: `Another skater backed up ${UNAVAILABLE_REPORT}`, target: null };
      }
      const n = view.count;
      return {
        title:
          n === 1
            ? `Another skater backed up your report${onLake(view.body)}`
            : `${n} other skaters backed up your report${onLake(view.body)}`,
        detail: 'Their report agreed with yours — that counts toward your reputation.',
        target: contentTarget('report', view.target),
      };
    }
    case 'report_commented': {
      const who = describeActors(view.actors);
      const what = view.reply ? 'replied to your comment' : 'commented on your report';
      if (!view.target.available) {
        return {
          title: view.reply
            ? `${who} replied to your comment on ${UNAVAILABLE_REPORT}`
            : `${who} commented on ${UNAVAILABLE_REPORT}`,
          target: null,
        };
      }
      const n = view.count;
      return {
        title: `${who} ${what}${onLake(view.body)}`,
        ...(n > 1 ? { detail: `${n} new ${plural(n, 'comment', 'comments')}` } : {}),
        target: contentTarget('report', view.target),
      };
    }
    case 'hazard_confirmation': {
      if (!view.target.available) {
        return { title: `An update on ${UNAVAILABLE_HAZARD}`, target: null };
      }
      const where = onLake(view.body);
      const title = {
        provisional: `Your hazard${where} is back to a single sighting`,
        confirmed: `Another skater confirmed your hazard${where} is still there`,
        healing_unsafe: `Skaters say your hazard${where} is healing but not safe yet`,
        disputed: `A skater says the crossing you marked${where} isn’t passable`,
        archived: `Skaters say your hazard${where} has healed — it’s off the map`,
      }[view.phase];
      return { title, target: contentTarget('hazard', view.target) };
    }
    case 'content_flag_resolved':
      // Deliberately verdict-only (N8/B3): not what was done, not to whom, not by which moderator.
      return view.resolution === 'actioned'
        ? { title: 'A moderator reviewed something you flagged and took action', target: null }
        : { title: 'A moderator reviewed something you flagged and left it up', target: null };
    case 'bounty_request':
      if (!view.target.available) {
        return { title: `Someone asked for a report on ${UNAVAILABLE_BOUNTY}`, target: null };
      }
      return {
        title: view.body
          ? `Someone’s looking for a report on ${view.body.name}`
          : 'Someone’s looking for a report on a lake you know',
        detail: 'You reported there recently — is it still skateable?',
        target: contentTarget('bounty', view.target),
      };
    case 'bounty_answered': {
      const n = view.count;
      if (!view.target.available) {
        return {
          title: `${n === 1 ? 'A report' : `${n} reports`} came in on ${UNAVAILABLE_BOUNTY}`,
          target: null,
        };
      }
      return {
        title: `${n === 1 ? 'A report' : `${n} reports`} came in on ${view.body ? view.body.name : 'a lake you asked about'}`,
        detail: 'Mark it helpful if it answers your question.',
        target: contentTarget('bounty', view.target),
      };
    }
    case 'favorite_report':
    case 'great_report_nearby': {
      const n = view.count;
      const lake = view.body ? view.body.name : 'a lake';
      const title =
        view.type === 'great_report_nearby'
          ? n === 1
            ? `Great ice reported on ${lake}`
            : `${n} great reports on ${lake}`
          : n === 1
            ? `New report on ${lake}`
            : `${n} new reports on ${lake}`;
      // A body-level target rather than the report: the report may have been superseded by the time
      // the tap lands, and the lake's report list is where "N new reports" makes sense anyway.
      return {
        title,
        target: view.body
          ? { kind: 'water', id: view.body.id }
          : contentTarget('report', view.target),
      };
    }
    case 'nearby_report_digest': {
      const lakes = view.bodies.length;
      const n = view.totalCount;
      const names = view.bodies
        .map((b) => b.body?.name)
        .filter((name): name is string => name !== undefined);
      const title =
        lakes === 1
          ? `${n} new ${plural(n, 'report', 'reports')} near you on ${names[0] ?? 'a lake'}`
          : `${n} new ${plural(n, 'report', 'reports')} near you across ${lakes} lakes`;
      const first = view.bodies[0];
      return {
        title,
        ...(lakes > 1 && names.length > 0 ? { detail: names.slice(0, 3).join(' · ') } : {}),
        target: first?.body ? { kind: 'water', id: first.body.id } : null,
      };
    }
    case 'activity_detected':
      return {
        title: view.body
          ? `You skated on ${view.body.name}. Add a report?`
          : 'You recorded a skate. Add a report?',
        target: { kind: 'unreported_skates' },
      };
    case 'unknown':
      return { title: 'An older notification that can no longer be shown', target: null };
  }
}
