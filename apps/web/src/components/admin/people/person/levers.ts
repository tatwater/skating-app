import { timeLeftInWords } from '@/lib/ages';
import {
  kindsLine,
  type RecordPresence,
  recordRowShows,
  standingWords,
} from '../record/recordModel';
import { FACT_WORDS as F } from './factWords';
import {
  countText,
  dateWords,
  type PersonCan,
  type PersonRead,
  ROLE_WORDS,
  type Role,
  shownName,
} from './personModel';
import { WORDS } from './personWords';

/**
 * The page's levers, from the person read — pure. **`can` is the law**: a control the server would
 * refuse is never drawn as available, and nothing here decides a permission of its own. Every
 * lever reads its own entry (`lib/peopleCan.writeRefusal` on the server): a right given back
 * (`can.restore`), flagging switched back on (`can.flaggingOn`), the bounty limit raised or lowered
 * (`can.bountyRaise`, `can.bountyLower` — *Set limit* is drawn while either is open, and its dialog
 * allows only the way that is). The one control drawn though refused is the board's: the last
 * ledger editor's *Step down* / *Revoke*, disabled, with why.
 *
 * The facts under a row are the read's own: since when a right is off (`rightsSince`) and ledger
 * editing held (`ledger.since`), and this season's bounty asks (`bountySeason`) — each a date or a
 * count, *not recorded yet* for `null`, *not found in what this read covers* for a read that
 * stopped short or couldn't be afforded.
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
  /** The row's action opens the record sheet (*On the record*'s *Review*). */
  review?: boolean;
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

/** A start as a row's sub-line: its date, not recorded, or older than one read covers. */
function sinceWords(
  at: number | null,
  capped: boolean,
  now: number,
  timeZone: string | undefined,
): string {
  if (at !== null) return F.since(dateWords(at, now, timeZone));
  return capped ? F.sinceUnread : F.sinceUnrecorded;
}

/** This season's bounty asks, as the Bounties row's sub-line. */
export function seasonAsksWords(season: PersonRead['bountySeason']): string {
  if (season === null) return F.seasonAsksUnrecorded;
  const { asks, overLimit, hadRecentReport } = season;
  if (asks.count === 0 && !asks.capped) return F.noSeasonAsks;
  return F.seasonAsks(
    F.asks(countText(asks), asks.count === 1 && !asks.capped),
    countText(overLimit),
    countText(hadRecentReport),
  );
}

/** "Can do": the posting rights, the bounty limit and flagging. */
export function canDoRows(p: PersonRead, opts: { now: number; timeZone?: string }): LeverRow[] {
  const { rights, can } = p;
  const name = shownName(p);
  const offSince = (right: Permission) =>
    sinceWords(p.rightsSince[right], p.rightsSinceCapped, opts.now, opts.timeZone);
  const rows: LeverRow[] = (['reports', 'hazards', 'comments'] as const).map((permission) => {
    const w = RIGHT_WORDS[permission];
    const allowed = rights[permission];
    const buttons: LeverButton[] = [];
    if (allowed && can.restrict.ok) {
      buttons.push({
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
      });
    } else if (!allowed && can.restore[permission].ok) {
      buttons.push({
        id: `${permission}-restrict`,
        label: 'Restore',
        opens: { kind: 'now', action: { kind: 'right', permission, allowed: true } },
      });
    }
    return {
      key: permission,
      label: w.label,
      status: allowed ? 'Allowed' : WORDS.restricted,
      tone: allowed ? 'ok' : 'bad',
      ...(!allowed && { second: offSince(permission) }),
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
    second: seasonAsksWords(p.bountySeason),
    buttons:
      can.bountyRaise.ok || can.bountyLower.ok
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
  } else if (!rights.flagging && can.flaggingOn.ok) {
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
    ...(!rights.flagging && { second: offSince('flagging') }),
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
export function accountRows(
  p: PersonRead,
  opts: {
    now: number;
    timeZone?: string;
    self: boolean;
    /**
     * Whether the record's other two lists hold anything (`contentRecord.recordPresence`): `null`
     * while on its way; `'failed'` when it couldn't be read — then the row stands, and says so.
     */
    presence?: RecordPresence | 'failed' | null;
  },
): LeverRow[] {
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
    const { editor, last, since, sinceCapped } = p.ledger;
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
      ...(editor && { second: sinceWords(since, sinceCapped, opts.now, opts.timeZone) }),
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

  // *On the record*: the sheet's three lists. Drawn whenever any list has items, a count stopped at
  // its cap, or the record is still being prepared (`recordRowShows`) — Standing from this read
  // (`hidden`), Deleted and Reversed from `contentRecord.recordPresence` once it lands. Its count is
  // what stands, as the sheet's head says it ("0 items" when only the others hold anything).
  const preparing = p.pending.includes('verdicts');
  if (recordRowShows(p.hidden, opts.presence ?? null, preparing)) {
    rows.push({
      key: 'record',
      label: WORDS.onTheRecord,
      // What stands, as the sheet's head says it (a floor that read none in words, never a zero).
      status: standingWords(p.hidden, preparing),
      tone: 'quiet',
      ...(!preparing && p.hidden.total > 0
        ? { second: hiddenKinds(p.hidden) }
        : opts.presence === 'failed' && { second: WORDS.recordOthersFailed }),
      buttons: [],
      review: true,
    });
  }
  return rows;
}

/**
 * "2 reports · 2 comments": each kind with any, in a fixed order. No photos: they have no verdicts.
 * Under a cap each kind's count is a floor too ("300+ reports"), never an exact number.
 */
export const hiddenKinds = (hidden: PersonRead['hidden']): string =>
  kindsLine(hidden.byKind, hidden.capped);

/** Every button a set of rows draws, menu items included — for the property tests. */
export function allButtons(rows: readonly LeverRow[]): LeverButton[] {
  return rows.flatMap((r) => r.buttons);
}
