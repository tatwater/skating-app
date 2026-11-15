import { actionLabel } from '../../shell/actionLabels';
import {
  type ActionRow,
  dateWords,
  firstName,
  personName,
  ROLE_ARTICLE,
  type Role,
} from './personModel';

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
  const who = label ?? 'an account';
  const m = (row.metadata ?? {}) as Meta;
  let words: string;
  if (row.targetType !== 'user') {
    words = `${actionLabel(row.action, row.targetType)}${label !== undefined ? ` · ${label}` : ''}`;
  } else {
    switch (row.action) {
      case 'suspend':
        words =
          typeof m.suspendedUntil === 'number'
            ? `Suspended ${who} until ${dateWords(m.suspendedUntil, now, timeZone)}`
            : `Suspended ${who}`;
        break;
      case 'ban':
        words = `Banned ${who}`;
        break;
      case 'unban':
        words =
          m.prev?.status === 'banned'
            ? `Lifted the ban on ${who}`
            : m.prev?.status === 'suspended'
              ? `Lifted the suspension on ${who}`
              : `Lifted a ban or suspension on ${who}`;
        break;
      case 'set_posting_permission':
        if (m.permission === 'bounties') {
          words =
            m.limit === null || m.limit === undefined
              ? `Put the bounty limit for ${who} back to the default`
              : `Set the bounty limit for ${who} to ${m.limit}`;
        } else if (m.permission === 'flagging') {
          words =
            m.allowed === true
              ? `Switched flagging back on for ${who}`
              : `Switched off flagging for ${who}`;
        } else if (m.permission !== undefined) {
          words = `${m.allowed === true ? 'Restored' : 'Restricted'} ${RIGHT_NOUN[m.permission]} for ${who}`;
        } else {
          words = `Changed posting rights for ${who}`;
        }
        break;
      case 'grant_role':
        words = `Made ${who} ${ROLE_ARTICLE[m.role ?? 'moderator']}`;
        break;
      case 'revoke_role':
        words = `Made ${who} ${ROLE_ARTICLE.member}`;
        break;
      case 'grant_ledger_editor':
        words = `Gave ${who} ledger editing`;
        break;
      case 'revoke_ledger_editor':
        words = `Took ledger editing from ${who}`;
        break;
      default:
        words = `${actionLabel(row.action, row.targetType)}${label !== undefined ? ` · ${label}` : ''}`;
    }
  }
  return row.undoesActionId !== undefined ? `${words} · an undo` : words;
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
  if (row.actor === null) return { name: 'System', via };
  const name = personName(row.actor);
  if (name === null) return { name: 'Name still being prepared', via };
  return { name: AUTHOR_ACTIONS.has(row.action) ? name : firstName(name), via };
}

/** "Undone · Sarah", naming who undid it when the row that did is on the page. */
export function undoneWords(row: ActionRow, rows: readonly ActionRow[]): string | null {
  if (row.undo.state !== 'undone') return null;
  const byId = row.undo.byActionId;
  const by = rows.find((r) => r.id === byId);
  const name = by?.actor ? personName(by.actor) : null;
  return name === null ? 'Undone' : `Undone · ${firstName(name)}`;
}
