/**
 * Operator alerts (D38) — email the founder when something needs eyes: every new `supportTickets` row
 * and every safety-priority flag (`unsafe_false_report`, `category: safety`). Alerts deep-link into the
 * `/admin` queue so the founder's inbox is a real work trigger, not just a notice.
 *
 * Transport is **Resend** (D38/D35 free tier), via `lib/resend` — shared with the N3 data-export email
 * since that became the second caller. The send is a Convex **action** (fetch to the Resend REST API —
 * the default runtime supports fetch; no Node bundle needed) scheduled fire-and-forget from the
 * mutations that create the rows. **All Resend env vars ship unset**: the send **no-ops (logs) when
 * `RESEND_API_KEY` / `RESEND_FROM_EMAIL` are absent**, so it never blocks the build — the founder drops
 * real keys + verifies the domain at the end (see the Resend checklist in the phase plan).
 *
 * The HTML is a small hand-built template. D38 names React Email as the authoring tool; that can be
 * swapped in later (a `"use node"` action rendering `@react-email/components`) without changing this
 * mutation-facing contract — kept as plain HTML here to avoid a Node/JSX bundle for a founder-only email.
 */

import { v } from 'convex/values';
import { internal } from './_generated/api';
import { internalAction, internalQuery } from './_generated/server';
import { clerkEmailForSubject } from './lib/clerkEmail';
import { escapeHtml, sendEmail } from './lib/resend';

/**
 * Send one operator alert. `deepLinkPath` is appended to `WEB_APP_URL` to make the "Open in /admin"
 * link. Best-effort: a missing key or a failed send is logged, never thrown (it's scheduled off a
 * mutation that already committed the row).
 */
export const send = internalAction({
  args: {
    subject: v.string(),
    heading: v.string(),
    lines: v.array(v.string()),
    deepLinkPath: v.string(),
  },
  handler: async (_ctx, { subject, heading, lines, deepLinkPath }) => {
    const to = process.env.OPERATOR_ALERT_EMAIL;
    if (!to) {
      console.warn(
        `Operator alert skipped: OPERATOR_ALERT_EMAIL is unset — ${subject}. (RESEND_API_KEY / RESEND_FROM_EMAIL are checked in lib/resend.)`,
      );
      return;
    }

    const base = process.env.WEB_APP_URL ?? '';
    const link = `${base}${deepLinkPath}`;
    const bodyLines = lines.map((l) => `<p style="margin:0 0 8px">${escapeHtml(l)}</p>`).join('');
    const html = `<div style="font-family:system-ui,sans-serif;max-width:520px">
      <h2 style="margin:0 0 12px">${escapeHtml(heading)}</h2>
      ${bodyLines}
      <p style="margin:16px 0 0"><a href="${escapeHtml(link)}" style="color:#0b69ff">Open in /admin →</a></p>
    </div>`;
    const text = `${heading}\n\n${lines.join('\n')}\n\nOpen: ${link}`;

    await sendEmail({ to, subject, html, text, context: 'operator alert' });
  },
});

/**
 * Everyone who should hear about an operator-facing event: moderators and admins, active only.
 *
 * ⚠ **Active only, and that is a real filter rather than tidiness.** A suspended or banned account
 * keeps its `role` — demotion and suspension are separate levers (D37) — so filtering on role alone
 * would keep mailing someone whose access was deliberately revoked. `deleting` and `deleted` are
 * excluded for the same reason plus D62's obvious one.
 *
 * Returns Clerk subjects, not addresses: the address lookup is an HTTP call and belongs in the
 * action, while this stays a cheap indexed read that a mutation could also use.
 */
export const staffSubjects = internalQuery({
  args: {},
  handler: async (ctx) => {
    const out: { subject: string; displayName: string; role: string }[] = [];
    for (const role of ['moderator', 'admin'] as const) {
      const rows = await ctx.db
        .query('profiles')
        .withIndex('by_role', (q) => q.eq('role', role))
        .collect();
      for (const p of rows) {
        if (p.status !== 'active') continue;
        out.push({ subject: p.clerkUserId, displayName: p.displayName, role });
      }
    }
    return out;
  },
});

/**
 * Send one alert to **every** active moderator and admin, one email each.
 *
 * ## Why a fan-out rather than the single `OPERATOR_ALERT_EMAIL`
 *
 * `send` above mails one configured address, which is right for a founder-only work trigger (a
 * support ticket, a safety flag). Some events are *news for whoever is on duty* rather than a task
 * for one person, and the season boundary is the first of them: it changes what the app is doing —
 * imagery ingest starts or stops, the corpus-wide weather sweep starts or stops — and anyone who
 * moderates has a reason to know.
 *
 * ## One message each, not one message with many recipients
 *
 * Putting the staff list in a single `to` would leak every moderator's address to every other
 * moderator. At operator scale the extra sends cost nothing, and `lib/resend` already takes one
 * address.
 *
 * ⚠ **Best-effort per recipient, never all-or-nothing.** One person's Clerk lookup failing must not
 * stop the rest of the list being told; the loop logs and continues, and the return value reports
 * what actually went out so a caller (or a log reader) can tell "nobody is configured" from "nobody
 * was told".
 */
export const broadcastToStaff = internalAction({
  args: {
    subject: v.string(),
    heading: v.string(),
    lines: v.array(v.string()),
    deepLinkPath: v.string(),
  },
  handler: async (
    ctx,
    { subject, heading, lines, deepLinkPath },
  ): Promise<{ recipients: number; sent: number }> => {
    const staff = await ctx.runQuery(internal.operatorAlerts.staffSubjects, {});
    if (staff.length === 0) {
      console.warn(`Operator broadcast skipped: no active staff — ${subject}`);
      return { recipients: 0, sent: 0 };
    }

    const base = process.env.WEB_APP_URL ?? '';
    const link = `${base}${deepLinkPath}`;
    const bodyLines = lines.map((l) => `<p style="margin:0 0 8px">${escapeHtml(l)}</p>`).join('');
    const html = `<div style="font-family:system-ui,sans-serif;max-width:520px">
      <h2 style="margin:0 0 12px">${escapeHtml(heading)}</h2>
      ${bodyLines}
      <p style="margin:16px 0 0"><a href="${escapeHtml(link)}" style="color:#0b69ff">Open in /admin →</a></p>
    </div>`;
    const text = `${heading}\n\n${lines.join('\n')}\n\nOpen: ${link}`;

    let sent = 0;
    for (const person of staff) {
      const to = await clerkEmailForSubject(person.subject);
      if (!to) {
        console.warn(`Operator broadcast: no address for ${person.role} ${person.displayName}`);
        continue;
      }
      if (await sendEmail({ to, subject, html, text, context: 'operator broadcast' })) sent += 1;
    }
    return { recipients: staff.length, sent };
  },
});
