import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { useMutation } from 'convex/react';
import { useCallback } from 'react';

import { said, sayRefusal } from '../../said';
import { type Receipt, useUndo } from '../../shell/undo';
import { RECORD_WORDS } from '../record/recordWords';
import type { PersonAction } from './levers';
import { WORDS } from './personWords';
import { receiptFor } from './receipts';

/**
 * **The page's one write path.** Each lever's action goes to its server write; on success the
 * shell's undo toast shows the receipt; a refusal is a toast naming the person, in the server's own
 * words, wherever the moderator is when it comes (D268) — the control that asked learns only that it
 * didn't land.
 *
 * - **Nothing optimistic**: it waits for the server, and the reads move on their own once the write
 *   lands.
 * - **The toast's Undo is the shell's**: the receipt names its target (`user`, the person). Today's
 *   writes return the person's id, not the audit row's, so the shell asks the server for the
 *   caller's own newest action on it (`undo.latestOwn`), offering Undo — ⌘Z, its countdown — only
 *   while the server would accept it; a write that answers `{ actionId, undoNeedsReason }` (the
 *   server follow-up) is taken at its word. History offers the same row's Undo after.
 */
export function usePersonWrites(
  person: {
    userId: string;
    displayName: string;
    defaultBountyLimit: number;
  } | null,
  now: number,
) {
  const setPostingPermission = useMutation(api.moderation.setPostingPermission);
  const setBountyPostLimit = useMutation(api.moderation.setBountyPostLimit);
  const suspendUser = useMutation(api.moderation.suspendUser);
  const unbanUser = useMutation(api.moderation.unbanUser);
  const banUser = useMutation(api.moderation.banUser);
  const grantRole = useMutation(api.admin.grantRole);
  const revokeRole = useMutation(api.admin.revokeRole);
  const grantEditor = useMutation(api.ledger.grantEditor);
  const revokeEditor = useMutation(api.ledger.revokeEditor);
  const { announce } = useUndo();

  return useCallback(
    async (action: PersonAction): Promise<boolean> => {
      if (person === null) {
        // Nothing was sent: the page has no person to write to.
        sayRefusal({ title: RECORD_WORDS.refusalOf(''), description: WORDS.personFailed });
        return false;
      }
      const userId = person.userId as Id<'profiles'>;
      // What the write answered: today the person's id (or nothing); once each write returns
      // `{ actionId }`, the receipt carries it (below) and the toast needs no lookup.
      const sent = await said(
        async (): Promise<unknown> => {
          switch (action.kind) {
            case 'right':
              return setPostingPermission({
                userId,
                permission: action.permission,
                allowed: action.allowed,
                ...(action.reason !== undefined && { reason: action.reason }),
              });
            case 'bountyLimit':
              return setBountyPostLimit({
                userId,
                ...(action.limit !== null && { limit: action.limit }),
                ...(action.reason !== undefined && { reason: action.reason }),
              });
            case 'suspend':
              return suspendUser({ userId, reason: action.reason, suspendedUntil: action.until });
            case 'lift':
              return unbanUser({ userId });
            case 'ban':
              return banUser({ userId, reason: action.reason });
            case 'role': {
              const reason = action.reason !== undefined ? { reason: action.reason } : {};
              return action.role === 'member'
                ? revokeRole({ userId, ...reason })
                : grantRole({ userId, role: action.role, ...reason });
            }
            case 'ledger':
              return action.grant
                ? grantEditor({ userId })
                : revokeEditor({ userId, reason: action.reason ?? '' });
          }
        },
        (why) => ({ title: RECORD_WORDS.refusalOf(person.displayName), description: why }),
      );
      if (!sent.landed) return false;
      const answered = sent.value;
      // The write landed: say so now. The receipt follows on its own — the shell's toast shows once
      // its undo lookup returns (a moment), with Undo while the server offers one; a lookup that
      // fails leaves the receipt without Undo (History keeps the row). It never holds this result.
      // Nothing changed, so nothing was written: say that, with no Undo and no lookup.
      if (changedOf(answered) === false) {
        void announce({
          title: WORDS.alreadySo(person.displayName),
          target: { targetType: 'user', targetId: userId },
          undoable: false,
        }).catch(() => {});
        return true;
      }
      const actionId = actionIdOf(answered);
      const undoNeedsReason = undoNeedsReasonOf(answered);
      const receipt: Receipt = {
        ...receiptFor(action, person, now),
        target: { targetType: 'user', targetId: userId },
        ...(actionId !== null && { actionId }),
        ...(actionId !== null && undoNeedsReason !== null && { undoNeedsReason }),
      };
      void announce(receipt).catch(() => {});
      return true;
    },
    [
      person,
      now,
      announce,
      setPostingPermission,
      setBountyPostLimit,
      suspendUser,
      unbanUser,
      banUser,
      grantRole,
      revokeRole,
      grantEditor,
      revokeEditor,
    ],
  );
}

/**
 * The audit row a write answered with, when it answers `{ actionId }` (the People server's
 * follow-up); `null` for today's writes, which return the person's id or nothing.
 */
export function actionIdOf(answered: unknown): string | null {
  if (typeof answered !== 'object' || answered === null) return null;
  const id = (answered as { actionId?: unknown }).actionId;
  return typeof id === 'string' ? id : null;
}

/**
 * Whether undoing the write takes something away, when the write answers it beside its row
 * (`{ actionId, undoNeedsReason }`); `null` when it doesn't say — then the toast asks the server.
 */
export function undoNeedsReasonOf(answered: unknown): boolean | null {
  if (typeof answered !== 'object' || answered === null) return null;
  const needs = (answered as { undoNeedsReason?: unknown }).undoNeedsReason;
  return typeof needs === 'boolean' ? needs : null;
}

/**
 * Whether the write changed the person, when it says (`changed`): `false` when it would have left
 * them exactly as they were, so the server wrote nothing; `null` when the answer doesn't say.
 */
export function changedOf(answered: unknown): boolean | null {
  if (typeof answered !== 'object' || answered === null) return null;
  const changed = (answered as { changed?: unknown }).changed;
  return typeof changed === 'boolean' ? changed : null;
}
