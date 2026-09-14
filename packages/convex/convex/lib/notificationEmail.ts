/**
 * The email rendering of a notification (N8 PR 3 / D174): one resolved `NotificationView` → a
 * subject, an HTML body and a text body, with the deep link and the unsubscribe footer.
 *
 * Deliberately plain. The sentence is `describeNotification`'s — the same one the inbox and the push
 * show — and everything else is scaffolding: one link to the thing, one line saying why this arrived,
 * one link to stop it. Skater-facing mail is a thing a person can silence in one click; a template
 * that needed a design system would be a second product.
 */

import {
  describeNotification,
  type NotificationTarget,
  type NotificationView,
} from '@skating/core';
import { escapeHtml } from './resend';

/** The web route a target lands on — the email's link is always the web, never the app scheme. */
export function webPathForTarget(
  target: NotificationTarget | null,
  view: NotificationView,
): string | null {
  switch (target?.kind) {
    case 'report':
      return `/report/${target.id}`;
    case 'hazard':
      return `/hazard/${target.id}`;
    case 'bounty':
      return `/bounty/${target.id}`;
    case 'water':
      return `/water/${target.id}`;
    case 'unreported_skates':
      return view.type === 'activity_detected' && view.body ? `/water/${view.body.id}` : null;
    case 'flags':
    case undefined:
      return null;
  }
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export function renderNotificationEmail(
  view: NotificationView,
  opts: { webAppUrl: string; unsubscribeUrl: string; timeZone?: string },
): RenderedEmail {
  const { title, detail, target } = describeNotification(
    view,
    opts.timeZone ? { timeZone: opts.timeZone } : {},
  );
  const path = webPathForTarget(target, view);
  const link = path ? `${opts.webAppUrl}${path}` : null;
  const why =
    'You’re getting this because it’s about your skating on Gli. Turn off emails any time — this one link does it.';

  const html = `<div style="font-family:system-ui,sans-serif;max-width:520px;color:#0f172a">
  <p style="margin:0 0 12px;font-size:16px">${escapeHtml(title)}</p>
  ${detail ? `<p style="margin:0 0 12px;color:#475569">${escapeHtml(detail)}</p>` : ''}
  ${link ? `<p style="margin:16px 0 0"><a href="${escapeHtml(link)}" style="color:#0b69ff">Open in Gli →</a></p>` : ''}
  <hr style="border:0;border-top:1px solid #e2e8f0;margin:24px 0">
  <p style="margin:0;font-size:12px;color:#64748b">${escapeHtml(why)}
  <a href="${escapeHtml(opts.unsubscribeUrl)}" style="color:#64748b">Unsubscribe from emails</a>.</p>
</div>`;
  const text = [
    title,
    detail ?? '',
    link ? `\nOpen: ${link}` : '',
    `\n${why}\nUnsubscribe: ${opts.unsubscribeUrl}`,
  ]
    .filter((line) => line.length > 0)
    .join('\n');
  return { subject: title, html, text };
}
