import type { NotificationTarget, NotificationView } from '@skating/core';

/**
 * Where a notification's tap goes on the web (N8/A3). `describeNotification` hands back a
 * platform-neutral target; this is the one place it becomes a route.
 *
 * `unreported_skates` has no web surface — the recorder is mobile-only, and the You-tab list it
 * points at doesn't exist here — so an `activity_detected` row falls back to the lake it was skated
 * on, which is at least where the report gets written. `flags` is likewise untappable: the flagger
 * isn't owed the target (N8/B3), so there is nowhere honest to send them.
 */
export function notificationHref(
  target: NotificationTarget | null,
  view: NotificationView,
): {
  to: '/report/$id' | '/hazard/$id' | '/bounty/$id' | '/water/$id';
  params: { id: string };
} | null {
  switch (target?.kind) {
    case 'report':
      return { to: '/report/$id', params: { id: target.id } };
    case 'hazard':
      return { to: '/hazard/$id', params: { id: target.id } };
    case 'bounty':
      return { to: '/bounty/$id', params: { id: target.id } };
    case 'water':
      return { to: '/water/$id', params: { id: target.id } };
    case 'unreported_skates':
      return view.type === 'activity_detected' && view.body
        ? { to: '/water/$id', params: { id: view.body.id } }
        : null;
    case 'flags':
    case undefined:
      return null;
  }
}
