import { actionLabel } from '../../shell/actionLabels';
import {
  type ActionRow,
  dateWords,
  firstName,
  personName,
  ROLE_ARTICLE,
  type Role,
} from './personModel';
import { WORDS } from './personWords';

/**
 * A History or Decisions row in words: the verb and its object — the target's name where the read
 * gives it (`targetLabel`) — then the reason when one was typed (a give-back's default is left out),
 * and who acted, on a line of their own. Pure.
 */

type Meta = {
  permission?: 'reports' | 'hazards' | 'comments' | 'flagging' | 'bounties';
  allowed?: boolean;
  limit?: number | null;
  role?: Role;
  suspendedUntil?: number;
  prev?: { status?: string };
};

const RIGHT_NOUN = { reports: 'reports', hazards: 'hazards', comments: 'comments' } as const;

/** The row's sentence, without its reason. */
export function rowSentence(row: ActionRow, now: number, timeZone?: string): string {
  const label = row.targetLabel;
  const who = label ?? WORDS.anAccount;
  const m = (row.metadata ?? {}) as Meta;
  let words: string;
  if (row.targetType !== 'user') {
    words = `${actionLabel(row.action, row.targetType)}${label !== undefined ? ` · ${label}` : ''}`;
  } else {
    switch (row.action) {
      case 'suspend':
        words =
          typeof m.suspendedUntil === 'number'
            ? WORDS.suspendedUntil(who, dateWords(m.suspendedUntil, now, timeZone))
            : WORDS.suspendedWho(who);
        break;
      case 'ban':
        words = WORDS.bannedWho(who);
        break;
      case 'unban':
        words =
          m.prev?.status === 'banned'
            ? WORDS.liftedBan(who)
            : m.prev?.status === 'suspended'
              ? WORDS.liftedSuspension(who)
              : WORDS.liftedEither(who);
        break;
      case 'set_posting_permission':
        if (m.permission === 'bounties') {
          words =
            m.limit === null || m.limit === undefined
              ? WORDS.bountyDefaultFor(who)
              : WORDS.bountySetFor(who, m.limit);
        } else if (m.permission === 'flagging') {
          words = m.allowed === true ? WORDS.flaggingOnFor(who) : WORDS.flaggingOffFor(who);
        } else if (m.permission !== undefined) {
          words =
            m.allowed === true
              ? WORDS.restoredFor(RIGHT_NOUN[m.permission], who)
              : WORDS.restrictedFor(RIGHT_NOUN[m.permission], who);
        } else {
          words = WORDS.rightsChangedFor(who);
        }
        break;
      case 'grant_role':
        words = WORDS.madeRole(who, ROLE_ARTICLE[m.role ?? 'moderator']);
        break;
      case 'revoke_role':
        words = WORDS.madeRole(who, ROLE_ARTICLE.member);
        break;
      case 'grant_ledger_editor':
        words = WORDS.gaveLedger(who);
        break;
      case 'revoke_ledger_editor':
        words = WORDS.tookLedger(who);
        break;
      default:
        words = `${actionLabel(row.action, row.targetType)}${label !== undefined ? ` · ${label}` : ''}`;
    }
  }
  return row.undoesActionId !== undefined ? `${words} · ${WORDS.anUndo}` : words;
}

/** The typed reason, or `null` for a give-back the server filled in. */
export function rowReason(row: ActionRow): string | null {
  const reason = row.reason.trim();
  return row.reasonGiven && reason !== '' ? reason : null;
}

/** Verbs a skater does to their own content: their row names them in full, not as staff. */
const AUTHOR_ACTIONS: ReadonlySet<string> = new Set([
  'author_delete',
  'author_resolve_access_alert',
]);

/**
 * Who acted: *System* for the machines; staff by first name, a skater acting on their own content
 * in full; a person whose row hasn't been written yet is said so.
 */
export function rowActor(row: ActionRow): { name: string; via: string | null } {
  const via = row.via ?? null;
  if (row.actor === null) return { name: WORDS.system, via };
  const name = personName(row.actor);
  if (name === null) return { name: WORDS.nameNotReady, via };
  return { name: AUTHOR_ACTIONS.has(row.action) ? name : firstName(name), via };
}

/** "Undone · Sarah", naming who undid it when the row that did is on the page. */
export function undoneWords(row: ActionRow, rows: readonly ActionRow[]): string | null {
  if (row.undo.state !== 'undone') return null;
  const byId = row.undo.byActionId;
  const by = rows.find((r) => r.id === byId);
  const name = by?.actor ? personName(by.actor) : null;
  return name === null ? WORDS.undone : `${WORDS.undone} · ${firstName(name)}`;
}
