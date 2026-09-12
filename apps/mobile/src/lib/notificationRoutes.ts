import type { NotificationTarget, NotificationView } from '@skating/core';
import type { Href } from 'expo-router';

/**
 * Where a notification's tap goes on mobile (N8/A3). `describeNotification` hands back a
 * platform-neutral target; this is the one place it becomes an Expo Router href.
 *
 * `unreported_skates` is the You tab, where `UnreportedSkates` lists the skate and offers the report
 * button — the notification is the nudge, the list is the place. `flags` has nowhere honest to go
 * (the flagger isn't owed the target, N8/B3), so it stays untappable.
 */
export function notificationRoute(
  target: NotificationTarget | null,
  _view: NotificationView,
): Href | null {
  switch (target?.kind) {
    case 'report':
      return { pathname: '/report/[id]', params: { id: target.id } };
    case 'hazard':
      return { pathname: '/hazard/[id]', params: { id: target.id } };
    case 'bounty':
      return { pathname: '/bounty/[id]', params: { id: target.id } };
    case 'water':
      return { pathname: '/water/[id]', params: { id: target.id } };
    case 'unreported_skates':
      return '/you';
    case 'flags':
    case undefined:
      return null;
  }
}
