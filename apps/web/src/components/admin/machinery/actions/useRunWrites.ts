import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { useMutation } from 'convex/react';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';
import { useCallback, useMemo } from 'react';

import type { ToastManager } from '@/components/kit/toast';

import { said } from '../../said';
import { type Receipt, useUndo } from '../../shell/undo';
import { clock } from '../corpus/runFormat';
import { ACTION_WORDS as W } from '../words/runWords';

/**
 * **The run actions' one write path.** *Mark failed*, *Wait 30 minutes* and (behind the switch in
 * `actionsShown.ts`) *Stop* go to their Machinery writes; a refusal — the server's, a throw, a failed
 * send — is one toast naming the run, in the server's own words, wherever the operator is when it
 * comes (D268), and the caller learns only that it didn't land; a landing raises the receipt with
 * its Undo, which runs the write's inverse on the server (`reopenRun`, `stopWaitingOnRun`,
 * `withdrawRunStop`) through the console's undo — none asks a reason, since nothing a skater sees
 * changes.
 *
 * - **Nothing optimistic**: the run's read moves by itself once the write lands.
 * - **The words of a refusal are never read here**: `said` reads them, into its toast.
 */

/** The run an action is on: its row and the name its toasts give it. */
export type RunTarget = { runId: Id<'importRuns'>; title: string };

type Mutation<K extends 'markRunFailed' | 'waitOnRun' | 'requestRunStop'> = (
  args: FunctionArgs<(typeof api.machineryWrites)[K]>,
) => Promise<FunctionReturnType<(typeof api.machineryWrites)[K]>>;

/** The three writes, as this path calls them (a story or a test fakes them). */
export type RunServer = {
  markRunFailed: Mutation<'markRunFailed'>;
  waitOnRun: Mutation<'waitOnRun'>;
  requestRunStop: Mutation<'requestRunStop'>;
};

/** The real server: the three mutations. */
export function useRunServer(): RunServer {
  const markRunFailed = useMutation(api.machineryWrites.markRunFailed);
  const waitOnRun = useMutation(api.machineryWrites.waitOnRun);
  const requestRunStop = useMutation(api.machineryWrites.requestRunStop);
  return useMemo(
    () => ({ markRunFailed, waitOnRun, requestRunStop }),
    [markRunFailed, waitOnRun, requestRunStop],
  );
}

/** What the actions call: each resolves whether its write landed. */
export type RunWrites = {
  markFailed: (target: RunTarget, reason: string) => Promise<boolean>;
  wait: (target: RunTarget) => Promise<boolean>;
  stop: (target: RunTarget) => Promise<boolean>;
};

export function useRunWrites({
  server,
  announce,
  manager,
  clockNow = Date.now,
  timeZone,
}: {
  server: RunServer;
  announce: (receipt: Receipt) => Promise<void>;
  manager?: ToastManager;
  /** The press's instant, sent with *Wait* (the server checks the stall by its own clock too). */
  clockNow?: () => number;
  timeZone?: string;
}): RunWrites {
  const options = useMemo(() => (manager !== undefined ? { manager } : {}), [manager]);
  const receipt = useCallback(
    (target: RunTarget, actionId: string, title: string, description: string) => {
      void announce({
        title,
        description,
        subject: target.title,
        target: { targetType: 'importRun', targetId: target.runId },
        actionId,
        undoNeedsReason: false,
      }).catch(() => {});
    },
    [announce],
  );

  const markFailed = useCallback(
    async (target: RunTarget, reason: string) => {
      const sent = await said(
        () => server.markRunFailed({ runId: target.runId, reason: reason.trim() }),
        (why) => ({ title: W.notMarked(target.title), description: why }),
        options,
      );
      if (!sent.landed) return false;
      receipt(target, sent.value.actionId, W.marked, W.markedLine);
      return true;
    },
    [server, options, receipt],
  );

  const wait = useCallback(
    async (target: RunTarget) => {
      const sent = await said(
        () => server.waitOnRun({ runId: target.runId, now: clockNow() }),
        (why) => ({ title: W.notWaited(target.title), description: why }),
        options,
      );
      if (!sent.landed) return false;
      receipt(
        target,
        sent.value.actionId,
        W.waited,
        W.waitedLine(clock(sent.value.until, timeZone)),
      );
      return true;
    },
    [server, options, receipt, clockNow, timeZone],
  );

  const stop = useCallback(
    async (target: RunTarget) => {
      const sent = await said(
        () => server.requestRunStop({ runId: target.runId }),
        (why) => ({ title: W.notStopped(target.title), description: why }),
        options,
      );
      if (!sent.landed) return false;
      receipt(target, sent.value.actionId, W.stopAsked, W.stopAskedLine);
      return true;
    },
    [server, options, receipt],
  );

  return useMemo(() => ({ markFailed, wait, stop }), [markFailed, wait, stop]);
}

/**
 * The page's writes, wired: the real mutations and the console's undo. The route calls it once and
 * hands the result to the campaign or run page (stories hand theirs a fake).
 */
export function useLiveRunWrites(timeZone?: string): RunWrites {
  const server = useRunServer();
  const { announce } = useUndo();
  return useRunWrites({ server, announce, ...(timeZone !== undefined && { timeZone }) });
}
