import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { useMutation } from 'convex/react';
import { useCallback } from 'react';

import { errorText } from '../../adminUi';
import { useUndo } from '../../shell/undo';
import type { PersonAction } from './levers';
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
      if (person === null) return 'This person couldn’t be read';
      const userId = person.userId as Id<'profiles'>;
      try {
        switch (action.kind) {
          case 'right':
            await setPostingPermission({
              userId,
              permission: action.permission,
              allowed: action.allowed,
              ...(action.reason !== undefined && { reason: action.reason }),
            });
            break;
          case 'bountyLimit':
            await setBountyPostLimit({
              userId,
              ...(action.limit !== null && { limit: action.limit }),
              ...(action.reason !== undefined && { reason: action.reason }),
            });
            break;
          case 'suspend':
            await suspendUser({ userId, reason: action.reason, suspendedUntil: action.until });
            break;
          case 'lift':
            await unbanUser({ userId });
            break;
          case 'ban':
            await banUser({ userId, reason: action.reason });
            break;
          case 'role': {
            const reason = action.reason !== undefined ? { reason: action.reason } : {};
            if (action.role === 'member') await revokeRole({ userId, ...reason });
            else await grantRole({ userId, role: action.role, ...reason });
            break;
          }
          case 'ledger':
            if (action.grant) await grantEditor({ userId });
            else await revokeEditor({ userId, reason: action.reason ?? '' });
            break;
        }
      } catch (err) {
        return errorText(err);
      }
      // The receipt, with its Undo while the server offers one. A failure to ask is the shell's
      // to absorb: the receipt still shows, without its Undo (History keeps the row).
      await announce({
        ...receiptFor(action, person, now),
        target: { targetType: 'user', targetId: userId },
      });
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
