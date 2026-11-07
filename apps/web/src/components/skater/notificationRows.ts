import { describeNotification, type NotificationType, type NotificationView } from '@skating/core';

import { notificationHref } from '@/lib/notificationTargets';

/**
 * The bell's rows (boards 3.21–3.23), from the resolved notifications the inbox query returns. The
 * sentence comes from `@skating/core`'s `describeNotification` — the one home of notification copy,
 * shared with mobile — and the target from `lib/notificationTargets`; this module only adds what
 * the dropdown draws: the leading mark, the short time, and which group a row sits in.
 */

/** The glyph tile's picture, by what the notification is about. */
export type NotificationIcon = 'hazard' | 'clock' | 'report' | 'bounty' | 'flag' | 'bell';

export type NotificationMark =
  /** Someone did something: their face (initials — the inbox carries names, not photos). */
  | { kind: 'person'; name: string }
  /** Something happened: a glyph in a square tile, red for a hazard. */
  | { kind: 'icon'; icon: NotificationIcon; tone?: 'bad' };

export interface NotificationRowModel {
  id: string;
  title: string;
  detail?: string;
  /** "12 m", "1 h", "Fri", "9 Jan". */
  when: string;
  unread: boolean;
  mark: NotificationMark;
  /** Where a press goes; `null` for a row with nowhere honest to go (shown, not a link). */
  href: string | null;
  /** The type `notification_opened` reports. */
  kind: NotificationType | null;
}

/** The leading mark for a view. */
export function notificationMark(view: NotificationView): NotificationMark {
  switch (view.type) {
    case 'report_commented':
      return { kind: 'person', name: view.actors.names[0] ?? 'Someone' };
    case 'report_rated':
      return view.kind === 'thumb'
        ? { kind: 'person', name: view.actors.names[0] ?? 'Someone' }
        : { kind: 'icon', icon: 'report' };
    case 'hazard_confirmation':
      return { kind: 'icon', icon: 'hazard', tone: 'bad' };
    case 'activity_detected':
      return { kind: 'icon', icon: 'clock' };
    case 'bounty_request':
    case 'bounty_answered':
      return { kind: 'icon', icon: 'bounty' };
    case 'content_flag_resolved':
      return { kind: 'icon', icon: 'flag' };
    case 'favorite_report':
    case 'great_report_nearby':
    case 'nearby_report_digest':
      return { kind: 'icon', icon: 'report' };
    case 'unknown':
      return { kind: 'icon', icon: 'bell' };
  }
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * The row's short time, as the board writes it: minutes and hours while it's recent, the weekday
 * within the week, then the date.
 */
export function notificationWhen(createdAt: number, now: number, timeZone?: string): string {
  const diff = Math.max(0, now - createdAt);
  if (diff < MINUTE) return 'now';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} m`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} h`;
  const zone = timeZone ? { timeZone } : {};
  if (diff < 7 * DAY)
    return new Date(createdAt).toLocaleDateString('en-US', { weekday: 'short', ...zone });
  const d = new Date(createdAt);
  const day = d.toLocaleDateString('en-US', { day: 'numeric', ...zone });
  const month = d.toLocaleDateString('en-US', { month: 'short', ...zone });
  return `${day} ${month}`;
}

/**
 * Where a row goes. A recorded skate asks "Add a report?", so it opens the New report sheet on
 * that lake (D242's `?post=new&postBody=`) rather than only the lake page.
 */
export function notificationRowHref(view: NotificationView): string | null {
  const { target } = describeNotification(view);
  const to = notificationHref(target, view);
  if (to === null) return null;
  const path = to.to.replace('$id', encodeURIComponent(to.params.id));
  if (view.type === 'activity_detected' && view.body) {
    const id = encodeURIComponent(view.body.id);
    return `${path}?post=new&postBody=${id}`;
  }
  return path;
}

/**
 * The rows for a page of views. `newThisVisit` holds the ids this opening stamped read: they stay
 * drawn as new until the plate closes — the inbox's rule, so a row doesn't lose its wash the
 * moment the mark lands.
 */
export function notificationRows(
  views: readonly NotificationView[],
  newThisVisit: ReadonlySet<string>,
  now: number,
  timeZone?: string,
): NotificationRowModel[] {
  return views.map((view) => {
    const { title, detail } = describeNotification(view, timeZone ? { timeZone } : {});
    return {
      id: view.id,
      title,
      ...(detail ? { detail } : {}),
      when: notificationWhen(view.createdAt, now, timeZone),
      unread: view.readAt === undefined || newThisVisit.has(view.id),
      mark: notificationMark(view),
      href: notificationRowHref(view),
      kind: view.type === 'unknown' ? null : view.type,
    };
  });
}

/** New first, then Earlier; an empty group is left out. */
export function notificationGroups(
  rows: readonly NotificationRowModel[],
): { id: 'new' | 'earlier'; label: string; rows: NotificationRowModel[] }[] {
  const fresh = rows.filter((r) => r.unread);
  const earlier = rows.filter((r) => !r.unread);
  return [
    { id: 'new' as const, label: 'New', rows: fresh },
    { id: 'earlier' as const, label: 'Earlier', rows: earlier },
  ].filter((g) => g.rows.length > 0);
}
