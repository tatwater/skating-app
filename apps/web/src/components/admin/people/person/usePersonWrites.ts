import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { useMutation } from 'convex/react';
import { useCallback } from 'react';

import { errorText } from '../../adminUi';
import { type Receipt, useUndo } from '../../shell/undo';
import type { PersonAction } from './levers';
import { WORDS } from './personWords';
import { receiptFor } from './receipts';

/**
 * **The page's one write path.** Each lever's action goes to its server write; on success the
 * shell's undo toast shows the receipt, and on refusal the server's own words come back to the
 * control that asked.
 *
 * - **Nothing optimistic**: it waits for the server, and the reads move on their own once the write
 *   lands.
 * - **The toast's Undo is the shell's**: these writes return the person's id, not the audit row's,
 *   so the receipt names its target (`user`, the person) and the shell asks the server for the
 *   caller's own newest action on it (`undo.latestOwn`), offering Undo — ⌘Z, its countdown — only
 *   while the server would accept it. History offers the same row's Undo after.
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
    async (action: PersonAction): Promise<string | null> => {
      if (person === null) return WORDS.personFailed;
      const userId = person.userId as Id<'profiles'>;
      // What the write answered: today the person's id (or nothing); once each write returns
      // `{ actionId }`, the receipt carries it (below) and the toast needs no lookup.
      let answered: unknown;
      try {
        switch (action.kind) {
          case 'right':
            answered = await setPostingPermission({
              userId,
              permission: action.permission,
              allowed: action.allowed,
              ...(action.reason !== undefined && { reason: action.reason }),
            });
            break;
          case 'bountyLimit':
            answered = await setBountyPostLimit({
              userId,
              ...(action.limit !== null && { limit: action.limit }),
              ...(action.reason !== undefined && { reason: action.reason }),
            });
            break;
          case 'suspend':
            answered = await suspendUser({
              userId,
              reason: action.reason,
              suspendedUntil: action.until,
            });
            break;
          case 'lift':
            answered = await unbanUser({ userId });
            break;
          case 'ban':
            answered = await banUser({ userId, reason: action.reason });
            break;
          case 'role': {
            const reason = action.reason !== undefined ? { reason: action.reason } : {};
            answered =
              action.role === 'member'
                ? await revokeRole({ userId, ...reason })
                : await grantRole({ userId, role: action.role, ...reason });
            break;
          }
          case 'ledger':
            answered = action.grant
              ? await grantEditor({ userId })
              : await revokeEditor({ userId, reason: action.reason ?? '' });
            break;
        }
      } catch (err) {
        return errorText(err);
      }
      // The write landed: say so now. The receipt follows on its own — the shell's toast shows once
      // its undo lookup returns (a moment), with Undo while the server offers one; a lookup that
      // fails leaves the receipt without Undo (History keeps the row). It never holds this result.
      const actionId = actionIdOf(answered);
      const receipt: Receipt = {
        ...receiptFor(action, person, now),
        target: { targetType: 'user', targetId: userId },
        ...(actionId !== null && { actionId }),
        ...(actionId !== null &&
          undoNeedsReasonOf(answered) !== null && {
            undoNeedsReason: undoNeedsReasonOf(answered) === true,
          }),
      };
      void announce(receipt).catch(() => {});
      return null;
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
