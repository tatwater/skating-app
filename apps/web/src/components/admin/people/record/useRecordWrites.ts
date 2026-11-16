import type { Id } from '@skating/convex/dataModel';
import { useCallback } from 'react';

import { errorText } from '../../adminUi';
import type { Receipt } from '../../shell/undo';
import {
  type ItemRead,
  type RecordSubject,
  type RecordWrite,
  receiptWords,
  type Target,
} from './recordModel';
import type { RecordKind } from './recordWords';
import { RECORD_WORDS as W } from './recordWords';

/**
 * **The record sheet's one write path.** Each lever goes to its server write — Restore and Hide
 * again (`moderation.setModerationStatus`), Overturn (`overturnVerdict`), Keep on the record
 * (`keepOnRecord`) — and on success the shell's toast shows the receipt; on refusal the server's own
 * words come back to the control that asked.
 *
 * - **Nothing optimistic**: it waits for the server; the reads move on their own once it lands.
 * - **Undo only when the write says so**: a write that answers `undoable: true` names its row and
 *   whether the undo asks a reason, and the toast offers it with no lookup; `undoable: false` — or
 *   an overturn, which has no undo — shows the receipt with none.
 * - **A restore keeps its row** in Standing for the sitting (`onRestored`), with the same undo.
 */

/** What the server's writes answer, as this path reads them. */
export type RecordWriteResult = {
  targetId: string;
  actionId: string;
} & ({ undoable: true; undoNeedsReason: boolean } | { undoable: false });

type ContentType = Exclude<RecordKind, 'accessAlert'>;

/** The three server writes, as the sheet calls them (a story or a test fakes them). */
export type RecordServer = {
  setStatus: (args: {
    targetType: ContentType;
    targetId: string;
    status: 'visible' | 'hidden';
    reason?: string;
    withReportIds?: Id<'reports'>[];
  }) => Promise<RecordWriteResult>;
  overturn: (args: {
    targetType: RecordKind;
    targetId: string;
    reason?: string;
  }) => Promise<{ targetId: string; actionId: string; eraseAt: number | null }>;
  keep: (args: {
    targetType: RecordKind;
    targetId: string;
    reason: string;
  }) => Promise<RecordWriteResult>;
};

export function useRecordWrites({
  server,
  announce,
  subject,
  placeOf,
  comesBackOf,
  onRestored,
  now,
}: {
  server: RecordServer;
  announce: (receipt: Receipt) => Promise<void>;
  subject: RecordSubject;
  /** Where the item is, for its receipt: the body, or a comment's Report. */
  placeOf: (target: Target) => string | null;
  /** What a Report's restore brings back, as the pane read it, for its receipt. */
  comesBackOf?: (target: Target) => ItemRead['comesBack'] | undefined;
  /** A restore landed: keep its row in Standing for the sitting. */
  onRestored: (target: Target, result: RecordWriteResult) => void;
  now: number;
}) {
  return useCallback(
    async (target: Target, write: RecordWrite): Promise<string | null> => {
      const { targetType, targetId } = target;
      let answered: RecordWriteResult | { actionId: string; eraseAt: number | null };
      try {
        switch (write.kind) {
          case 'restore':
          case 'hideAgain': {
            // Only a moderator's status levers reach here, and an alert has none (its axis is its
            // retraction): the server's `can` never offers Restore or Hide again on one.
            /* v8 ignore next */
            if (targetType === 'accessAlert') return W.somethingWrong;
            answered = await server.setStatus({
              targetType,
              targetId,
              status: write.kind === 'restore' ? 'visible' : 'hidden',
              ...(write.kind === 'hideAgain' && { reason: write.reason }),
              ...(write.kind === 'restore' &&
                write.withReportIds !== undefined && {
                  withReportIds: write.withReportIds as Id<'reports'>[],
                }),
            });
            break;
          }
          case 'overturn':
            answered = await server.overturn({
              targetType,
              targetId,
              ...(write.reason !== undefined && { reason: write.reason }),
            });
            break;
          case 'keep':
            answered = await server.keep({ targetType, targetId, reason: write.reason });
            break;
        }
      } catch (err) {
        return errorText(err);
      }
      const words = receiptWords(
        write,
        {
          kind: targetType,
          place: placeOf(target),
          subject,
          ...(comesBackOf !== undefined && { comesBack: comesBackOf(target) ?? null }),
        },
        'eraseAt' in answered ? { eraseAt: answered.eraseAt } : {},
        now,
      );
      const undo: Pick<Receipt, 'actionId' | 'undoNeedsReason' | 'undoable'> =
        'undoable' in answered && answered.undoable
          ? { actionId: answered.actionId, undoNeedsReason: answered.undoNeedsReason }
          : { actionId: answered.actionId, undoable: false };
      // The write landed: say so now; the receipt follows on its own and never holds this result.
      void announce({ ...words, target: { targetType, targetId }, ...undo }).catch(() => {});
      if (write.kind === 'restore' && 'undoable' in answered) onRestored(target, answered);
      return null;
    },
    [server, announce, subject, placeOf, comesBackOf, onRestored, now],
  );
}
