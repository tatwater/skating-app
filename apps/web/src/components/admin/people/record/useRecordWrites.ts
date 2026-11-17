import type { Id } from '@skating/convex/dataModel';
import { useCallback } from 'react';

import type { ToastManager } from '@/components/kit/toast';

import { said } from '../../said';
import type { Receipt } from '../../shell/undo';
import {
  type ItemRead,
  type RecordSubject,
  type RecordWrite,
  receiptWords,
  subjectName,
  type Target,
} from './recordModel';
import type { RecordKind } from './recordWords';
import { RECORD_WORDS as W } from './recordWords';

/**
 * **The record sheet's one write path.** Each lever goes to its server write — Restore and Hide
 * again (`moderation.setModerationStatus`), Overturn (`overturnVerdict`), Keep on the record
 * (`keepOnRecord`) — and on success the shell's toast shows the receipt; a refusal is a toast naming
 * the person, in the server's own words (D268), and the control that asked learns only that it
 * didn't land.
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
  here,
  manager,
}: {
  server: RecordServer;
  announce: (receipt: Receipt, here?: () => boolean) => Promise<void>;
  subject: RecordSubject;
  /** Where the item is, for its receipt: the body, or a comment's Report. */
  placeOf: (target: Target) => string | null;
  /** What a Report's restore brings back, as the pane read it, for its receipt. */
  comesBackOf?: (target: Target) => ItemRead['comesBack'] | undefined;
  /**
   * The caller's binding (the person's page still mounted): asked once the write has answered, so a
   * receipt never shows over another person's page (the shell's rule).
   */
  here?: () => boolean;
  /**
   * A restore landed: keep its row in Standing for the sitting — and, for a Post restored with
   * chosen Reports, theirs (`withReportIds`, what the write restored with it).
   */
  onRestored: (target: Target, result: RecordWriteResult, withReportIds: readonly string[]) => void;
  now: number;
  /** The toast queue a refusal is said in: the app's, unless a story draws its own. */
  manager?: ToastManager;
}) {
  return useCallback(
    async (target: Target, write: RecordWrite): Promise<boolean> => {
      const { targetType, targetId } = target;
      const sent = await said(
        async (): Promise<RecordWriteResult | { actionId: string; eraseAt: number | null }> => {
          switch (write.kind) {
            case 'restore':
            case 'hideAgain': {
              // Only a moderator's status levers reach here, and an alert has none (its axis is its
              // retraction): the server's `can` never offers Restore or Hide again on one.
              /* v8 ignore next */
              if (targetType === 'accessAlert') throw new Error(W.somethingWrong);
              return server.setStatus({
                targetType,
                targetId,
                status: write.kind === 'restore' ? 'visible' : 'hidden',
                ...(write.kind === 'hideAgain' && { reason: write.reason }),
                ...(write.kind === 'restore' &&
                  write.withReportIds !== undefined && {
                    withReportIds: write.withReportIds as Id<'reports'>[],
                  }),
              });
            }
            case 'overturn':
              return server.overturn({
                targetType,
                targetId,
                ...(write.reason !== undefined && { reason: write.reason }),
              });
            case 'keep':
              return server.keep({ targetType, targetId, reason: write.reason });
          }
        },
        (why) => ({ title: W.refusalOf(subjectName(subject)), description: why }),
        { ...(manager !== undefined && { manager }) },
      );
      if (!sent.landed) return false;
      const answered = sent.value;
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
      // Restore and Hide again don't name the person: the receipt names them after its title, as
      // every receipt that may show over another page does. Overturn and Keep name them already.
      const named =
        write.kind === 'restore' || write.kind === 'hideAgain' ? subjectName(subject) : undefined;
      void announce(
        {
          ...words,
          target: { targetType, targetId },
          ...undo,
          ...(named !== undefined && named !== '' && { subject: named }),
        },
        here,
      ).catch(() => {});
      if (write.kind === 'restore' && 'undoable' in answered)
        onRestored(target, answered, write.withReportIds ?? []);
      return true;
    },
    [server, announce, subject, placeOf, comesBackOf, onRestored, now, here, manager],
  );
}
