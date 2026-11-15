import { timeLeftInWords } from '@/lib/ages';
import { settledEmpty } from '../answers';
import {
  countText,
  type PersonCan,
  type PersonRead,
  plural,
  ROLE_WORDS,
  type Role,
  shownName,
} from './personModel';
import { WORDS } from './personWords';

/**
 * The page's levers, from the person read — pure. **`can` is the law**: a control the server would
 * refuse is never drawn as available, and nothing here decides a permission of its own. Where
 * `can` has no entry of its own for a write, the entry the server computes by the same rule is
 * read (`lib/peopleCan.writeRefusal`): every posting right given back, flagging switched back on and
 * the bounty limit are refused exactly when *Restrict* is (`can.restrict`), and a give-back never
 * asks a reason. The one control drawn though refused is the board's: the last ledger editor's
 * *Step down* / *Revoke*, disabled, with why.
 *
 * Rows hold facts and say what may be done; a row with nothing to say and nothing to do is left out
 * (a page about yourself shows its facts, and no levers on yourself).
 */

export type LeverTone = 'quiet' | 'ok' | 'warn' | 'bad';

export type Permission = 'reports' | 'hazards' | 'comments' | 'flagging';

/** What a lever's button does, as the page asks it of the server. */
export type PersonAction =
  | { kind: 'right'; permission: Permission; allowed: boolean; reason?: string }
  | { kind: 'bountyLimit'; limit: number | null; reason?: string }
  | {
      kind: 'suspend';
      until: number;
      reason: string;
      extend: boolean;
      /** What a new window did, for its receipt: more time, an end set, or a new window from now. */
      shape?: 'extend' | 'setEnd' | 'renew';
    }
  | { kind: 'lift' }
  | { kind: 'ban'; reason: string }
  | { kind: 'role'; role: Role; reason?: string }
  | { kind: 'ledger'; grant: boolean; reason?: string };

/** One button on a lever row. */
export type LeverButton =
  | {
      id: string;
      label: string;
      /** How pressing it proceeds: a write at once, or a dialog. */
      opens:
        | { kind: 'now'; action: PersonAction }
        | { kind: 'reason'; ask: ReasonAsk }
        | { kind: 'suspend'; extend: boolean }
        | { kind: 'bounty' }
        | { kind: 'roleMenu'; items: RoleItem[] };
      danger?: boolean;
    }
  | {
      id: string;
      label: string;
      /** Drawn, but refused: the board's tooltip says why. */
      refused: { title: string; body: string };
    };

/** A take-away asked in the reason dialog. */
export type ReasonAsk = {
  title: string;
  description: string;
  confirm: string;
  /** The write, given the reason typed. */
  action: (reason: string) => PersonAction;
  destructive?: boolean;
};

export type RoleItem = {
  role: Role;
  label: string;
  /** A demotion asks a reason; a promotion asks none. */
  needsReason: boolean;
  /**
   * Asks a plain confirm (no reason) first: making someone an admin, whose powers start at once —
   * an undo won't reach what they do in the meantime. Making a moderator acts straight away.
   */
  confirm: boolean;
  /** "Also revokes ledger editing", where the read says it applies. */
  note: string | null;
};

export type LeverRow = {
  key: string;
  label: string;
  status: string;
  tone: LeverTone;
  /** A second line under the row. */
  second?: string;
  buttons: LeverButton[];
  /** Two buttons drawn as one joined group (Extend | Lift). */
  joined?: boolean;
  /** The row's action is a tool not built yet: the kit's unavailable button (it says so). */
  unavailable?: boolean;
};

const RIGHT_WORDS: Record<Exclude<Permission, 'flagging'>, { label: string; verb: string }> = {
  reports: { label: 'Reports', verb: WORDS.rightVerb.reports },
  hazards: { label: 'Hazards', verb: WORDS.rightVerb.hazards },
  comments: { label: 'Comments', verb: WORDS.rightVerb.comments },
};

const LAST_EDITOR = {
  title: 'Give it to another admin first',
  body: 'The ledger always keeps an editor.',
};

/** "Can do": the posting rights, the bounty limit and flagging. */
export function canDoRows(p: PersonRead): LeverRow[] {
  const { rights, can } = p;
  const name = shownName(p);
  const rows: LeverRow[] = (['reports', 'hazards', 'comments'] as const).map((permission) => {
    const w = RIGHT_WORDS[permission];
    const allowed = rights[permission];
    const buttons: LeverButton[] = [];
    if (can.restrict.ok) {
      buttons.push(
        allowed
          ? {
              id: `${permission}-restrict`,
              label: 'Restrict',
              opens: {
                kind: 'reason',
                ask: {
                  title: WORDS.restrictTitle(w.label.toLowerCase()),
                  description: WORDS.restrictBody(name, w.verb),
                  confirm: 'Restrict',
                  action: (reason) => ({ kind: 'right', permission, allowed: false, reason }),
                },
              },
            }
          : {
              id: `${permission}-restrict`,
              label: 'Restore',
              opens: { kind: 'now', action: { kind: 'right', permission, allowed: true } },
            },
      );
    }
    return {
      key: permission,
      label: w.label,
      status: allowed ? 'Allowed' : WORDS.restricted,
      tone: allowed ? 'ok' : 'bad',
      buttons,
    };
  });

  const limit = rights.bountyLimit;
  const below = limit !== null && limit < rights.defaultBountyLimit;
  rows.push({
    key: 'bounties',
    label: 'Bounties',
    status:
      limit === null
        ? `Limit ${rights.defaultBountyLimit} · the default`
        : `Limit ${limit} (default ${rights.defaultBountyLimit})`,
    tone: below ? 'warn' : 'ok',
    buttons: can.restrict.ok
      ? [{ id: 'bounties-set', label: 'Set limit', opens: { kind: 'bounty' } }]
      : [],
  });

  const filed = `${countText(rights.flagsFiled)} filed`;
  const flagButtons: LeverButton[] = [];
  if (rights.flagging && can.flaggingOff.ok) {
    flagButtons.push({
      id: 'flagging-switch',
      label: 'Switch off',
      opens: {
        kind: 'reason',
        ask: {
          title: WORDS.flaggingOffTitle,
          description: WORDS.flaggingOffBody(name),
          confirm: 'Switch off',
          action: (reason) => ({ kind: 'right', permission: 'flagging', allowed: false, reason }),
        },
      },
    });
  } else if (!rights.flagging && can.restrict.ok) {
    flagButtons.push({
      id: 'flagging-switch',
      label: WORDS.switchOn,
      opens: { kind: 'now', action: { kind: 'right', permission: 'flagging', allowed: true } },
    });
  }
  rows.push({
    key: 'flagging',
    label: 'Flagging',
    status: rights.flagging ? `Allowed · ${filed}` : WORDS.switchedOff(filed),
    tone: rights.flagging ? 'ok' : 'bad',
    buttons: flagButtons,
  });
  return rows;
}

/** The role menu's choices: every role `can` allows but the one held. */
export function roleItems(p: PersonRead): RoleItem[] {
  const revokesLedger = p.ledger?.editor === true;
  return (['admin', 'moderator', 'member'] as const)
    .filter((role) => role !== p.role && p.can.role[role].ok)
    .map((role) => {
      const verdict = p.can.role[role];
      return {
        role,
        label: role === 'member' ? 'Make skater' : `Make ${role}`,
        needsReason: verdict.ok && verdict.needsReason,
        confirm: role === 'admin' && !(verdict.ok && verdict.needsReason),
        note: revokesLedger && role !== 'admin' ? 'Also revokes ledger editing' : null,
      };
    });
}

/** "Account": the role, ledger editing, the suspension, the ban, and what is on the record. */
export function accountRows(p: PersonRead, opts: { now: number; self: boolean }): LeverRow[] {
  const { can } = p;
  const rows: LeverRow[] = [];

  const items = roleItems(p);
  rows.push({
    key: 'role',
    label: 'Role',
    status: ROLE_WORDS[p.role],
    tone: p.role === 'member' ? 'quiet' : 'ok',
    buttons:
      items.length > 0
        ? [{ id: 'role-menu', label: 'Change role', opens: { kind: 'roleMenu', items } }]
        : [],
  });

  if (p.ledger !== null && can.ledger !== null) {
    const { editor, last } = p.ledger;
    const word = opts.self ? 'Step down' : 'Revoke';
    let buttons: LeverButton[] = [];
    if (!editor && can.ledger.grant.ok) {
      buttons = [
        {
          id: 'ledger',
          label: 'Grant',
          opens: { kind: 'now', action: { kind: 'ledger', grant: true } },
        },
      ];
    } else if (editor && can.ledger.revoke.ok) {
      buttons = [
        {
          id: 'ledger',
          label: word,
          opens: {
            kind: 'reason',
            ask: {
              title: opts.self ? WORDS.stepDownTitle : WORDS.revokeLedgerTitle,
              description: WORDS.ledgerOffBody(shownName(p)),
              confirm: word,
              action: (reason) => ({ kind: 'ledger', grant: false, reason }),
            },
          },
        },
      ];
    } else if (editor && last) {
      buttons = [{ id: 'ledger', label: word, refused: LAST_EDITOR }];
    }
    rows.push({
      key: 'ledger',
      label: 'Ledger editing',
      status: editor ? (last ? 'On · the only editor' : 'On') : 'Off',
      tone: editor ? 'ok' : 'quiet',
      buttons,
    });
  }

  const note = p.statusNote;
  const suspended = p.status === 'suspended';
  if (suspended) {
    const until = note?.suspendedUntil ?? null;
    // The read's `lapsed` is as of the minute the page opened; the end passing since is lapsed too.
    const lapsed = note?.lapsed === true || (until !== null && until <= opts.now);
    const buttons: LeverButton[] = [];
    // A new window on any suspended account, exactly as the server answers it: its own `extend` when
    // the read carries one, else the rule it writes a suspension by (`suspend`) — never the page's
    // idea of the suspension's shape. An open-ended one gets an end; one that ran its course, a new
    // window from now; a dated one, more time on its end (the dialog says which).
    const extend = (can as PersonCan).extend ?? can.suspend;
    if (extend.ok) {
      buttons.push({
        id: 'suspend',
        label: until === null ? WORDS.setAnEnd : WORDS.extend,
        opens: { kind: 'suspend', extend: true },
      });
    }
    if (can.lift.ok) {
      buttons.push({ id: 'lift', label: 'Lift', opens: { kind: 'now', action: { kind: 'lift' } } });
    }
    rows.push({
      key: 'suspension',
      label: 'Suspension',
      status: lapsed
        ? WORDS.lapsed
        : until === null
          ? WORDS.untilLifted
          : timeLeftInWords(until, opts.now),
      tone: lapsed ? 'quiet' : 'warn',
      buttons,
      joined: buttons.length > 1,
    });
  } else if (can.suspend.ok) {
    rows.push({
      key: 'suspension',
      label: 'Suspension',
      status: 'Not suspended',
      tone: 'quiet',
      buttons: [{ id: 'suspend', label: 'Suspend', opens: { kind: 'suspend', extend: false } }],
    });
  }

  if (p.status === 'banned') {
    rows.push({
      key: 'ban',
      label: 'Ban',
      status: WORDS.bannedStatus,
      tone: 'bad',
      buttons: can.lift.ok
        ? [{ id: 'lift', label: 'Lift', opens: { kind: 'now', action: { kind: 'lift' } } }]
        : [],
    });
  } else if (can.ban.ok) {
    rows.push({
      key: 'ban',
      label: 'Ban',
      status: 'Account kept for appeal',
      tone: 'quiet',
      buttons: [
        {
          id: 'ban',
          label: 'Ban',
          danger: true,
          opens: {
            kind: 'reason',
            ask: {
              title: WORDS.banTitle(shownName(p)),
              description: WORDS.banBody,
              confirm: 'Ban',
              destructive: true,
              action: (reason) => ({ kind: 'ban', reason }),
            },
          },
        },
      ],
    });
  }

  // *On the record* (the sheet's standing list: what is hidden or removed under a verdict). Left out
  // only when nothing stands for certain — a count that stopped at its cap stays. The row widens to
  // the sheet's Deleted and Reversed lists once the server counts them.
  if (!settledEmpty({ count: p.hidden.total, capped: p.hidden.capped, pending: false })) {
    rows.push({
      key: 'record',
      label: WORDS.onTheRecord,
      // A floor that read none says so in words, never as a zero.
      status:
        p.hidden.total === 0
          ? WORDS.recordUncounted
          : `${countText({ count: p.hidden.total, capped: p.hidden.capped })} ${p.hidden.total === 1 && !p.hidden.capped ? 'item' : 'items'}`,
      tone: 'quiet',
      second: hiddenKinds(p.hidden),
      buttons: [],
      unavailable: true,
    });
  }
  return rows;
}

const KIND_WORDS: Record<keyof PersonRead['hidden']['byKind'], [string, string]> = {
  report: ['report', 'reports'],
  post: ['post', 'posts'],
  comment: ['comment', 'comments'],
  hazard: ['hazard', 'hazards'],
  accessAlert: ['access alert', 'access alerts'],
};

/**
 * "2 reports · 2 comments": each kind with any, in a fixed order. No photos: they have no verdicts.
 * Under a cap each kind's count is a floor too ("300+ reports"), never an exact number.
 */
export function hiddenKinds(hidden: PersonRead['hidden']): string {
  return (Object.keys(KIND_WORDS) as Array<keyof typeof KIND_WORDS>)
    .filter((k) => hidden.byKind[k] > 0)
    .map((k) =>
      hidden.capped
        ? `${countText({ count: hidden.byKind[k], capped: true })} ${KIND_WORDS[k][1]}`
        : plural(hidden.byKind[k], ...KIND_WORDS[k]),
    )
    .join(' · ');
}

/** Every button a set of rows draws, menu items included — for the property tests. */
export function allButtons(rows: readonly LeverRow[]): LeverButton[] {
  return rows.flatMap((r) => r.buttons);
}
