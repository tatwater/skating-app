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
import { internalAction } from './_generated/server';
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
