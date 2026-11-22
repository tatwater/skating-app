import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { useMutation } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { createContext, type ReactNode, useCallback, useRef, useState } from 'react';

import { Button } from '@/components/kit/button';
import { Note } from '@/components/kit/note';
import { useRole } from '@/lib/useRole';
import { MERGE_WORDS as MW } from '../body/tabs/shape/mergeWords';
import { isFailed, read, useConsoleReadSet } from '../reads/consoleReads';
import { said } from '../said';
import { unmergeLine } from './unmergeLine';

/**
 * **What an unmerge left where it was, and whether it is still going** — said where the unmerge is:
 * the Undone toast after a merge's Undo, the unmerge's History row, and the place a merge is refused
 * because one of its bodies is still being unmerged. The server counts it on the unmerge's own audit
 * row as its pages land (`unmerge.receipt`), so the line moves while the unmerge runs: "Moving rows
 * back…", then how many rows had changed since the merge and stayed, or that every row went back
 * ({@link unmergeLine}, the one wording). Until the row is read, the caller's fallback.
 *
 * **A stalled unmerge** (not done, and nothing carrying it on — the server judges it from the
 * scheduler's record of its next page) says it stopped before it finished, its reason as a quieter
 * line under that, and — for a viewer the server lets resume (`corpus.duplicates`, `unmerge.resume`'s
 * gate) — *Resume*, through the console's write path: a refusal is a toast ("Not resumed").
 *
 * The line is a toast's or a row's second line, so a read that fails draws the fallback: the unmerge
 * still landed, and its History row asks again when it is next drawn.
 */

export type UnmergeReceipt = FunctionReturnType<typeof api.unmerge.receipt>;

/** The line for one answer: `null` until the unmerge's row is there. */
export function unmergeLeftLine(receipt: UnmergeReceipt | undefined): string | null {
  if (receipt === undefined || receipt === null) return null;
  return unmergeLine({
    done: receipt.done,
    leftCount: receipt.left.count,
    stalled: receipt.stalled !== null,
  });
}

/** *Resume*, as a viewer the server lets resume holds it: `null` for anyone else. */
export type ResumeLever = { onResume: () => void; pending: boolean };

/** What stopped an unmerge, as the server says it (`stalled`): a code, and a failed page's error. */
type Stall = NonNullable<UnmergeReceipt>['stalled'] & {};

/** The quieter line: the code in plain words, then the server's own error verbatim when it has one. */
export function stallWhy(stall: Stall): string {
  const why = MW.stallWhy[stall.code];
  return stall.error !== undefined && stall.error !== '' ? `${why} ${stall.error}` : why;
}

/**
 * The stalled unmerge's reason and its *Resume*, under the line that says it stopped. *Resume* is
 * offered for every stall `unmerge.resume` accepts — today, every one: the server names no stall a
 * resume can't help, so the web draws none apart.
 */
function Stalled({ stall, resume }: { stall: Stall; resume: ResumeLever | null }) {
  const reason = stallWhy(stall);
  return (
    <>
      <span data-slot="unmerge-stalled-why" className="block text-assist text-fg3">
        {reason}
      </span>
      {resume !== null && (
        <Button
          size="xs"
          variant="outline"
          data-slot="unmerge-resume"
          className="mt-(--space-1)"
          disabled={resume.pending}
          onClick={resume.onResume}
        >
          {MW.resume}
        </Button>
      )}
    </>
  );
}

/** The line for an answer the page already holds (a story, a test). */
export function UnmergeLeftView({
  receipt,
  fallback = null,
  resume = null,
}: {
  receipt: UnmergeReceipt | undefined;
  /** What to say while there is nothing to say (the toast's usual line). */
  fallback?: ReactNode;
  resume?: ResumeLever | null;
}): ReactNode {
  const line = unmergeLeftLine(receipt);
  if (line === null) return fallback;
  const stalled = receipt?.done === false ? receipt.stalled : null;
  return (
    <span data-slot="unmerge-left" className="inline-flex flex-col items-start">
      <span>{line}</span>
      {stalled !== null && <Stalled stall={stalled} resume={resume} />}
    </span>
  );
}

/**
 * *Resume* for one merge's stalled unmerge: `null` when there is none to name or the viewer can't
 * resume. One press at a time; a refusal is said in a toast in the server's words.
 */
export function useUnmergeResume(mergeActionId: string | null): ResumeLever | null {
  const { can } = useRole();
  const resume = useMutation(api.unmerge.resume);
  const [pending, setPending] = useState(false);
  const out = useRef(false);
  const onResume = useCallback(() => {
    if (mergeActionId === null || out.current) return;
    out.current = true;
    setPending(true);
    void said(
      () => resume({ mergeActionId: mergeActionId as Id<'moderationActions'> }),
      (why) => ({ title: MW.notResumed, description: why }),
    ).finally(() => {
      out.current = false;
      setPending(false);
    });
  }, [mergeActionId, resume]);
  if (mergeActionId === null || !can('corpus.duplicates')) return null;
  return { onResume, pending };
}

/** The line for one merge's unmerge, read live from the server, with *Resume* while it is stalled. */
export function UnmergeLeft({
  mergeActionId,
  fallback = null,
}: {
  mergeActionId: string;
  fallback?: ReactNode;
}): ReactNode {
  const { reads } = useConsoleReadSet({
    receipt: read(api.unmerge.receipt, {
      mergeActionId: mergeActionId as Id<'moderationActions'>,
    }),
  });
  const resume = useUnmergeResume(mergeActionId);
  const receipt = reads.receipt;
  return (
    <UnmergeLeftView
      receipt={isFailed(receipt) ? undefined : receipt}
      fallback={fallback}
      resume={resume}
    />
  );
}

/** The unmerge still running on a pair of bodies, as `unmerge.runningOn` answers it. */
export type RunningUnmerge = FunctionReturnType<typeof api.unmerge.runningOn>;

/**
 * **A merge refused because one of its bodies is still being unmerged** (code `unmerging`): the
 * server's sentence, and — when that unmerge has stalled — that it stopped before it finished, why,
 * and *Resume* for a viewer who can. For an answer the page already holds.
 */
export function UnmergingNoteView({
  sentence,
  running,
  resume = null,
  ...props
}: {
  /** The refusal's own words (the server's). */
  sentence: string;
  running: RunningUnmerge | undefined;
  resume?: ResumeLever | null;
} & Omit<React.ComponentProps<typeof Note>, 'children'>): ReactNode {
  const stalled = running != null && !running.done ? running.stalled : null;
  return (
    <Note data-slot="unmerging-note" {...props}>
      <span className="block">{sentence}</span>
      {stalled !== null && (
        <>
          <span className="block">{MW.unmergeStalled}</span>
          <Stalled stall={stalled} resume={resume} />
        </>
      )}
    </Note>
  );
}

/** {@link UnmergingNoteView}, its unmerge read live by the pair's bodies (`unmerge.runningOn`). */
export function UnmergingNote({
  sentence,
  waterBodyIds,
  ...props
}: {
  sentence: string;
  waterBodyIds: readonly string[];
} & Omit<React.ComponentProps<typeof Note>, 'children'>): ReactNode {
  const { reads } = useConsoleReadSet({
    running: read(api.unmerge.runningOn, {
      waterBodyIds: waterBodyIds.slice(0, 2) as Id<'waterBodies'>[],
    }),
  });
  const running = isFailed(reads.running) ? undefined : reads.running;
  const resume = useUnmergeResume(running?.mergeActionId ?? null);
  return <UnmergingNoteView sentence={sentence} running={running} resume={resume} {...props} />;
}

/**
 * **The unmerge's live renderers**, for the places that draw its state from what they already hold:
 * History's unmerge row (its stored line, or — live — the receipt with *Resume* while stalled), and a
 * merge refused with `unmerging` (the server's sentence, or — live — with *Resume* when that unmerge
 * stalled). The wired routes provide them (`UnmergeLiveProvider`); with none (a story, a board), the
 * places draw what they hold.
 */
export type UnmergeLiveRenderers = {
  line: (mergeActionId: string, stored: ReactNode) => ReactNode;
  note: (sentence: string, waterBodyIds: readonly string[]) => ReactNode;
};

export const UnmergeLive = createContext<UnmergeLiveRenderers | null>(null);

const LIVE: UnmergeLiveRenderers = {
  line: (mergeActionId, stored) => <UnmergeLeft mergeActionId={mergeActionId} fallback={stored} />,
  note: (sentence, waterBodyIds) => (
    <UnmergingNote sentence={sentence} waterBodyIds={waterBodyIds} />
  ),
};

/** The live renderers, for a wired route's tree. */
export function UnmergeLiveProvider({ children }: { children: ReactNode }) {
  return <UnmergeLive.Provider value={LIVE}>{children}</UnmergeLive.Provider>;
}
