import type { NotificationView } from '@skating/core';
import { describe, expect, test } from 'vitest';
import { renderNotificationEmail, webPathForTarget } from './notificationEmail';

const base = { id: 'n1', createdAt: 0 };
const opts = {
  webAppUrl: 'https://app.example.test',
  unsubscribeUrl: 'https://x.convex.site/unsubscribe?u=1&t=2',
};
const unknown: NotificationView = { ...base, type: 'unknown' };

describe('webPathForTarget', () => {
  test('maps every target kind to its web route, and the ones with no web surface to null', () => {
    expect(webPathForTarget({ kind: 'report', id: 'r' }, unknown)).toBe('/report/r');
    expect(webPathForTarget({ kind: 'hazard', id: 'h' }, unknown)).toBe('/hazard/h');
    expect(webPathForTarget({ kind: 'bounty', id: 'b' }, unknown)).toBe('/bounty/b');
    expect(webPathForTarget({ kind: 'water', id: 'w' }, unknown)).toBe('/water/w');
    expect(webPathForTarget({ kind: 'flags' }, unknown)).toBeNull();
    expect(webPathForTarget(null, unknown)).toBeNull();
    // An unreported skate has no web list — it falls back to the lake when there is one.
    const skate: NotificationView = {
      ...base,
      type: 'activity_detected',
      activityId: 'a',
      body: { id: 'w', name: 'Lake Morey' },
      startTime: 0,
    };
    expect(webPathForTarget({ kind: 'unreported_skates' }, skate)).toBe('/water/w');
    expect(webPathForTarget({ kind: 'unreported_skates' }, { ...skate, body: null })).toBeNull();
  });
});

describe('renderNotificationEmail', () => {
  test('carries the sentence, the deep link and the unsubscribe link, escaped', () => {
    const view: NotificationView = {
      ...base,
      type: 'bounty_answered',
      target: { id: 'b', available: true },
      body: { id: 'w', name: 'Lake <Morey>' },
      count: 1,
    };
    const mail = renderNotificationEmail(view, opts);
    expect(mail.subject).toBe('A report came in on Lake <Morey>');
    expect(mail.html).toContain('Lake &lt;Morey&gt;');
    expect(mail.html).toContain('https://app.example.test/bounty/b');
    // Attribute-escaped in HTML (`&amp;`), raw in text.
    expect(mail.html).toContain('https://x.convex.site/unsubscribe?u=1&amp;t=2');
    expect(mail.text).toContain('Open: https://app.example.test/bounty/b');
    expect(mail.text).toContain(`Unsubscribe: ${opts.unsubscribeUrl}`);
  });

  test('a notification with nowhere to go has no link and still unsubscribes', () => {
    const mail = renderNotificationEmail(
      { ...base, type: 'content_flag_resolved', resolution: 'dismissed' },
      opts,
    );
    expect(mail.html).not.toContain('Open in Gli');
    expect(mail.text).not.toContain('Open:');
    expect(mail.text).toContain('Unsubscribe:');
  });
});
