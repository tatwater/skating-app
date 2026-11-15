import type { Id } from '@skating/convex/dataModel';
import { describe, expect, it } from 'vitest';

import { rowActor, rowReason, rowSentence, undoneWords } from './feedWords';
import type { PersonAction } from './levers';
import { MATT, NOW, ROB_HISTORY, rowOf, SARAH, TEAGAN } from './personFixtures';
import { receiptFor } from './receipts';

const local = (m: number, d: number, h = 12) => new Date(2026, m - 1, d, h).getTime();

describe('a feed row in words', () => {
  it('names each person-targeted verb with its object', () => {
    const say = (over: Parameters<typeof rowOf>[0]) => rowSentence(rowOf(over), NOW);
    expect(say({ action: 'suspend', metadata: { suspendedUntil: local(10, 15) } })).toBe(
      'Suspended Rob Tremblay until 15 Oct',
    );
    expect(say({ action: 'suspend' })).toBe('Suspended Rob Tremblay');
    expect(say({ action: 'ban' })).toBe('Banned Rob Tremblay');
    expect(say({ action: 'unban', metadata: { prev: { status: 'banned' } } })).toBe(
      'Lifted the ban on Rob Tremblay',
    );
    expect(say({ action: 'unban', metadata: { prev: { status: 'suspended' } } })).toBe(
      'Lifted the suspension on Rob Tremblay',
    );
    expect(say({ action: 'unban' })).toBe('Lifted a ban or suspension on Rob Tremblay');
    expect(
      say({
        action: 'set_posting_permission',
        metadata: { permission: 'comments', allowed: false },
      }),
    ).toBe('Restricted comments for Rob Tremblay');
    expect(
      say({ action: 'set_posting_permission', metadata: { permission: 'hazards', allowed: true } }),
    ).toBe('Restored hazards for Rob Tremblay');
    expect(
      say({
        action: 'set_posting_permission',
        metadata: { permission: 'flagging', allowed: false },
      }),
    ).toBe('Switched off flagging for Rob Tremblay');
    expect(
      say({
        action: 'set_posting_permission',
        metadata: { permission: 'flagging', allowed: true },
      }),
    ).toBe('Switched flagging back on for Rob Tremblay');
    expect(
      say({ action: 'set_posting_permission', metadata: { permission: 'bounties', limit: 1 } }),
    ).toBe('Set the bounty limit for Rob Tremblay to 1');
    expect(
      say({ action: 'set_posting_permission', metadata: { permission: 'bounties', limit: null } }),
    ).toBe('Put the bounty limit for Rob Tremblay back to the default');
    expect(say({ action: 'set_posting_permission' })).toBe(
      'Changed posting rights for Rob Tremblay',
    );
    expect(say({ action: 'grant_role', metadata: { role: 'admin' } })).toBe(
      'Made Rob Tremblay an admin',
    );
    expect(say({ action: 'grant_role' })).toBe('Made Rob Tremblay a moderator');
    expect(say({ action: 'revoke_role' })).toBe('Made Rob Tremblay a skater');
    expect(say({ action: 'grant_ledger_editor' })).toBe('Gave Rob Tremblay ledger editing');
    expect(say({ action: 'revoke_ledger_editor' })).toBe('Took ledger editing from Rob Tremblay');
    expect(say({ action: 'erase' })).toBe('Erased an account · Rob Tremblay');
  });

  it('names other targets by their label, an unlabelled one generically, and marks an undo', () => {
    expect(
      rowSentence(
        rowOf({ action: 'hide', targetType: 'report', targetLabel: 'Mascoma Lake' }),
        NOW,
      ),
    ).toBe('Hid a report · Mascoma Lake');
    const { targetLabel: _drop, ...bare } = rowOf({ action: 'hide', targetType: 'comment' });
    expect(rowSentence(bare, NOW)).toBe('Hid a comment');
    const { targetLabel: _drop2, ...user } = rowOf({ action: 'ban' });
    expect(rowSentence(user, NOW)).toBe('Banned an account');
    expect(
      rowSentence(rowOf({ action: 'ban', undoesActionId: 'a0' as Id<'moderationActions'> }), NOW),
    ).toBe('Banned Rob Tremblay · an undo');
  });

  it('keeps a typed reason and leaves out a give-back’s default', () => {
    expect(rowReason(rowOf({ action: 'ban', reason: '  Spam  ' }))).toBe('Spam');
    expect(rowReason(rowOf({ action: 'unban', reason: 'Lifted', reasonGiven: false }))).toBeNull();
    expect(rowReason(rowOf({ action: 'ban', reason: ' ' }))).toBeNull();
  });

  it('names who acted: staff by first name, a script after the name, the machines as System', () => {
    expect(rowActor(rowOf({ action: 'ban', actor: MATT }))).toEqual({ name: 'Matt', via: null });
    expect(rowActor(rowOf({ action: 'ban', actor: TEAGAN, via: 'seed-x' }))).toEqual({
      name: 'Teagan',
      via: 'seed-x',
    });
    expect(rowActor(rowOf({ action: 'author_delete', actor: SARAH }))).toEqual({
      name: 'Sarah Berman',
      via: null,
    });
    expect(rowActor(rowOf({ action: 'unban', actor: null }))).toEqual({
      name: 'System',
      via: null,
    });
    expect(
      rowActor(
        rowOf({
          action: 'ban',
          actor: {
            userId: 'x' as Id<'profiles'>,
            displayName: null,
            username: null,
            profileImageUrl: null,
          },
        }),
      ),
    ).toEqual({ name: 'Name still being prepared', via: null });
  });

  it('says who undid a row when the row that did is on the page', () => {
    const undo = rowOf({ action: 'unban', actor: SARAH });
    const undone = rowOf({ action: 'ban', undo: { state: 'undone', byActionId: undo.id } });
    expect(undoneWords(undone, [undone, undo])).toBe('Undone · Sarah');
    expect(undoneWords(undone, [undone])).toBe('Undone');
    expect(undoneWords(ROB_HISTORY.rows[0] as never, ROB_HISTORY.rows)).toBeNull();
  });
});

describe('the receipt', () => {
  const person = { displayName: 'Sarah Berman', defaultBountyLimit: 3 };
  const say = (a: PersonAction) => receiptFor(a, person, NOW);
  it('says what was done to whom, never "You"', () => {
    expect(say({ kind: 'right', permission: 'comments', allowed: false, reason: 'x' })).toEqual({
      title: 'Sarah Berman can’t comment',
      description: 'Everything else they can do stays as it is',
    });
    expect(say({ kind: 'right', permission: 'flagging', allowed: true })).toEqual({
      title: 'Sarah Berman can flag again',
    });
    expect(say({ kind: 'bountyLimit', limit: 1 })).toEqual({
      title: 'Sarah Berman’s bounty limit is 1',
    });
    expect(say({ kind: 'bountyLimit', limit: null })).toEqual({
      title: 'Sarah Berman’s bounty limit is back to the default (3)',
    });
    expect(say({ kind: 'suspend', until: local(10, 21), reason: 'x', extend: false })).toEqual({
      title: 'Sarah Berman is suspended',
      description: 'It lifts on its own Wed 21 Oct 12:00',
    });
    expect(say({ kind: 'suspend', until: local(10, 21), reason: 'x', extend: true }).title).toBe(
      'Sarah Berman’s suspension is extended',
    );
    expect(say({ kind: 'lift' })).toEqual({ title: 'Sarah Berman can sign in again' });
    expect(say({ kind: 'ban', reason: 'x' })).toEqual({
      title: 'Sarah Berman is banned',
      description: 'The account is kept for an appeal',
    });
    expect(say({ kind: 'role', role: 'moderator' })).toEqual({
      title: 'Sarah Berman is now a moderator',
    });
    expect(say({ kind: 'ledger', grant: true })).toEqual({
      title: 'Sarah Berman can edit the ledger',
      description: 'They can give it to other admins too',
    });
    expect(say({ kind: 'ledger', grant: false, reason: 'x' })).toEqual({
      title: 'Sarah Berman can’t edit the ledger',
    });
    for (const a of [
      { kind: 'lift' },
      { kind: 'ban', reason: 'x' },
      { kind: 'role', role: 'admin' },
    ] as PersonAction[]) {
      expect(JSON.stringify(say(a))).not.toMatch(/\bYou\b|safe|skateable/i);
    }
  });
});
