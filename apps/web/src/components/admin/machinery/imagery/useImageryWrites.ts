import { api } from '@skating/convex/api';
import { useMutation } from 'convex/react';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';
import { useCallback, useMemo } from 'react';

import type { ToastManager } from '@/components/kit/toast';

import { said } from '../../said';
import { type Receipt, useUndo } from '../../shell/undo';
import * as W from './imageryWords';

/**
 * **Machinery › Imagery's one write path** — *Start imagery*, *Pause* / *Resume*, the poll's *Run
 * now*, *Retry failed* and *Try again now*, each to its `machineryImagery` write. A refusal — the
 * server's, a throw, a failed send — is one toast naming what wasn't done, in the server's own words,
 * wherever the operator is (D268); the caller learns only that it didn't land. A landing raises the
 * receipt: Start and Pause with their Undo (each the other's inverse on the server, *Resume* after a
 * *Pause*), the three triggers with none (nothing a person would undo; the receipt says what it did).
 *
 * - **Nothing optimistic**: the page's read moves by itself once a write lands.
 * - **The words of a refusal are never read here**: `said` reads them, into its toast.
 */

type Write<K extends 'startImagery' | 'pauseImagery' | 'pollNow' | 'retryFailed' | 'tryAgainNow'> =
  (
    args: FunctionArgs<(typeof api.machineryImagery)[K]>,
  ) => Promise<FunctionReturnType<(typeof api.machineryImagery)[K]>>;

/** The five writes, as this path calls them (a story or a test fakes them). */
export type ImageryServer = {
  startImagery: Write<'startImagery'>;
  pauseImagery: Write<'pauseImagery'>;
  pollNow: Write<'pollNow'>;
  retryFailed: Write<'retryFailed'>;
  tryAgainNow: Write<'tryAgainNow'>;
};

/** The real server: the five mutations. */
export function useImageryServer(): ImageryServer {
  const startImagery = useMutation(api.machineryImagery.startImagery);
  const pauseImagery = useMutation(api.machineryImagery.pauseImagery);
  const pollNow = useMutation(api.machineryImagery.pollNow);
  const retryFailed = useMutation(api.machineryImagery.retryFailed);
  const tryAgainNow = useMutation(api.machineryImagery.tryAgainNow);
  return useMemo(
    () => ({ startImagery, pauseImagery, pollNow, retryFailed, tryAgainNow }),
    [startImagery, pauseImagery, pollNow, retryFailed, tryAgainNow],
  );
}

/** What the page calls: each resolves whether its write landed. */
export type ImageryWrites = {
  /** Start a season's imagery; `resume` words it as *Resume* (after a pause). */
  start: (season: string, resume?: boolean) => Promise<boolean>;
  pause: (season: string) => Promise<boolean>;
  pollNow: (season: string) => Promise<boolean>;
  retryFailed: (season: string) => Promise<boolean>;
  tryAgainNow: (season: string) => Promise<boolean>;
};

export function useImageryWrites({
  server,
  announce,
  manager,
}: {
  server: ImageryServer;
  announce: (receipt: Receipt) => Promise<void>;
  manager?: ToastManager;
}): ImageryWrites {
  const options = useMemo(() => (manager !== undefined ? { manager } : {}), [manager]);
  const receipt = useCallback(
    (season: string, actionId: string, title: string, description: string, undoable: boolean) => {
      void announce({
        title,
        description,
        target: { targetType: 'imagerySeason', targetId: season },
        actionId,
        undoNeedsReason: false,
        ...(!undoable && { undoable: false as const }),
      }).catch(() => {});
    },
    [announce],
  );

  const start = useCallback(
    async (season: string, resume = false) => {
      const sent = await said(
        () => server.startImagery({ season }),
        (why) => ({
          title: resume ? W.NOT_RESUMED_TOAST : W.NOT_STARTED_TOAST,
          description: why,
        }),
        options,
      );
      if (!sent.landed) return false;
      receipt(
        season,
        sent.value.actionId,
        resume ? W.RESUMED_TOAST : W.STARTED_TOAST,
        W.STARTED_LINE,
        true,
      );
      return true;
    },
    [server, options, receipt],
  );

  const pause = useCallback(
    async (season: string) => {
      const sent = await said(
        () => server.pauseImagery({ season }),
        (why) => ({ title: W.NOT_PAUSED_TOAST, description: why }),
        options,
      );
      if (!sent.landed) return false;
      receipt(season, sent.value.actionId, W.PAUSED_TOAST, W.PAUSED_LINE, true);
      return true;
    },
    [server, options, receipt],
  );

  const pollNow = useCallback(
    async (season: string) => {
      const sent = await said(
        () => server.pollNow({}),
        (why) => ({ title: W.NOT_POLLED_TOAST, description: why }),
        options,
      );
      if (!sent.landed) return false;
      receipt(season, sent.value.actionId, W.POLLED_TOAST, W.POLLED_LINE, false);
      return true;
    },
    [server, options, receipt],
  );

  const retryFailed = useCallback(
    async (season: string) => {
      const sent = await said(
        () => server.retryFailed({}),
        (why) => ({ title: W.NOT_RETRIED_TOAST, description: why }),
        options,
      );
      if (!sent.landed) return false;
      receipt(
        season,
        sent.value.actionId,
        W.retriedToast(sent.value.requeued),
        W.RETRIED_LINE,
        false,
      );
      return true;
    },
    [server, options, receipt],
  );

  const tryAgainNow = useCallback(
    async (season: string) => {
      const sent = await said(
        () => server.tryAgainNow({}),
        (why) => ({ title: W.NOT_TRIED_AGAIN_TOAST, description: why }),
        options,
      );
      if (!sent.landed) return false;
      receipt(season, sent.value.actionId, W.TRIED_AGAIN_TOAST, W.TRIED_AGAIN_LINE, false);
      return true;
    },
    [server, options, receipt],
  );

  return useMemo(
    () => ({ start, pause, pollNow, retryFailed, tryAgainNow }),
    [start, pause, pollNow, retryFailed, tryAgainNow],
  );
}

/** The page's writes, wired: the real mutations and the console's undo. */
export function useLiveImageryWrites(): ImageryWrites {
  const server = useImageryServer();
  const { announce } = useUndo();
  return useImageryWrites({ server, announce });
}
