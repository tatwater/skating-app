/**
 * Operator alerts (D38) — email the founder when something needs eyes: every new `supportTickets` row
 * and every safety-priority flag (`unsafe_false_report`, `category: safety`). Alerts deep-link into the
 * `/admin` queue so the founder's inbox is a real work trigger, not just a notice.
 *
 * Transport is **Resend** (D38/D35 free tier). The send is a Convex **action** (fetch to the Resend
 * REST API — the default runtime supports fetch; no Node bundle needed) scheduled fire-and-forget from
 * the mutations that create the rows. **All Resend env vars ship unset**: the action **no-ops (logs)
 * when `RESEND_API_KEY` (or the from/to address) is absent**, so it never blocks the build — the founder
 * drops real keys + verifies the domain at the end (see the Resend checklist in the phase plan).
 *
 * The HTML is a small hand-built template. D38 names React Email as the authoring tool; that can be
 * swapped in later (a `"use node"` action rendering `@react-email/components`) without changing this
 * mutation-facing contract — kept as plain HTML here to avoid a Node/JSX bundle for a founder-only email.
 */

import { v } from 'convex/values';
import { internalAction } from './_generated/server';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

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
    const key = process.env.RESEND_API_KEY;
    const from = process.env.RESEND_FROM_EMAIL;
    const to = process.env.OPERATOR_ALERT_EMAIL;
    if (!key || !from || !to) {
      console.warn(
        `Operator alert skipped (Resend env not configured): ${subject} — set RESEND_API_KEY / RESEND_FROM_EMAIL / OPERATOR_ALERT_EMAIL to enable.`,
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

    try {
      const res = await fetch(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ from, to, subject, html, text }),
      });
      if (!res.ok) {
        console.warn(`Resend operator alert failed: ${res.status} ${res.statusText}`);
      }
    } catch (err) {
      console.warn('Resend operator alert threw', err);
    }
  },
});
