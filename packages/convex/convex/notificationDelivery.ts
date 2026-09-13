/**
 * The transports (N8 PR 3 / D167, D174): after the flush lands `notifications` rows, this sends each
 * one onward — a push to every registered device, and an email for the types worth one — and stamps
 * the row so a retried batch never sends twice.
 *
 * ## Shape
 *
 * `flushNotificationQueue` schedules `deliverBatch` with the ids it just inserted. The action loads
 * everything it needs in **one** internal query (`loadForDelivery`: the recipient's channel switches,
 * their live push tokens, their email, and the row resolved to a sentence through the same resolver
 * the inbox uses), does the network calls, and stamps each channel as soon as its sends are done —
 * the push stamps land before the email pass begins, so nothing that fails later can un-stamp them.
 * Actions can't read the database directly, and splitting the reads per row would be the N+1 the
 * inbox avoided.
 *
 * ## What decides whether a row goes anywhere
 *
 * The inbox row already exists — that is the product (D167). Beyond it: `channelPrefs.push` and at
 * least one enabled token ⇒ push; `channelPrefs.email` and the type in `NOTIFICATION_EMAIL_ELIGIBLE`
 * and an address on file ⇒ email. A row that qualifies for neither is simply done. The per-type
 * toggle was applied before the row existed (at enqueue and again at flush), so it isn't re-read here.
 *
 * ## Failure posture
 *
 * Never throws past a single row. The transports log and move on (`lib/expoPush`, `lib/resend`
 * both never throw), a dead token is disabled from the ticket or the receipt, and the only thing a
 * crashed batch costs is one delivery attempt — the row is still in the inbox, and the stamps say
 * exactly which channels it reached.
 */

import {
  describeNotification,
  effectiveChannelPrefs,
  NOTIFICATION_EMAIL_ELIGIBLE,
  type NotificationView,
} from '@skating/core';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { internalAction, internalMutation, internalQuery } from './_generated/server';
import { canReceiveNotifications } from './lib/auth';
import { clerkEmailForSubject } from './lib/clerkEmail';
import {
  type ExpoPushMessage,
  getExpoPushReceipts,
  isDeviceNotRegistered,
  sendExpoPush,
} from './lib/expoPush';
import { renderNotificationEmail, webPathForTarget } from './lib/notificationEmail';
import { DIGEST_TIMEZONE } from './lib/notificationQueue';
import { resolveNotifications } from './lib/notificationResolve';
import { loadBlockedAuthorIds } from './lib/reportVisibility';
import { sendEmail } from './lib/resend';

/** Rows per delivery action — the flush chunks its inserts to this so one action stays bounded. */
export const DELIVERY_BATCH = 200;
/** Expo asks for receipts to be checked at least 15 minutes after the send. */
const RECEIPT_DELAY_MS = 15 * 60 * 1000;
/** iOS caps a collapse id at 64 bytes; the coalesce key is longer, so it's hashed down. */
const COLLAPSE_ID_MAX = 64;

/** One row, with everything the transports need to send it. */
interface Deliverable {
  notificationId: Id<'notifications'>;
  userId: Id<'profiles'>;
  clerkUserId: string;
  view: NotificationView;
  /** The recipient's zone, so a server-composed sentence with a time in it reads in their clock. */
  timeZone: string;
  collapseKey: string;
  push: { tokenId: Id<'pushTokens'>; token: string; platform: 'ios' | 'android' }[] | null;
  email: { to: string | null; unsubscribeSecret: string | null } | null;
}

/**
 * Everything `deliverBatch` needs, in one read. A row already stamped for a channel comes back with
 * that channel `null`, which is the idempotency: a batch that ran twice sends nothing twice.
 *
 * Grouped by recipient: a batch is many rows over few people (that's what coalescing is for), so the
 * profile, the block set and the token list are read once per person, and each person's rows go
 * through the resolver in **one** call — its per-call memo is what keeps thirty rows about one lake
 * at one body read, and calling it per row would have thrown that away.
 *
 * Eligibility is re-read here, as it is at the flush: a row is delivered seconds after it is
 * inserted, but "seconds" is long enough to request deletion in, and the Clerk fallback below would
 * otherwise re-cache the address that request just wiped.
 */
export const loadForDelivery = internalQuery({
  args: { notificationIds: v.array(v.id('notifications')) },
  handler: async (ctx, { notificationIds }): Promise<Deliverable[]> => {
    const now = Date.now();
    const byUser = new Map<Id<'profiles'>, Doc<'notifications'>[]>();
    for (const id of notificationIds) {
      const row = await ctx.db.get(id);
      if (!row) continue;
      const rows = byUser.get(row.userId);
      if (rows) rows.push(row);
      else byUser.set(row.userId, [row]);
    }

    const out: Deliverable[] = [];
    for (const [userId, rows] of byUser) {
      const profile = await ctx.db.get(userId);
      if (!profile || !canReceiveNotifications(profile)) continue;
      const channels = effectiveChannelPrefs(profile.channelPrefs);
      const blocked = await loadBlockedAuthorIds(ctx, userId);
      // The resolver drops a row whose actors are all blocked — nothing to say, nothing to send.
      const views = await resolveNotifications(ctx, rows, blocked, now);
      const viewById = new Map(views.map((view) => [view.id, view] as const));

      let tokens: NonNullable<Deliverable['push']> | null = null;
      if (channels.push) {
        const live = await ctx.db
          .query('pushTokens')
          .withIndex('by_user', (q) => q.eq('userId', userId))
          .collect();
        tokens = live
          .filter((t) => t.disabledAt === undefined)
          .map((t) => ({ tokenId: t._id, token: t.token, platform: t.platform }));
      }

      for (const row of rows) {
        const view = viewById.get(row._id);
        if (!view) continue;
        const push = tokens && row.pushedAt === undefined ? tokens : null;
        const email =
          channels.email && row.emailedAt === undefined && NOTIFICATION_EMAIL_ELIGIBLE.has(row.type)
            ? {
                to: profile.email ?? null,
                unsubscribeSecret: profile.emailUnsubscribeSecret ?? null,
              }
            : null;
        const payload = row.payload as { coalesceKey?: string } | null;
        out.push({
          notificationId: row._id,
          userId,
          clerkUserId: profile.clerkUserId,
          view,
          timeZone: profile.timezone ?? DIGEST_TIMEZONE,
          collapseKey: payload?.coalesceKey ?? `${userId}:${row.type}`,
          push,
          email,
        });
      }
    }
    return out;
  },
});

/** Stamp what went out. */
export const markDelivered = internalMutation({
  args: {
    pushed: v.array(v.id('notifications')),
    emailed: v.array(v.id('notifications')),
    now: v.number(),
  },
  handler: async (ctx, { pushed, emailed, now }) => {
    for (const id of pushed) {
      const row = await ctx.db.get(id);
      if (row && row.pushedAt === undefined) await ctx.db.patch(id, { pushedAt: now });
    }
    for (const id of emailed) {
      const row = await ctx.db.get(id);
      if (row && row.emailedAt === undefined) await ctx.db.patch(id, { emailedAt: now });
    }
  },
});

/** A dead address: Expo said `DeviceNotRegistered` in a ticket or a receipt. */
export const disableTokens = internalMutation({
  args: { tokenIds: v.array(v.id('pushTokens')) },
  handler: async (ctx, { tokenIds }) => {
    const now = Date.now();
    for (const id of tokenIds) {
      const token = await ctx.db.get(id);
      if (token && token.disabledAt === undefined) await ctx.db.patch(id, { disabledAt: now });
    }
  },
});

/**
 * Mint the unsubscribe secret the first time a person is emailed; idempotent afterwards. Random from
 * the runtime's CSPRNG — the link it goes into is the one thing that can change a setting without
 * a sign-in, so it must not be guessable from anything public.
 */
export const ensureUnsubscribeSecret = internalMutation({
  args: { userId: v.id('profiles') },
  handler: async (ctx, { userId }): Promise<string | null> => {
    const profile = await ctx.db.get(userId);
    if (!profile) return null;
    if (profile.emailUnsubscribeSecret) return profile.emailUnsubscribeSecret;
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    const secret = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    await ctx.db.patch(userId, { emailUnsubscribeSecret: secret });
    return secret;
  },
});

/** Cache an address looked up from Clerk, so the next send doesn't pay the call again. */
export const cacheEmail = internalMutation({
  args: { userId: v.id('profiles'), email: v.string() },
  handler: async (ctx, { userId, email }) => {
    const profile = await ctx.db.get(userId);
    if (profile && profile.email === undefined) await ctx.db.patch(userId, { email });
  },
});

/** The web link base for emails and push payloads — unset on a fresh dev, in which case no links. */
function webAppUrl(): string {
  return (process.env.WEB_APP_URL ?? '').replace(/\/$/, '');
}

/** The one-click unsubscribe link: the Convex `.site` host, the user, the secret. */
function unsubscribeUrl(userId: Id<'profiles'>, secret: string): string {
  const site = (process.env.CONVEX_SITE_URL ?? '').replace(/\/$/, '');
  return `${site}/unsubscribe?u=${encodeURIComponent(userId)}&t=${encodeURIComponent(secret)}`;
}

/** A stable ≤64-byte collapse id from the coalesce key (FNV-1a, hex). */
function collapseId(key: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const prefix = key.replace(/[^A-Za-z0-9:_-]/g, '').slice(0, COLLAPSE_ID_MAX - 9);
  return `${prefix}:${h.toString(16)}`.slice(0, COLLAPSE_ID_MAX);
}

/**
 * Send a batch of freshly-inserted notifications over every channel they qualify for. Scheduled by
 * the flush; safe to run twice.
 */
export const deliverBatch = internalAction({
  args: { notificationIds: v.array(v.id('notifications')) },
  handler: async (ctx, { notificationIds }) => {
    const rows: Deliverable[] = await ctx.runQuery(internal.notificationDelivery.loadForDelivery, {
      notificationIds,
    });
    const now = Date.now();
    const base = webAppUrl();

    // ── Push ─────────────────────────────────────────────────────────────────────────────────────
    const messages: ExpoPushMessage[] = [];
    const messageOwners: { notificationId: Id<'notifications'>; tokenId: Id<'pushTokens'> }[] = [];
    for (const row of rows) {
      if (!row.push || row.push.length === 0) continue;
      try {
        const { title, detail, target } = describeNotification(row.view, {
          timeZone: row.timeZone,
        });
        for (const device of row.push) {
          messages.push({
            to: device.token,
            title,
            ...(detail ? { body: detail } : {}),
            data: {
              notificationId: row.notificationId,
              target,
              ...(base
                ? { url: `${base}${webPathForTarget(target, row.view) ?? '/notifications'}` }
                : {}),
            },
            collapseId: collapseId(row.collapseKey),
            channelId: 'default',
            sound: 'default',
          });
          messageOwners.push({ notificationId: row.notificationId, tokenId: device.tokenId });
        }
      } catch (err) {
        // One row's sentence failing to compose (an `Intl` zone this runtime rejects, say) costs that
        // row's push, not the batch's.
        console.warn(`notificationDelivery: could not compose ${row.notificationId}`, err);
      }
    }
    const pushed = new Set<Id<'notifications'>>();
    const deadTokens = new Set<Id<'pushTokens'>>();
    const receiptsToCheck: { id: string; tokenId: Id<'pushTokens'> }[] = [];
    if (messages.length > 0) {
      const tickets = await sendExpoPush(messages);
      tickets.forEach((ticket, i) => {
        const owner = messageOwners[i];
        if (!owner) return;
        if (ticket.status === 'ok') {
          pushed.add(owner.notificationId);
          receiptsToCheck.push({ id: ticket.id, tokenId: owner.tokenId });
        } else if (isDeviceNotRegistered(ticket)) {
          deadTokens.add(owner.tokenId);
        } else {
          // Anything else here is ours to fix, not the device's — `InvalidCredentials` is what a
          // missing FCM key looks like, and a batch that silently pushed nothing would hide it.
          console.warn(`Expo push ticket error: ${ticket.message}`);
        }
      });
    }
    // The push stamps go down before the email pass starts: the sends above have happened, and a
    // throw anywhere below must not leave them unstamped for a re-run to send twice.
    if (pushed.size > 0) {
      await ctx.runMutation(internal.notificationDelivery.markDelivered, {
        pushed: [...pushed],
        emailed: [],
        now,
      });
    }
    if (deadTokens.size > 0) {
      await ctx.runMutation(internal.notificationDelivery.disableTokens, {
        tokenIds: [...deadTokens],
      });
    }
    if (receiptsToCheck.length > 0) {
      await ctx.scheduler.runAfter(
        RECEIPT_DELAY_MS,
        internal.notificationDelivery.checkPushReceipts,
        {
          tickets: receiptsToCheck,
        },
      );
    }

    // ── Email ────────────────────────────────────────────────────────────────────────────────────
    const emailed: Id<'notifications'>[] = [];
    const addressCache = new Map<Id<'profiles'>, string | null>();
    const secretCache = new Map<Id<'profiles'>, string | null>();
    for (const row of rows) {
      if (!row.email) continue;
      try {
        let to = row.email.to ?? addressCache.get(row.userId) ?? null;
        if (to === null && !addressCache.has(row.userId)) {
          // No mirror yet (the JWT template didn't carry an email, or the row predates the field):
          // one Clerk lookup, cached onto the profile for every send after this one.
          to = await clerkEmailForSubject(row.clerkUserId);
          addressCache.set(row.userId, to);
          if (to) {
            await ctx.runMutation(internal.notificationDelivery.cacheEmail, {
              userId: row.userId,
              email: to,
            });
          }
        }
        if (!to) continue;
        let secret = row.email.unsubscribeSecret ?? secretCache.get(row.userId) ?? null;
        if (secret === null) {
          secret = await ctx.runMutation(internal.notificationDelivery.ensureUnsubscribeSecret, {
            userId: row.userId,
          });
          secretCache.set(row.userId, secret);
        }
        if (!secret) continue;
        const unsubscribe = unsubscribeUrl(row.userId, secret);
        const mail = renderNotificationEmail(row.view, {
          webAppUrl: base,
          unsubscribeUrl: unsubscribe,
          timeZone: row.timeZone,
        });
        const sent = await sendEmail({
          to,
          subject: mail.subject,
          html: mail.html,
          text: mail.text,
          context: `notification ${row.view.type}`,
          headers: {
            'List-Unsubscribe': `<${unsubscribe}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          },
        });
        if (sent) emailed.push(row.notificationId);
      } catch (err) {
        console.warn(`notificationDelivery: email for ${row.notificationId} failed`, err);
      }
    }
    if (emailed.length > 0) {
      await ctx.runMutation(internal.notificationDelivery.markDelivered, {
        pushed: [],
        emailed,
        now,
      });
    }
    return {
      rows: rows.length,
      pushMessages: messages.length,
      pushed: pushed.size,
      emailed: emailed.length,
      deadTokens: deadTokens.size,
    };
  },
});

/**
 * The receipt pass, 15 minutes after a send: the only place APNs/FCM-level failures surface. A
 * `DeviceNotRegistered` receipt disables the token; everything else is logged and forgotten — a
 * transient failure on a one-off notification isn't worth a retry queue.
 */
export const checkPushReceipts = internalAction({
  args: { tickets: v.array(v.object({ id: v.string(), tokenId: v.id('pushTokens') })) },
  handler: async (ctx, { tickets }) => {
    const receipts = await getExpoPushReceipts(tickets.map((t) => t.id));
    const dead = new Set<Id<'pushTokens'>>();
    let errors = 0;
    for (const ticket of tickets) {
      const receipt = receipts[ticket.id];
      if (!receipt || receipt.status === 'ok') continue;
      errors++;
      if (isDeviceNotRegistered(receipt)) dead.add(ticket.tokenId);
      else console.warn(`Expo push receipt error: ${receipt.message}`);
    }
    if (dead.size > 0) {
      await ctx.runMutation(internal.notificationDelivery.disableTokens, { tokenIds: [...dead] });
    }
    return { checked: tickets.length, errors, deadTokens: dead.size };
  },
});
