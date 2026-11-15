import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  accountRows,
  allButtons,
  canDoRows,
  hiddenKinds,
  type LeverButton,
  type LeverRow,
  roleItems,
} from './levers';
import {
  IDS,
  LAST_EDITOR,
  NOW,
  no,
  personOf,
  ROB,
  ROB_DELETED,
  SARAH_BY_MODERATOR,
  SARAH_GRANTED,
  SARAH_PAGE,
  TEAGAN_PAGE,
  yes,
} from './personFixtures';
import type { Can, PersonRead } from './personModel';

const labels = (rows: readonly LeverRow[], key: string) =>
  (rows.find((r) => r.key === key)?.buttons ?? []).map((b) => b.label);
const row = (rows: readonly LeverRow[], key: string) => rows.find((r) => r.key === key);

/** A pressable button (not the board's refused one). */
const pressable = (b: LeverButton) => !('refused' in b);

describe('Can do', () => {
  it('draws board 8.1: Comments restricted with Restore, a limit below the default in amber', () => {
    const rows = canDoRows(ROB);
    expect(rows.map((r) => [r.label, r.status, r.tone])).toEqual([
      ['Reports', 'Allowed', 'ok'],
      ['Hazards', 'Allowed', 'ok'],
      ['Comments', 'Restricted', 'bad'],
      ['Bounties', 'Limit 1 (default 3)', 'warn'],
      ['Flagging', 'Allowed · 0 filed', 'ok'],
    ]);
    expect(labels(rows, 'reports')).toEqual(['Restrict']);
    expect(labels(rows, 'comments')).toEqual(['Restore']);
    expect(labels(rows, 'bounties')).toEqual(['Set limit']);
    expect(labels(rows, 'flagging')).toEqual(['Switch off']);
  });

  it('a give-back acts at once; a take-away asks why', () => {
    const rows = canDoRows(ROB);
    const restore = row(rows, 'comments')?.buttons[0];
    expect(restore && 'opens' in restore && restore.opens).toEqual({
      kind: 'now',
      action: { kind: 'right', permission: 'comments', allowed: true },
    });
    const restrict = row(rows, 'reports')?.buttons[0];
    if (!restrict || !('opens' in restrict) || restrict.opens.kind !== 'reason')
      throw new Error('ask');
    expect(restrict.opens.ask.action('Spam')).toEqual({
      kind: 'right',
      permission: 'reports',
      allowed: false,
      reason: 'Spam',
    });
  });

  it('flagging switched off reads red, and switches back on without a reason', () => {
    const off = canDoRows(
      personOf({
        rights: { ...ROB.rights, flagging: false, flagsFiled: { count: 100, capped: true } },
      }),
    );
    expect(row(off, 'flagging')).toMatchObject({
      status: 'Switched off · 100+ filed',
      tone: 'bad',
    });
    const b = row(off, 'flagging')?.buttons[0];
    expect(b && 'opens' in b && b.opens).toEqual({
      kind: 'now',
      action: { kind: 'right', permission: 'flagging', allowed: true },
    });
  });

  it('the default bounty limit and a limit at or over it read quiet-white', () => {
    expect(row(canDoRows(SARAH_PAGE), 'bounties')).toMatchObject({
      status: 'Limit 3 · the default',
      tone: 'ok',
    });
    const over = canDoRows(personOf({ rights: { ...ROB.rights, bountyLimit: 5 } }));
    expect(row(over, 'bounties')).toMatchObject({ status: 'Limit 5 (default 3)', tone: 'ok' });
  });

  it('staff can always flag: no Switch off on a staffer', () => {
    expect(labels(canDoRows(SARAH_PAGE), 'flagging')).toEqual([]);
  });

  it('your own page draws the facts and no levers', () => {
    expect(allButtons(canDoRows(TEAGAN_PAGE))).toEqual([]);
  });
});

describe('Account', () => {
  it('draws board 8.1: Role, Suspension (Extend | Lift joined), Ban, Hidden content', () => {
    const rows = accountRows(ROB, { now: NOW, self: false });
    expect(rows.map((r) => [r.label, r.status])).toEqual([
      ['Role', 'Skater'],
      ['Suspension', '1 day left'],
      ['Ban', 'Account kept for appeal'],
      ['Hidden content', '4 items'],
    ]);
    expect(row(rows, 'suspension')).toMatchObject({ joined: true, tone: 'warn' });
    expect(labels(rows, 'suspension')).toEqual(['Extend', 'Lift']);
    expect(row(rows, 'ban')?.buttons[0]).toMatchObject({ label: 'Ban', danger: true });
    expect(row(rows, 'hidden')).toMatchObject({
      second: '2 reports · 2 comments',
      unavailable: true,
      buttons: [],
    });
  });

  it('draws board 8.2: ledger Off with Grant, Change role, Suspend, Ban', () => {
    const rows = accountRows(SARAH_PAGE, { now: NOW, self: false });
    expect(rows.map((r) => [r.label, r.status, r.buttons.map((b) => b.label)])).toEqual([
      ['Role', 'Admin', ['Change role']],
      ['Ledger editing', 'Off', ['Grant']],
      ['Suspension', 'Not suspended', ['Suspend']],
      ['Ban', 'Account kept for appeal', ['Ban']],
    ]);
  });

  it('draws board 8.5: ledger On with Revoke; the role menu says it also revokes ledger editing', () => {
    const rows = accountRows(SARAH_GRANTED, { now: NOW, self: false });
    expect(row(rows, 'ledger')).toMatchObject({ status: 'On' });
    expect(labels(rows, 'ledger')).toEqual(['Revoke']);
    expect(roleItems(SARAH_GRANTED)).toEqual([
      {
        role: 'moderator',
        label: 'Make moderator',
        needsReason: true,
        note: 'Also revokes ledger editing',
      },
      {
        role: 'member',
        label: 'Make skater',
        needsReason: true,
        note: 'Also revokes ledger editing',
      },
    ]);
    expect(roleItems(SARAH_PAGE).every((i) => i.note === null)).toBe(true);
  });

  it('draws board 8.6: Role with no menu; the only editor’s Step down disabled with the board’s tooltip', () => {
    const rows = accountRows(TEAGAN_PAGE, { now: NOW, self: true });
    expect(rows.map((r) => r.key)).toEqual(['role', 'ledger']);
    expect(row(rows, 'role')?.buttons).toEqual([]);
    expect(row(rows, 'ledger')).toMatchObject({ status: 'On · the only editor' });
    expect(row(rows, 'ledger')?.buttons).toEqual([
      {
        id: 'ledger',
        label: 'Step down',
        refused: {
          title: 'Give it to another admin first',
          body: 'The ledger always keeps an editor.',
        },
      },
    ]);
  });

  it('a step down when another editor exists asks why', () => {
    const page = {
      ...TEAGAN_PAGE,
      ledger: { editor: true, last: false },
      can: { ...TEAGAN_PAGE.can, ledger: { grant: no('x'), revoke: yes(true) } },
    };
    const b = row(accountRows(page, { now: NOW, self: true }), 'ledger')?.buttons[0];
    expect(b).toMatchObject({ label: 'Step down', opens: { kind: 'reason' } });
  });

  it('a moderator on an admin’s page sees no ledger row and no levers', () => {
    const rows = accountRows(SARAH_BY_MODERATOR, { now: NOW, self: false });
    expect(rows.map((r) => r.key)).toEqual(['role']);
    expect(allButtons(rows)).toEqual([]);
    expect(allButtons(canDoRows(SARAH_BY_MODERATOR))).toEqual([]);
  });

  it('a banned account: Lift on the Ban row; Suspend replaces it', () => {
    const banned = personOf({ status: 'banned' });
    const rows = accountRows(banned, { now: NOW, self: false });
    expect(row(rows, 'ban')).toMatchObject({
      status: 'Banned · account kept for appeal',
      tone: 'bad',
    });
    expect(labels(rows, 'ban')).toEqual(['Lift']);
    expect(labels(rows, 'suspension')).toEqual(['Suspend']);
  });

  it('a suspension that ran its course or has no end', () => {
    const lapsed = personOf({
      status: 'suspended',
      statusNote: {
        action: 'suspend',
        at: NOW,
        by: null,
        via: null,
        reason: null,
        suspendedUntil: NOW - 1,
        lapsed: true,
      },
    });
    expect(row(accountRows(lapsed, { now: NOW, self: false }), 'suspension')).toMatchObject({
      status: 'Ran its course',
      tone: 'quiet',
    });
    expect(labels(accountRows(lapsed, { now: NOW, self: false }), 'suspension')).toEqual(['Lift']);
    const open = personOf({
      status: 'suspended',
      statusNote: {
        action: 'suspend',
        at: NOW,
        by: null,
        via: null,
        reason: null,
        suspendedUntil: null,
        lapsed: false,
      },
    });
    expect(row(accountRows(open, { now: NOW, self: false }), 'suspension')?.status).toBe(
      'Until lifted',
    );
  });

  it('a deleted account offers nothing the server would refuse', () => {
    const rows = [
      ...canDoRows(ROB_DELETED),
      ...accountRows(ROB_DELETED, { now: NOW, self: false }),
    ];
    expect(allButtons(rows)).toEqual([]);
  });

  it('hidden content counts each kind, never photos; capped is a floor', () => {
    expect(
      hiddenKinds({
        total: 6,
        capped: false,
        byKind: { report: 1, post: 2, comment: 0, hazard: 1, accessAlert: 2 },
      }),
    ).toBe('1 report · 2 posts · 1 hazard · 2 access alerts');
    const one = accountRows(
      personOf({
        hidden: {
          total: 1,
          capped: false,
          byKind: { report: 1, post: 0, comment: 0, hazard: 0, accessAlert: 0 },
        },
      }),
      { now: NOW, self: false },
    );
    expect(row(one, 'hidden')?.status).toBe('1 item');
    const many = accountRows(
      personOf({
        hidden: {
          total: 500,
          capped: true,
          byKind: { report: 500, post: 0, comment: 0, hazard: 0, accessAlert: 0 },
        },
      }),
      { now: NOW, self: false },
    );
    expect(row(many, 'hidden')?.status).toBe('500+ items');
  });
});

// ── The law: for any `can`, the drawn controls are exactly what it allows ───────────────────

const canArb: fc.Arbitrary<Can> = fc.oneof(
  fc.boolean().map((needsReason) => ({ ok: true as const, needsReason })),
  fc.constant({ ok: false as const, why: 'Refused' }),
);

const personArb = fc
  .record({
    role: fc.constantFrom('member' as const, 'moderator' as const, 'admin' as const),
    status: fc.constantFrom(
      'active' as const,
      'suspended' as const,
      'banned' as const,
      'deleting' as const,
      'deleted' as const,
    ),
    lapsed: fc.boolean(),
    reports: fc.boolean(),
    hazards: fc.boolean(),
    comments: fc.boolean(),
    flagging: fc.boolean(),
    ledgerShown: fc.boolean(),
    editor: fc.boolean(),
    last: fc.boolean(),
    can: fc.record({
      restrict: canArb,
      flaggingOff: canArb,
      suspend: canArb,
      ban: canArb,
      lift: canArb,
      role: fc.record({ admin: canArb, moderator: canArb, member: canArb }),
      grant: canArb,
      revoke: canArb,
    }),
  })
  .map(
    (x): PersonRead =>
      personOf({
        userId: IDS.rob,
        role: x.role,
        status: x.status,
        statusNote:
          x.status === 'suspended'
            ? {
                action: 'suspend',
                at: NOW,
                by: null,
                via: null,
                reason: null,
                suspendedUntil: NOW + 86_400_000,
                lapsed: x.lapsed,
              }
            : null,
        rights: {
          ...ROB.rights,
          reports: x.reports,
          hazards: x.hazards,
          comments: x.comments,
          flagging: x.flagging,
        },
        ledger: x.ledgerShown ? { editor: x.editor, last: x.last } : null,
        can: {
          restrict: x.can.restrict,
          flaggingOff: x.can.flaggingOff,
          suspend: x.can.suspend,
          ban: x.can.ban,
          lift: x.can.lift,
          role: x.can.role,
          ledger: x.ledgerShown ? { grant: x.can.grant, revoke: x.can.revoke } : null,
        },
      }),
  );

/** What `can` allows, as the button ids each allowed write is drawn as. */
function expected(p: PersonRead): string[] {
  const ids: string[] = [];
  const { can, rights } = p;
  if (can.restrict.ok)
    ids.push('reports-restrict', 'hazards-restrict', 'comments-restrict', 'bounties-set');
  if (rights.flagging ? can.flaggingOff.ok : can.restrict.ok) ids.push('flagging-switch');
  if ((['admin', 'moderator', 'member'] as const).some((r) => r !== p.role && can.role[r].ok))
    ids.push('role-menu');
  if (p.ledger !== null && can.ledger !== null) {
    if (!p.ledger.editor && can.ledger.grant.ok) ids.push('ledger');
    if (p.ledger.editor && can.ledger.revoke.ok) ids.push('ledger');
  }
  const suspended = p.status === 'suspended';
  const lapsed = p.statusNote?.lapsed === true;
  if (can.suspend.ok && !(suspended && lapsed)) ids.push('suspend');
  if (can.lift.ok && (suspended || p.status === 'banned')) ids.push('lift');
  if (can.ban.ok && p.status !== 'banned') ids.push('ban');
  return ids.sort();
}

describe('can is the law (property)', () => {
  it('no control is drawn that can forbids, and none it allows is missing', () => {
    fc.assert(
      fc.property(personArb, fc.boolean(), (p, self) => {
        const rows = [...canDoRows(p), ...accountRows(p, { now: NOW, self })];
        const drawn = allButtons(rows)
          .filter(pressable)
          .map((b) => b.id)
          .sort();
        expect(drawn).toEqual(expected(p));
        // The menu lists exactly the roles `can` allows, never the one held.
        const menu = allButtons(rows).find((b) => b.id === 'role-menu');
        const items =
          menu && 'opens' in menu && menu.opens.kind === 'roleMenu' ? menu.opens.items : [];
        expect(items.map((i) => i.role).sort()).toEqual(
          (['admin', 'moderator', 'member'] as const)
            .filter((r) => r !== p.role && p.can.role[r].ok)
            .sort(),
        );
        for (const i of items) {
          const v = p.can.role[i.role];
          expect(i.needsReason).toBe(v.ok && v.needsReason);
        }
        // The only refused control drawn is the board's: the last editor's way off the ledger.
        const refused = allButtons(rows).filter((b) => !pressable(b));
        const wantRefused =
          p.ledger !== null &&
          p.can.ledger !== null &&
          p.ledger.editor &&
          p.ledger.last &&
          !p.can.ledger.revoke.ok;
        expect(refused.length).toBe(wantRefused ? 1 : 0);
      }),
    );
  });

  it('the refused control’s words are the board’s, never the server’s message', () => {
    const page: PersonRead = {
      ...TEAGAN_PAGE,
      can: { ...TEAGAN_PAGE.can, ledger: { grant: no('x'), revoke: no(LAST_EDITOR) } },
    };
    const b = row(accountRows(page, { now: NOW, self: false }), 'ledger')?.buttons[0];
    expect(b).toMatchObject({
      label: 'Revoke',
      refused: { title: 'Give it to another admin first' },
    });
  });
});
