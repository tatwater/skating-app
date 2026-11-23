/**
 * **Answering a support ticket** (B01-5f, D284): a staff note, an email reply and its settle, a
 * resolve and a reopen — each through the Inbox's one rule, each audited with the verb's default
 * reason and never the text, each undone through the engine and round-tripped; the send's every
 * branch with Resend stubbed (never a real key); the thread as `inbox.item` serves it, bounded on a
 * busy ticket; and every read that could carry a note, a reply or a ticket's words, denied to a
 * moderator.
 */

import { MAX_SUPPORT_NOTE_LENGTH, MAX_SUPPORT_REPLY_LENGTH } from '@skating/core';
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { SETTLE_MS } from './lib/notificationQueue';
import {
  CANCELED_REPLY_REFUSAL,
  eraseTicketsOf,
  NOT_A_NOTE_REFUSAL,
  NOTE_NOT_REMOVED_REFUSAL,
  NOTE_REMOVED_REFUSAL,
  REPLY_SKIPPED_LOG,
  SENT_REPLY_REFUSAL,
  SUPPORT_REASONS,
  SUPPORT_REPLY_FOOTER,
  THREAD_MESSAGES,
  UNSENT_REPLY_REFUSAL,
} from './lib/supportThread';
import { undoState } from './lib/undo';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;
type As = ReturnType<T['withIdentity']>;

const PREFS = {
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
  moderatorDecision: false,
};

/** Placeholders only: no real key, no real address (the brief's rule). */
const FAKE_KEY = 're_test_placeholder';
const FROM = 'Gli Support <support@example.test>';
/** A character three bytes long: text at a length cap as heavy as it can be. */
const HEAVY = '\u6c34';

type P = { id: Id<'profiles'>; as: As; subject: string };

async function world() {
  const t = harness();
  const person = async (
    subject: string,
    role: 'member' | 'moderator' | 'admin',
    extra: Partial<Doc<'profiles'>> = {},
  ): Promise<P> => {
    const id = await t.run((ctx) =>
      ctx.db.insert('profiles', {
        clerkUserId: subject,
        displayName: `${subject} Test-Person`,
        username: subject,
        driveTimePrefMinutes: 60,
        profileVisibility: 'public' as const,
        notificationPrefs: PREFS,
        dateOfBirth: Date.UTC(1990, 0, 1),
        reputationPoints: 0,
        role,
        status: 'active' as const,
        createdAt: Date.now(),
        ...extra,
      }),
    );
    return { id, as: t.withIdentity({ subject }), subject };
  };
  const admin = await person('admin', 'admin');
  const colleague = await person('colleague', 'admin');
  const mod = await person('mod', 'moderator');
  const skater = await person('skater', 'member', { email: 'skater@example.test' });
  const ticket = (by: P = skater, body = 'The map is blank') =>
    by.as.mutation(api.support.create, { category: 'bug', body });
  const message = (id: Id<'supportMessages'>) => t.run((ctx) => ctx.db.get(id));
  const tk = (id: Id<'supportTickets'>) => t.run((ctx) => ctx.db.get(id));
  const itemOf = (id: Id<'supportTickets'>) =>
    t.run(async (ctx) => {
      const m = await ctx.db
        .query('inboxItemMembers')
        .withIndex('by_source', (q) => q.eq('sourceTable', 'supportTickets').eq('sourceId', id))
        .first();
      return m ? ctx.db.get(m.itemId) : null;
    });
  const rowsOn = (id: Id<'supportTickets'>) =>
    t.run((ctx) =>
      ctx.db
        .query('moderationActions')
        .withIndex('by_target', (q) => q.eq('targetType', 'supportTicket').eq('targetId', id))
        .collect(),
    );
  const offer = (who: P, actionId: Id<'moderationActions'>) =>
    t.run(async (ctx) =>
      undoState(
        ctx,
        (await ctx.db.get(who.id)) as Doc<'profiles'>,
        (await ctx.db.get(actionId)) as Doc<'moderationActions'>,
        'one',
      ),
    );
  return { t, person, admin, colleague, mod, skater, ticket, message, tk, itemOf, rowsOn, offer };
}
type W = Awaited<ReturnType<typeof world>>;

/** A fetch stub: Resend answers `resend`, Clerk answers with `clerkEmail`; every call recorded. */
function stubMail(opts: { resend?: number; clerkEmail?: string | null } = {}) {
  const calls: { url: string; body: unknown }[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.includes('api.clerk.com')) {
      const email = opts.clerkEmail ?? null;
      return new Response(
        JSON.stringify(
          email
            ? {
                primary_email_address_id: 'e1',
                email_addresses: [{ id: 'e1', email_address: email }],
              }
            : { email_addresses: [] },
        ),
        { status: 200 },
      );
    }
    if (url.includes('api.resend.com')) {
      return new Response(JSON.stringify({ id: 'sent' }), { status: opts.resend ?? 200 });
    }
    return new Response(JSON.stringify({ hourly: { time: [] } }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  const sent = () => calls.filter((c) => c.url.includes('api.resend.com'));
  return { calls, sent };
}

/** Run every scheduled send due by now, the fake clock moved to just past the window. */
async function settle(w: W, ms = SETTLE_MS + 1) {
  vi.advanceTimersByTime(ms);
  await w.t.finishAllScheduledFunctions(vi.runAllTimers);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(new Date('2026-12-01T12:00:00Z'));
  vi.stubEnv('RESEND_API_KEY', FAKE_KEY);
  vi.stubEnv('RESEND_FROM_EMAIL', 'Gli Updates <updates@example.test>');
  vi.stubEnv('SUPPORT_FROM_EMAIL', FROM);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// ── Notes ────────────────────────────────────────────────────────────────────────────────────────

describe('support.addNote', () => {
  test('writes the note and a default-reason row naming only its id; answers its item, row and undo', async () => {
    const w = await world();
    const ticketId = await w.ticket();
    const out = await w.admin.as.mutation(api.support.addNote, {
      ticketId,
      body: '  Reproduced on a Pixel.  ',
    });
    const note = await w.message(out.messageId);
    expect(note).toMatchObject({
      kind: 'note',
      body: 'Reproduced on a Pixel.',
      authorId: w.admin.id,
      // The write stamps its own audit row on the message (the cancel and History read it by id).
      actionId: out.actionId,
    });
    expect(note?.status).toBeUndefined();
    const row = (await w.rowsOn(ticketId)).find((r) => r._id === out.actionId);
    expect(row).toMatchObject({
      action: 'support_note',
      reason: SUPPORT_REASONS.support_note,
      metadata: { messageId: out.messageId, kind: 'note' },
    });
    expect(JSON.stringify(row)).not.toContain('Pixel');
    expect(out).toMatchObject({
      itemId: (await w.itemOf(ticketId))?._id,
      ticketId,
      undoable: true,
      undoNeedsReason: false,
    });
  });

  test('the cap: 2,000 characters land, 2,001 are refused, and empty is refused — after the rule', async () => {
    const w = await world();
    const ticketId = await w.ticket();
    await w.admin.as.mutation(api.support.addNote, {
      ticketId,
      body: 'x'.repeat(MAX_SUPPORT_NOTE_LENGTH),
    });
    await expect(
      w.admin.as.mutation(api.support.addNote, {
        ticketId,
        body: 'x'.repeat(MAX_SUPPORT_NOTE_LENGTH + 1),
      }),
    ).rejects.toThrow('A note holds at most 2,000 characters.');
    await expect(
      w.admin.as.mutation(api.support.addNote, { ticketId, body: '  ' }),
    ).rejects.toThrow('Write the note first.');
    // Who decides comes before the input: a moderator hears the capability, not the cap.
    await expect(
      w.mod.as.mutation(api.support.addNote, {
        ticketId,
        body: 'x'.repeat(MAX_SUPPORT_NOTE_LENGTH + 1),
      }),
    ).rejects.toThrow('Requires admin role');
  });

  test('the rule: a moderator, a decided ticket and the staffer’s own ticket are refused', async () => {
    const w = await world();
    const ticketId = await w.ticket();
    await expect(w.mod.as.mutation(api.support.addNote, { ticketId, body: 'n' })).rejects.toThrow(
      'Requires admin role',
    );
    const own = await w.ticket(w.admin);
    await expect(
      w.admin.as.mutation(api.support.addNote, { ticketId: own, body: 'n' }),
    ).rejects.toThrow('You filed this, so another staff member decides it.');
    await w.colleague.as.mutation(api.support.resolve, { ticketId });
    await expect(w.admin.as.mutation(api.support.addNote, { ticketId, body: 'n' })).rejects.toThrow(
      'This has already been decided.',
    );
  });

  test('its undo removes it; the removal’s undo puts it back; each undo of the undo round-trips', async () => {
    const w = await world();
    const ticketId = await w.ticket();
    const out = await w.admin.as.mutation(api.support.addNote, { ticketId, body: 'Checked' });
    await w.admin.as.mutation(api.undo.run, { actionId: out.actionId });
    expect((await w.message(out.messageId))?.removedAt).toBeTypeOf('number');
    const removal = (await w.rowsOn(ticketId)).find((r) => r.action === 'remove_support_note');
    expect(removal).toMatchObject({
      undoesActionId: out.actionId,
      reason: SUPPORT_REASONS.remove_support_note,
    });
    // The colleague undoes the removal (History: anyone holding the capability).
    await w.colleague.as.mutation(api.undo.run, {
      actionId: removal?._id as Id<'moderationActions'>,
    });
    expect((await w.message(out.messageId))?.removedAt).toBeUndefined();
    const back = (await w.rowsOn(ticketId)).find(
      (r) => r.action === 'support_note' && r.undoesActionId === removal?._id,
    );
    expect(back?.metadata).toMatchObject({ messageId: out.messageId, restored: true });
    // And removed again by that row's undo.
    await w.admin.as.mutation(api.undo.run, { actionId: back?._id as Id<'moderationActions'> });
    expect((await w.message(out.messageId))?.removedAt).toBeTypeOf('number');
  });

  test('support.removeNote: a forward removal, its undo puts the note back; a reply and the filer are refused', async () => {
    const w = await world();
    const ticketId = await w.ticket();
    const note = await w.admin.as.mutation(api.support.addNote, { ticketId, body: 'Checked' });
    const out = await w.colleague.as.mutation(api.support.removeNote, {
      messageId: note.messageId,
    });
    expect(out).toMatchObject({ ticketId, messageId: note.messageId, undoable: true });
    expect((await w.message(note.messageId))?.removedAt).toBeTypeOf('number');
    await expect(
      w.admin.as.mutation(api.support.removeNote, { messageId: note.messageId }),
    ).rejects.toThrow(NOTE_REMOVED_REFUSAL);
    await w.colleague.as.mutation(api.undo.run, { actionId: out.actionId });
    expect((await w.message(note.messageId))?.removedAt).toBeUndefined();
    stubMail();
    const reply = await w.admin.as.mutation(api.support.reply, { ticketId, body: 'Hi' });
    await expect(
      w.admin.as.mutation(api.support.removeNote, { messageId: reply.messageId }),
    ).rejects.toThrow(NOT_A_NOTE_REFUSAL);
    await expect(
      w.mod.as.mutation(api.support.removeNote, { messageId: note.messageId }),
    ).rejects.toThrow('Requires admin role');
    const own = await w.ticket(w.admin);
    const onOwn = await w.colleague.as.mutation(api.support.addNote, { ticketId: own, body: 'n' });
    await expect(
      w.admin.as.mutation(api.support.removeNote, { messageId: onOwn.messageId }),
    ).rejects.toThrow('You filed this, so another staff member decides it.');
  });

  test('a removed note’s own undo is refused in words, offer and run alike', async () => {
    const w = await world();
    const ticketId = await w.ticket();
    const out = await w.admin.as.mutation(api.support.addNote, { ticketId, body: 'Checked' });
    await w.t.run((ctx) => ctx.db.patch(out.messageId, { removedAt: Date.now() }));
    expect(await w.offer(w.admin, out.actionId)).toEqual({
      state: 'unavailable',
      why: NOTE_REMOVED_REFUSAL,
    });
    await expect(w.admin.as.mutation(api.undo.run, { actionId: out.actionId })).rejects.toThrow(
      NOTE_REMOVED_REFUSAL,
    );
    expect(NOTE_NOT_REMOVED_REFUSAL).not.toBe(NOTE_REMOVED_REFUSAL);
  });
});

// ── Replies and their settle ───────────────────────────────────────────────────────────────────

describe('support.reply and its send', () => {
  test('stored settling, one window on; sent after it from the support sender, with the footer, to the profile’s address', async () => {
    const w = await world();
    const mail = stubMail();
    const ticketId = await w.ticket();
    const out = await w.admin.as.mutation(api.support.reply, {
      ticketId,
      body: 'Fixed in 2.1 — thanks.',
    });
    expect(out).toMatchObject({
      status: 'settling',
      failedWhy: null,

      undoable: true,
    });
    // One window on (the harness's clock steps a millisecond a transaction).
    expect(out.sendAfter - Date.now()).toBeGreaterThan(SETTLE_MS - 10);
    expect(out.sendAfter - Date.now()).toBeLessThanOrEqual(SETTLE_MS + 10);
    expect((await w.message(out.messageId))?.status).toBe('settling');
    // Its send is scheduled once (so the seed's "none scheduled" below reads a real name).
    const jobs = await w.t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
    expect(jobs.filter((j) => /^support(\.js)?:sendReply$/.test(j.name))).toHaveLength(1);
    await settle(w);
    const sent = mail.sent();
    expect(sent).toHaveLength(1);
    const body = sent[0]?.body as {
      from: string;
      to: string;
      text: string;
      html: string;
      subject: string;
    };
    expect(body.from).toBe(FROM);
    expect(body.to).toBe('skater@example.test');
    expect(body.text).toContain('Fixed in 2.1 — thanks.');
    expect(body.text).toContain(SUPPORT_REPLY_FOOTER);
    expect(body.html).toContain('Settings → Help');
    const after = await w.message(out.messageId);
    expect(after).toMatchObject({ status: 'sent' });
    expect(after?.sentAt).toBeTypeOf('number');
    expect(JSON.stringify(after)).not.toContain('example.test'); // never the address
    // After it went: no undo, in the policy's words, offer and run alike.
    expect(await w.offer(w.admin, out.actionId)).toEqual({
      state: 'unavailable',
      why: SENT_REPLY_REFUSAL,
    });
    await expect(w.admin.as.mutation(api.undo.run, { actionId: out.actionId })).rejects.toThrow(
      SENT_REPLY_REFUSAL,
    );
    await expect(
      w.admin.as.mutation(api.support.cancelReply, { messageId: out.messageId }),
    ).rejects.toThrow(SENT_REPLY_REFUSAL);
  });

  test('canceled inside the window: nothing reaches Resend, the row reads canceled, the cancel has no undo', async () => {
    const w = await world();
    const mail = stubMail();
    const ticketId = await w.ticket();
    const out = await w.admin.as.mutation(api.support.reply, { ticketId, body: 'Wrong ticket' });
    vi.advanceTimersByTime(SETTLE_MS / 2);
    const cancel = await w.admin.as.mutation(api.support.cancelReply, { messageId: out.messageId });
    expect((await w.message(out.messageId))?.actionId).toBe(out.actionId);
    expect(cancel).toMatchObject({ ticketId, messageId: out.messageId, undoable: false });
    const row = (await w.rowsOn(ticketId)).find((r) => r._id === cancel.actionId);
    expect(row).toMatchObject({ action: 'cancel_support_reply', undoesActionId: out.actionId });
    await settle(w, SETTLE_MS);
    expect(mail.sent()).toEqual([]);
    expect((await w.message(out.messageId))?.status).toBe('canceled');
    expect(await w.offer(w.admin, cancel.actionId)).toEqual({
      state: 'unavailable',
      why: 'A canceled reply isn’t sent again; write a new one.',
    });
    // Its row is undone: the reply's cancel is refused again by the engine.
    await expect(
      w.admin.as.mutation(api.support.cancelReply, { messageId: out.messageId }),
    ).rejects.toThrow('That action has already been undone');
  });

  test('a reply with no audit row of its own is refused in words, never canceled blind', async () => {
    const w = await world();
    const ticketId = await w.ticket();
    const messageId = await w.t.run((ctx) =>
      ctx.db.insert('supportMessages', {
        ticketId,
        kind: 'reply',
        authorId: w.admin.id,
        body: 'No row',
        createdAt: Date.now(),
        status: 'settling',
        sendAfter: Date.now() + SETTLE_MS,
      }),
    );
    await expect(w.admin.as.mutation(api.support.cancelReply, { messageId })).rejects.toThrow(
      'This reply’s record is missing, so it can’t be canceled.',
    );
    expect((await w.message(messageId))?.status).toBe('settling');
  });

  test('the row is re-read at send: one canceled under the scheduler (by any path) sends nothing', async () => {
    const w = await world();
    const mail = stubMail();
    const ticketId = await w.ticket();
    const out = await w.admin.as.mutation(api.support.reply, { ticketId, body: 'Hello' });
    await w.t.run((ctx) => ctx.db.patch(out.messageId, { status: 'canceled' }));
    await settle(w);
    expect(mail.sent()).toEqual([]);
    expect((await w.message(out.messageId))?.status).toBe('canceled');
  });

  test('the claim closes the window: once the send has claimed the reply, its cancel is refused', async () => {
    const w = await world();
    stubMail();
    const ticketId = await w.ticket();
    const out = await w.admin.as.mutation(api.support.reply, { ticketId, body: 'Hello' });
    const claim = await w.t.mutation(internal.support.claimReply, { messageId: out.messageId });
    expect(claim).toMatchObject({ email: 'skater@example.test', seed: false });
    expect((await w.message(out.messageId))?.status).toBe('settling');
    await expect(
      w.admin.as.mutation(api.support.cancelReply, { messageId: out.messageId }),
    ).rejects.toThrow(SENT_REPLY_REFUSAL);
    // A second claim takes nothing: one send per reply.
    expect(
      await w.t.mutation(internal.support.claimReply, { messageId: out.messageId }),
    ).toBeNull();
  });

  test('past its window, a reply the scheduler hasn’t reached yet can’t be canceled', async () => {
    const w = await world();
    stubMail();
    const ticketId = await w.ticket();
    const out = await w.admin.as.mutation(api.support.reply, { ticketId, body: 'Hello' });
    vi.setSystemTime(Date.now() + SETTLE_MS + 10);
    await expect(
      w.admin.as.mutation(api.support.cancelReply, { messageId: out.messageId }),
    ).rejects.toThrow(SENT_REPLY_REFUSAL);
  });

  test.each([
    { from: '', key: FAKE_KEY, seed: false, want: 'unconfigured' },
    { from: FROM, key: '', seed: false, want: 'unconfigured' },
    { from: '', key: '', seed: false, want: 'unconfigured' },
    { from: FROM, key: FAKE_KEY, seed: false, want: null },
    { from: FROM, key: FAKE_KEY, seed: true, want: 'seed' },
    { from: '', key: '', seed: true, want: 'seed' },
  ])(
    'sender $from|key $key|seed $seed: the read, the write and the send all answer $want',
    async ({ from, key, seed, want }) => {
      const w = await world();
      const mail = stubMail();
      vi.stubEnv('SUPPORT_FROM_EMAIL', from);
      vi.stubEnv('RESEND_API_KEY', key);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const by = seed ? await w.person('seed_inbox_cleo', 'member') : w.skater;
      const ticketId = await w.ticket(by);
      const read = await w.admin.as.query(api.inbox.item, { ref: `ticket:${ticketId}` });
      if (read.item?.kind !== 'ticket') throw new Error('not a ticket');
      expect(read.item.replyBlocked).toBe(want);
      const out = await w.admin.as.mutation(api.support.reply, { ticketId, body: 'Hello' });
      const jobs = await w.t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
      const sends = jobs.filter((j) => /^support(\.js)?:sendReply$/.test(j.name));
      if (want === null) {
        // It would go: settling, one send scheduled — and it goes.
        expect(out).toMatchObject({ status: 'settling', failedWhy: null, undoable: true });
        expect(sends).toHaveLength(1);
        await settle(w);
        expect(mail.sent()).toHaveLength(1);
      } else {
        // It can't go: failed from the start, nothing scheduled, no countdown, no undo to offer.
        expect(out).toMatchObject({ status: 'failed', failedWhy: want, undoable: false });
        expect(await w.message(out.messageId)).toMatchObject({ status: 'failed', failedWhy: want });
        expect(sends).toEqual([]);
        await settle(w);
        expect(mail.calls).toEqual([]);
        expect(await w.offer(w.admin, out.actionId)).toEqual({
          state: 'unavailable',
          why: UNSENT_REPLY_REFUSAL,
        });
      }
      if (want === 'unconfigured') {
        expect(warn.mock.calls.flat().join(' ')).toContain(REPLY_SKIPPED_LOG);
      }
      warn.mockRestore();
    },
  );

  test('a sender removed between the write and the send: the send marks it unconfigured, never sends from the general address', async () => {
    const w = await world();
    const mail = stubMail();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ticketId = await w.ticket();
    const out = await w.admin.as.mutation(api.support.reply, { ticketId, body: 'Hello' });
    expect(out.status).toBe('settling');
    vi.stubEnv('RESEND_API_KEY', '');
    await settle(w);
    expect(mail.calls).toEqual([]);
    expect(await w.message(out.messageId)).toMatchObject({
      status: 'failed',
      failedWhy: 'unconfigured',
    });
    expect((await w.message(out.messageId))?.sentAt).toBeUndefined();
    warn.mockRestore();
  });

  test('a ticket filed before provisioning is answered through its Clerk subject', async () => {
    const w = await world();
    const mail = stubMail({ clerkEmail: 'early@example.test' });
    vi.stubEnv('CLERK_SECRET_KEY', 'sk_test_placeholder');
    const early = w.t.withIdentity({ subject: 'user_early' });
    const ticketId = await early.mutation(api.support.create, {
      category: 'account',
      body: 'Can’t sign in',
    });
    expect((await w.tk(ticketId))?.userId).toBeUndefined();
    const out = await w.admin.as.mutation(api.support.reply, {
      ticketId,
      body: 'Try the email code',
    });
    await settle(w);
    expect(mail.calls.some((c) => c.url.endsWith('/users/user_early'))).toBe(true);
    expect((mail.sent()[0]?.body as { to: string } | undefined)?.to).toBe('early@example.test');
    expect((await w.message(out.messageId))?.status).toBe('sent');
  });

  test('no address anywhere: failed (noAddress); the provider refusing: failed (sendFailed)', async () => {
    const w = await world();
    stubMail({ clerkEmail: null });
    vi.stubEnv('CLERK_SECRET_KEY', 'sk_test_placeholder');
    const bare = await w.person('bare', 'member');
    const t1 = await w.ticket(bare);
    const r1 = await w.admin.as.mutation(api.support.reply, { ticketId: t1, body: 'Hi' });
    await settle(w);
    expect(await w.message(r1.messageId)).toMatchObject({
      status: 'failed',
      failedWhy: 'noAddress',
    });

    const mail = stubMail({ resend: 500 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t2 = await w.ticket();
    const r2 = await w.admin.as.mutation(api.support.reply, { ticketId: t2, body: 'Hi' });
    await settle(w);
    expect(mail.sent()).toHaveLength(1);
    expect(await w.message(r2.messageId)).toMatchObject({
      status: 'failed',
      failedWhy: 'sendFailed',
    });
    warn.mockRestore();
  });

  test('a suspended person’s appeal is answered: the reply sends', async () => {
    const w = await world();
    const mail = stubMail();
    const finn = await w.person('finn', 'member', { email: 'finn@example.test' });
    const ticketId = await finn.as.mutation(api.support.create, {
      category: 'account',
      body: 'Appeal',
    });
    await w.t.run((ctx) =>
      ctx.db.patch(finn.id, { status: 'suspended', suspendedUntil: Date.now() + 86_400_000 }),
    );
    await w.admin.as.mutation(api.support.reply, { ticketId, body: 'It lifts on Friday.' });
    await settle(w);
    expect((mail.sent()[0]?.body as { to: string } | undefined)?.to).toBe('finn@example.test');
  });

  test('the reply’s cap is 5,000 characters', async () => {
    const w = await world();
    stubMail();
    const ticketId = await w.ticket();
    await w.admin.as.mutation(api.support.reply, {
      ticketId,
      body: 'y'.repeat(MAX_SUPPORT_REPLY_LENGTH),
    });
    await expect(
      w.admin.as.mutation(api.support.reply, {
        ticketId,
        body: 'y'.repeat(MAX_SUPPORT_REPLY_LENGTH + 1),
      }),
    ).rejects.toThrow('A reply holds at most 5,000 characters.');
  });

  test('a colleague’s note after a reply doesn’t take away its cancel; a resolve doesn’t either', async () => {
    const w = await world();
    const mail = stubMail();
    const ticketId = await w.ticket();
    const out = await w.admin.as.mutation(api.support.reply, { ticketId, body: 'Hello' });
    await w.colleague.as.mutation(api.support.addNote, { ticketId, body: 'Seen' });
    await w.colleague.as.mutation(api.support.resolve, { ticketId });
    expect((await w.offer(w.admin, out.actionId)).state).toBe('available');
    await w.admin.as.mutation(api.undo.run, { actionId: out.actionId });
    await settle(w);
    expect(mail.sent()).toEqual([]);
    expect((await w.message(out.messageId))?.status).toBe('canceled');
  });
});

// ── The seed never mails ────────────────────────────────────────────────────────────────────────

describe('what the dock and the head are told', () => {
  test('replyFrom is the support sender or null; replyBlocked says a reply won’t go; the person’s tickets are counted', async () => {
    const w = await world();
    const ticketId = await w.ticket();
    const second = await w.ticket(w.skater, 'Another');
    await w.admin.as.mutation(api.support.resolve, { ticketId: second });
    const read = async (ref: string) => {
      const out = await w.admin.as.query(api.inbox.item, { ref });
      if (out.item?.kind !== 'ticket') throw new Error('not a ticket');
      return out.item;
    };
    expect(await read(`ticket:${ticketId}`)).toMatchObject({
      replyFrom: FROM,
      replyBlocked: null,
      personTickets: { total: 2, resolved: 1, capped: false },
    });
    vi.stubEnv('SUPPORT_FROM_EMAIL', '');
    expect(await read(`ticket:${ticketId}`)).toMatchObject({
      replyFrom: null,
      replyBlocked: 'unconfigured',
    });
    const fake = await w.person('seed_inbox_ben', 'member');
    const seeded = await w.ticket(fake);
    expect((await read(`ticket:${seeded}`)).replyBlocked).toBe('seed');
    const early = w.t.withIdentity({ subject: 'user_early' });
    const unprovisioned = await early.mutation(api.support.create, { category: 'bug', body: 'x' });
    expect((await read(`ticket:${unprovisioned}`)).personTickets).toBeNull();
  });

  test('the operator mail links the ticket’s Inbox item, not the retired page', async () => {
    const w = await world();
    const ticketId = await w.ticket();
    const jobs = await w.t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
    const alert = jobs.find((j) => /operatorAlerts(\.js)?:send$/.test(j.name));
    expect((alert?.args[0] as { deepLinkPath?: string } | undefined)?.deepLinkPath).toBe(
      `/admin/inbox?item=ticket:${ticketId}`,
    );
  });
});

describe('a seeded ticket is never mailed (D287)', () => {
  test('the reply is stored failed (seed) and nothing is scheduled; the send refuses it before any address', async () => {
    const w = await world();
    const mail = stubMail({ clerkEmail: 'never@example.test' });
    vi.stubEnv('CLERK_SECRET_KEY', 'sk_test_placeholder');
    const fake = await w.person('seed_inbox_ada', 'member', { email: 'ada@example.test' });
    const ticketId = await w.ticket(fake);
    const out = await w.admin.as.mutation(api.support.reply, { ticketId, body: 'Thanks' });
    expect(out).toMatchObject({ status: 'failed', failedWhy: 'seed' });
    expect(await w.message(out.messageId)).toMatchObject({ status: 'failed', failedWhy: 'seed' });
    const jobs = await w.t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
    expect(jobs.filter((j) => /^support(\.js)?:sendReply$/.test(j.name))).toEqual([]);
    // Driven through the send anyway — as a row a later bug left settling would be.
    await w.t.action(internal.support.sendReply, { messageId: out.messageId });
    await w.t.run((ctx) =>
      ctx.db.patch(out.messageId, { status: 'settling', failedWhy: undefined }),
    );
    await w.t.action(internal.support.sendReply, { messageId: out.messageId });
    expect(await w.message(out.messageId)).toMatchObject({ status: 'failed', failedWhy: 'seed' });
    await settle(w);
    // Not Resend, and not Clerk either: refused before any address was looked up.
    expect(mail.calls).toEqual([]);
  });
});

// ── Resolve and reopen ─────────────────────────────────────────────────────────────────────────

describe('support.resolve and support.reopen', () => {
  test('a resolve is audited and decides the item by its row; its undo reopens both; the undo’s undo resolves again', async () => {
    const w = await world();
    const ticketId = await w.ticket();
    const before = await w.tk(ticketId);
    const out = await w.admin.as.mutation(api.support.resolve, { ticketId });
    expect(out).toMatchObject({ ticketId, undoable: true, undoNeedsReason: false });
    expect(await w.tk(ticketId)).toMatchObject({
      status: 'resolved',
      resolvedByUserId: w.admin.id,
    });
    const item = await w.itemOf(ticketId);
    expect(item).toMatchObject({
      status: 'decided',
      decision: 'resolved',
      decisionActionId: out.actionId,
    });
    expect((await w.rowsOn(ticketId)).find((r) => r._id === out.actionId)?.reason).toBe('Resolved');

    await w.admin.as.mutation(api.undo.run, { actionId: out.actionId });
    const reopened = await w.tk(ticketId);
    expect({
      status: reopened?.status,
      resolvedAt: reopened?.resolvedAt,
      by: reopened?.resolvedByUserId,
    }).toEqual({
      status: before?.status,
      resolvedAt: before?.resolvedAt,
      by: before?.resolvedByUserId,
    });
    expect((await w.itemOf(ticketId))?.status).toBe('open');
    expect((await w.itemOf(ticketId))?._id).toBe(item?._id);
    const reopen = (await w.rowsOn(ticketId)).find((r) => r.action === 'reopen_ticket');
    expect(reopen?.undoesActionId).toBe(out.actionId);
    await w.colleague.as.mutation(api.undo.run, {
      actionId: reopen?._id as Id<'moderationActions'>,
    });
    expect((await w.tk(ticketId))?.status).toBe('resolved');
    expect((await w.itemOf(ticketId))?.status).toBe('decided');
  });

  test('reopen: refused while open, opens a resolved ticket and its item, and its undo resolves it', async () => {
    const w = await world();
    const ticketId = await w.ticket();
    await expect(w.admin.as.mutation(api.support.reopen, { ticketId })).rejects.toThrow(
      'This ticket is still open.',
    );
    await w.colleague.as.mutation(api.support.resolve, { ticketId });
    const out = await w.admin.as.mutation(api.support.reopen, { ticketId });
    expect(await w.tk(ticketId)).toMatchObject({ status: 'open' });
    expect((await w.tk(ticketId))?.resolvedAt).toBeUndefined();
    expect((await w.itemOf(ticketId))?.status).toBe('open');
    await w.admin.as.mutation(api.undo.run, { actionId: out.actionId });
    expect((await w.tk(ticketId))?.status).toBe('resolved');
    expect((await w.itemOf(ticketId))?.status).toBe('decided');
  });

  test('a ticket the staffer filed: every support undo refused to them, offered to a colleague', async () => {
    const w = await world();
    stubMail();
    const ticketId = await w.ticket(w.admin);
    const note = await w.colleague.as.mutation(api.support.addNote, { ticketId, body: 'n' });
    const reply = await w.colleague.as.mutation(api.support.reply, { ticketId, body: 'r' });
    const resolve = await w.colleague.as.mutation(api.support.resolve, { ticketId });
    for (const actionId of [note.actionId, reply.actionId]) {
      expect(await w.offer(w.admin, actionId)).toEqual({
        state: 'unavailable',
        why: 'You filed this, so another staff member decides it.',
      });
      await expect(w.admin.as.mutation(api.undo.run, { actionId })).rejects.toThrow(
        'You filed this',
      );
    }
    // The resolve's undo (a reopen): the same rule, as `support.reopen` would refuse it.
    await expect(w.admin.as.mutation(api.support.reopen, { ticketId })).rejects.toThrow(
      'You filed this',
    );
    expect(await w.offer(w.admin, resolve.actionId)).toMatchObject({ state: 'unavailable' });
    expect((await w.offer(w.colleague, resolve.actionId)).state).toBe('available');
  });
});

// ── The thread as the Inbox item serves it ──────────────────────────────────────────────────────

describe('inbox.item’s ticket: the thread, the person, related flags — staff-only', () => {
  test('the ticket body, then every message oldest to newest, notes marked, a removed note’s words withheld', async () => {
    const w = await world();
    stubMail();
    const ticketId = await w.ticket();
    const n1 = await w.admin.as.mutation(api.support.addNote, { ticketId, body: 'first' });
    vi.advanceTimersByTime(1000);
    const r1 = await w.admin.as.mutation(api.support.reply, { ticketId, body: 'second' });
    vi.advanceTimersByTime(1000);
    const n2 = await w.colleague.as.mutation(api.support.addNote, { ticketId, body: 'third' });
    await w.admin.as.mutation(api.undo.run, { actionId: n2.actionId });
    await w.mod.as.mutation(api.contentFlags.flag, {
      targetType: 'user',
      targetId: w.skater.id,
      reason: 'spam',
    });
    const read = await w.admin.as.query(api.inbox.item, { ref: `ticket:${ticketId}` });
    const item = read.item;
    if (item?.kind !== 'ticket') throw new Error('not a ticket');
    expect(item.ticket.body).toBe('The map is blank');
    expect(item.messages.map((m) => [m.messageId, m.kind, m.body])).toEqual([
      [n1.messageId, 'note', 'first'],
      [r1.messageId, 'reply', 'second'],
      [n2.messageId, 'note', null],
    ]);
    expect(item.messages[1]?.reply).toMatchObject({
      status: 'settling',
      cancel: null,
      failedWhy: null,
    });
    expect(item.messages.map((m) => m.remove)).toEqual([
      null,
      NOT_A_NOTE_REFUSAL,
      NOTE_REMOVED_REFUSAL,
    ]);
    expect(item.messageCount).toBe(3);
    expect(item.replyFrom).toBe(FROM);
    expect(item.replyBlocked).toBeNull();
    expect(item.personTickets).toEqual({ total: 1, resolved: 0, capped: false });
    expect(item.messages[0]?.author?.userId).toBe(w.admin.id);
    expect(item.messagesCut).toBe(false);
    expect(item.person?.person.userId).toBe(w.skater.id);
    expect(item.related.flags.map((f) => [f.reason, f.status])).toEqual([['spam', 'open']]);
    expect(item.can).toEqual({ reply: null, note: null, resolve: null });
    // The colleague's cancel offer for the admin's reply: the same rule, so the same answer.
    const asColleague = await w.colleague.as.query(api.inbox.item, { ref: `ticket:${ticketId}` });
    if (asColleague.item?.kind !== 'ticket') throw new Error('not a ticket');
    expect(asColleague.item.messages[1]?.reply?.cancel).toBeNull();
    await settle(w);
    const later = await w.admin.as.query(api.inbox.item, { ref: `ticket:${ticketId}` });
    if (later.item?.kind !== 'ticket') throw new Error('not a ticket');
    expect(later.item.messages[1]?.reply).toMatchObject({
      status: 'sent',
      cancel: SENT_REPLY_REFUSAL,
    });
    expect(CANCELED_REPLY_REFUSAL).toBeTruthy();
  });

  test('a busy ticket: hundreds of messages at the cap, the newest served, newest last, the cut said — inside the limits', async () => {
    const w = await world();
    const ticketId = await w.ticket(w.skater, HEAVY.repeat(5000));
    const N = 320;
    await w.t.run(async (ctx) => {
      for (let i = 0; i < N; i++) {
        await ctx.db.insert('supportMessages', {
          ticketId,
          kind: i % 2 ? 'note' : 'reply',
          authorId: i % 3 ? w.admin.id : w.colleague.id,
          body: `${String(i).padStart(4, '0')}${HEAVY.repeat(MAX_SUPPORT_REPLY_LENGTH - 4)}`,
          createdAt: Date.now() + i,
          ...(i % 2 ? {} : { status: 'sent' as const, sendAfter: Date.now(), sentAt: Date.now() }),
        });
      }
    });
    const read = await w.admin.as.query(api.inbox.item, { ref: `ticket:${ticketId}` });
    if (read.item?.kind !== 'ticket') throw new Error('not a ticket');
    expect(read.item.messagesCut).toBe(true);
    expect(read.item.messages).toHaveLength(THREAD_MESSAGES);
    const firstOf = (m: { body: string | null }) => Number(m.body?.slice(0, 4));
    expect(read.item.messages.map(firstOf)).toEqual(
      Array.from({ length: THREAD_MESSAGES }, (_, i) => N - THREAD_MESSAGES + i),
    );
  });

  test('a moderator is refused the item — every ref — and its rows, People’s appeals and the feed carry no words', async () => {
    const w = await world();
    stubMail();
    const ticketId = await w.ticket(w.skater, 'My secret appeal text');
    await w.admin.as.mutation(api.support.addNote, { ticketId, body: 'Staff-only remark' });
    await w.admin.as.mutation(api.support.reply, { ticketId, body: 'A private reply' });
    await w.admin.as.mutation(api.support.resolve, { ticketId });
    const itemId = (await w.itemOf(ticketId))?._id as Id<'inboxItems'>;
    for (const ref of [`ticket:${ticketId}`, ticketId, itemId]) {
      await expect(w.mod.as.query(api.inbox.item, { ref })).rejects.toThrow(/Support tickets/);
    }
    const words = /secret appeal|Staff-only remark|private reply/;
    // The audit feed (History): a moderator reads the rows, which carry default reasons and ids only.
    const feed = await w.mod.as.query(api.moderation.listActions, {
      targetType: 'supportTicket',
      targetId: ticketId,
    });
    expect(feed.map((r) => r.action).sort()).toEqual([
      'resolve_ticket',
      'support_note',
      'support_reply',
    ]);
    expect(JSON.stringify(feed)).not.toMatch(words);
    const recent = await w.mod.as.query(api.moderation.listActions, {});
    expect(JSON.stringify(recent)).not.toMatch(words);
    // The Inbox's lists, decided included.
    for (const lane of ['all', 'decided'] as const) {
      const page = await w.mod.as.query(api.inbox.listPage, { lane });
      expect(JSON.stringify(page)).not.toMatch(words);
    }
    // People's record of the skater: the appeals are an admin's (PII, D37).
    const record = await w.mod.as.query(api.people.person, { userId: w.skater.id });
    expect(JSON.stringify(record)).not.toMatch(words);
  });
});

// ── The person's export and their erasure ───────────────────────────────────────────────────────

describe('a person’s data export and erasure', () => {
  test('the export carries their tickets and the replies that reached them — never a note, an unsent reply, or the staffer', async () => {
    const w = await world();
    stubMail();
    const ticketId = await w.ticket(w.skater, 'Where did my report go?');
    await w.admin.as.mutation(api.support.addNote, { ticketId, body: 'Staff-only remark' });
    await w.admin.as.mutation(api.support.reply, { ticketId, body: 'It was merged.' });
    await settle(w);
    const canceled = await w.admin.as.mutation(api.support.reply, { ticketId, body: 'Never mind' });
    await w.admin.as.mutation(api.support.cancelReply, { messageId: canceled.messageId });
    const data = await w.t.query(internal.dataExport.collect, { userId: w.skater.id });
    expect(data.supportTickets).toHaveLength(1);
    expect(data.supportTickets[0]).toMatchObject({
      ticketId,
      body: 'Where did my report go?',
      status: 'open',
      replies: [{ body: 'It was merged.' }],
    });
    const text = JSON.stringify(data);
    expect(text).not.toContain('Staff-only remark');
    expect(text).not.toContain('Never mind');
    expect(text).not.toContain(w.admin.id);
    expect('supportTicketsCapped' in data).toBe(false);
  });

  test('a person with hundreds of tickets: the export is bounded and says it stopped short', async () => {
    const w = await world();
    await w.t.run(async (ctx) => {
      for (let i = 0; i < 260; i++) {
        const id = await ctx.db.insert('supportTickets', {
          userId: w.skater.id,
          clerkUserId: w.skater.subject,
          category: 'bug',
          body: HEAVY.repeat(5000),
          status: 'open',
          createdAt: Date.now() + i,
        });
        if (i % 50 === 0) {
          for (let k = 0; k < 3; k++) {
            await ctx.db.insert('supportMessages', {
              ticketId: id,
              kind: 'reply',
              authorId: w.admin.id,
              body: HEAVY.repeat(MAX_SUPPORT_REPLY_LENGTH),
              createdAt: Date.now() + i,
              status: 'sent',
              sendAfter: Date.now(),
              sentAt: Date.now(),
            });
          }
        }
      }
    });
    const data = await w.t.query(internal.dataExport.collect, { userId: w.skater.id });
    expect(data.supportTickets.length).toBeLessThanOrEqual(200);
    expect(data.supportTickets.length).toBeGreaterThan(0);
    expect(data.supportTicketsCapped).toBeTypeOf('string');
  });

  test('erasure takes each ticket with every message on it, over passes, leaving none behind — and a settling reply sends nothing', async () => {
    const w = await world();
    const mail = stubMail();
    const ticketId = await w.ticket();
    const pending = await w.admin.as.mutation(api.support.reply, { ticketId, body: 'Going out' });
    await w.t.run(async (ctx) => {
      for (let i = 0; i < 230; i++) {
        await ctx.db.insert('supportMessages', {
          ticketId,
          kind: 'note',
          authorId: w.admin.id,
          body: HEAVY.repeat(MAX_SUPPORT_NOTE_LENGTH),
          createdAt: Date.now() + i,
        });
      }
    });
    const other = await w.ticket(w.skater, 'second');
    await w.admin.as.mutation(api.support.addNote, { ticketId: other, body: 'x' });
    // The stage, as the finalizer runs it, a page at a time.
    let passes = 0;
    for (let more = true; more; passes++) {
      if (passes > 20) throw new Error('erasure never finished');
      more = (await w.t.run((ctx) => eraseTicketsOf(ctx, w.skater.subject, 100))).more;
    }
    expect(passes).toBeGreaterThan(2);
    const left = await w.t.run(async (ctx) => ({
      tickets: (await ctx.db.query('supportTickets').collect()).length,
      messages: (await ctx.db.query('supportMessages').collect()).length,
      members: (await ctx.db.query('inboxItemMembers').collect()).length,
    }));
    expect(left).toEqual({ tickets: 0, messages: 0, members: 0 });
    await settle(w);
    expect(mail.sent()).toEqual([]);
    expect(await w.message(pending.messageId)).toBeNull();
  });
});
