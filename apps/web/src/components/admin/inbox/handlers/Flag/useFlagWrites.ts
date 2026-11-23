import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { useMutation } from 'convex/react';
import { useCallback, useMemo } from 'react';

import type { ToastManager } from '@/components/kit/toast';

import { said } from '../../../said';
import type { AuditTarget } from '../../../shell/actionLabels';
import type { Receipt } from '../../../shell/undo';
import { subjectOf } from './flagModel';
import type {
  AlertVerdictArgs,
  DismissArgs,
  FlagItem,
  InboxWriteResultData,
  RestoreArgs,
  TakeDownArgs,
} from './flagTypes';

/** The item's first flag's id, for a dismissal's Undo. */
type FlagFirstFlag = string | null;

import { FLAG_WORDS as W } from './flagWords';
import { twinStillShownLine } from './photoModel';
import { PHOTO_WORDS as P } from './photoWords';

/**
 * **The flag handler's one write path.** Each lever goes to its Inbox write (`inboxWrites.*`); a
 * refusal — the server's, a throw, a failed send — is one toast naming the item's subject, in the
 * server's own words, wherever the moderator is when it comes (D268), and the lever learns only that
 * it didn't land; a landing raises the receipt with its Undo when the write says it is undoable now
 * (`undoable: true` names the row and whether undoing it asks a reason, so no lookup), and with none
 * when it says not.
 *
 * - **Nothing optimistic**: the item's read moves by itself once the write lands.
 * - **The words of a refusal are never read here**: `said` reads them, into its toast.
 */

/** What a lever asks the server to do. */
export type FlagWrite =
  | { kind: 'dismiss'; reason?: string }
  | { kind: 'takeDown'; status: 'hidden' | 'removed'; reason: string }
  | { kind: 'alert'; verb: 'pin' | 'unpin' | 'retract'; reason: string }
  | { kind: 'restore'; reason?: string };

/** The four Inbox writes, as this path calls them (a story or a test fakes them). */
export type FlagServer = {
  dismissFlags: (args: DismissArgs) => Promise<InboxWriteResultData>;
  takeDown: (args: TakeDownArgs) => Promise<InboxWriteResultData>;
  alertVerdict: (args: AlertVerdictArgs) => Promise<InboxWriteResultData>;
  restoreAndDismiss: (args: RestoreArgs) => Promise<InboxWriteResultData>;
};

/** The real server: the four mutations. */
export function useFlagServer(): FlagServer {
  const dismissFlags = useMutation(api.inboxWrites.dismissFlags);
  const takeDown = useMutation(api.inboxWrites.takeDown);
  const alertVerdict = useMutation(api.inboxWrites.alertVerdict);
  const restoreAndDismiss = useMutation(api.inboxWrites.restoreAndDismiss);
  return useMemo(
    () => ({ dismissFlags, takeDown, alertVerdict, restoreAndDismiss }),
    [dismissFlags, takeDown, alertVerdict, restoreAndDismiss],
  );
}

/** What the receipt's Undo is about: the content for a takedown or a verdict, the first flag else. */
export function undoTargetOf(
  item: Pick<FlagItem, 'target'>,
  write: FlagWrite,
  first: FlagFirstFlag,
): { targetType: AuditTarget; targetId: string } {
  if (write.kind === 'dismiss' || !item.target.exists) {
    return { targetType: 'contentFlag', targetId: first ?? item.target.targetId };
  }
  const t = item.target.targetType;
  const targetType: AuditTarget = t === 'accessAlert' ? 'accessAlert' : (t as AuditTarget);
  return { targetType, targetId: item.target.targetId };
}

/** The receipt's title for a write that landed (its count is the description's). */
export function receiptTitle(write: FlagWrite): string {
  switch (write.kind) {
    case 'dismiss':
      return W.receipt.dismissed;
    case 'takeDown':
      return write.status === 'hidden' ? W.receipt.hidden : W.receipt.removed;
    case 'alert':
      return write.verb === 'pin'
        ? W.receipt.pinned
        : write.verb === 'unpin'
          ? W.receipt.unpinned
          : W.receipt.retracted;
    case 'restore':
      return W.receipt.restored;
  }
}

/**
 * What a photo's receipt says the write did to the photo (the dev proof's truth: off its link and
 * shown to no one, never "gone everywhere"; and, when the same image is still shown on another
 * photo, that it stays up there); `null` for any other subject or write.
 */
export function photoReceiptLine(item: Pick<FlagItem, 'target'>, write: FlagWrite): string | null {
  if (!item.target.exists || item.target.targetType !== 'photo') return null;
  switch (write.kind) {
    case 'takeDown': {
      const line = write.status === 'hidden' ? P.receipt.hidden : P.receipt.removed;
      const twins = twinStillShownLine(item.target.photo);
      return twins === null ? line : `${line} · ${twins}`;
    }
    case 'restore':
      return P.receipt.restored;
    default:
      return null;
  }
}

/**
 * What a takedown or an alert's verdict closed: every open flag on the content, every lane's — so
 * the count may hold flags beyond this item's, and says how many ("3 flags closed, 2 in other lanes").
 */
export function closedWords(
  item: Pick<FlagItem, 'flags'>,
  flagsClosed: number,
  /** A dismissal, a restore or a pin: its flags close dismissed; every other lever, actioned. */
  dismissed = false,
  /** A takedown or an alert's verdict reaches every lane; a dismissal or a restore only this item. */
  acrossLanes = true,
): string {
  const here = item.flags.filter((f) => f.status === 'open').length;
  const elsewhere = acrossLanes ? Math.max(0, flagsClosed - here) : 0;
  return dismissed
    ? W.dismissesAcross(flagsClosed, elsewhere)
    : W.closesAcross(flagsClosed, elsewhere);
}

/** Whether a write's flags close dismissed (it sides with the content) rather than actioned. */
export const dismisses = (write: FlagWrite): boolean =>
  write.kind === 'dismiss' ||
  write.kind === 'restore' ||
  (write.kind === 'alert' && write.verb === 'pin');

/** The args for each write: a reason only where one was typed. */
export function argsOf(itemId: string, write: FlagWrite) {
  const id = itemId as Id<'inboxItems'>;
  const typed = (r: string | undefined) => (r !== undefined && r.trim() !== '' ? r.trim() : null);
  switch (write.kind) {
    case 'dismiss': {
      const reason = typed(write.reason);
      // A dismissal's reason is optional (D226: dismissing takes nothing away), so none typed means
      // the server's default.
      return {
        kind: 'dismiss',
        args: { itemId: id, ...(reason !== null && { reason }) },
      } as const;
    }
    case 'takeDown':
      return {
        kind: 'takeDown',
        args: { itemId: id, status: write.status, reason: write.reason.trim() },
      } as const;
    case 'alert':
      return {
        kind: 'alert',
        args: { itemId: id, verb: write.verb, reason: write.reason.trim() },
      } as const;
    case 'restore': {
      const reason = typed(write.reason);
      return {
        kind: 'restore',
        args: { itemId: id, ...(reason !== null && { reason }) },
      } as const;
    }
  }
}

export function useFlagWrites({
  item,
  server,
  announce,
  here,
  manager,
}: {
  item: FlagItem;
  server: FlagServer;
  announce: (receipt: Receipt, here?: () => boolean) => Promise<void>;
  /** The caller's binding (this item still open): a receipt never shows over another item. */
  here?: () => boolean;
  manager?: ToastManager;
}) {
  return useCallback(
    async (write: FlagWrite): Promise<boolean> => {
      const subject = subjectOf(item);
      const call = argsOf(item.itemId, write);
      const sent = await said(
        (): Promise<InboxWriteResultData> => {
          switch (call.kind) {
            case 'dismiss':
              return server.dismissFlags(call.args);
            case 'takeDown':
              return server.takeDown(call.args);
            case 'alert':
              return server.alertVerdict(call.args);
            case 'restore':
              return server.restoreAndDismiss(call.args);
          }
        },
        (why) => ({ title: W.notSaved(subject), description: why }),
        { ...(manager !== undefined && { manager }) },
      );
      if (!sent.landed) return false;
      const answered = sent.value;
      const first = (item.flags.find((f) => f.status === 'open') ?? item.flags[0])?.flagId ?? null;
      const description = [
        answered.flagsClosed > 0
          ? closedWords(
              item,
              answered.flagsClosed,
              dismisses(write),
              write.kind === 'takeDown' || write.kind === 'alert',
            )
          : null,
        photoReceiptLine(item, write),
      ]
        .filter((x): x is string => x !== null)
        .join(' · ');
      const undo: Pick<Receipt, 'actionId' | 'undoNeedsReason' | 'undoable'> = answered.undoable
        ? { actionId: answered.actionId, undoNeedsReason: answered.undoNeedsReason }
        : { actionId: answered.actionId, undoable: false };
      void announce(
        {
          title: receiptTitle(write),
          ...(description !== '' && { description }),
          target: undoTargetOf(item, write, first),
          ...undo,
          ...(subject !== '' && { subject }),
        },
        here,
      ).catch(() => {});
      return true;
    },
    [item, server, announce, here, manager],
  );
}
