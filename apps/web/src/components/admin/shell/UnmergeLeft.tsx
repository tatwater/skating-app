import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { AUDIT_REASON_MAX } from '@skating/core';
import { useMutation } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { createContext, type ReactNode, useCallback, useRef, useState } from 'react';
import { Button } from '@/components/kit/button';
import { Note } from '@/components/kit/note';
import { useRole } from '@/lib/useRole';
import { ReasonAsk } from '../body/tabs/access/ReasonAsk';
import { MERGE_WORDS as MW } from '../body/tabs/shape/mergeWords';
import { isFailed, read, useConsoleReadSet } from '../reads/consoleReads';
import { said } from '../said';
import { unmergeLine, unmovedLine } from './unmergeLine';

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
 * line under that, and — for a viewer with `corpus.duplicates` (the gate `unmerge.resume` and
 * `unmerge.abandon` share) — *Resume* where the server marks the stall `resumable`, and *Abandon*,
 * destructive, behind a reason, on any stall. Both go through the console's write path: a refusal is
 * a toast. An abandoned unmerge is a terminal state beside done, with no actions.
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
    abandoned: receipt.abandoned !== null,
  });
}

/** *Resume*, as a viewer the server lets resume holds it: `null` for anyone else. */
export type ResumeLever = { onResume: () => void; pending: boolean };

/** *Abandon*, as a viewer the server lets abandon holds it: resolves whether it landed. */
export type AbandonLever = { onAbandon: (reason: string) => Promise<boolean> };

/** A stalled unmerge's two ways on, as the viewer holds them. */
export type StallLevers = { resume: ResumeLever | null; abandon: AbandonLever | null };
const NO_LEVERS: StallLevers = { resume: null, abandon: null };

/** What stopped an unmerge, as the server says it (`stalled`): a code, and a failed page's error. */
type Stall = NonNullable<UnmergeReceipt>['stalled'] & {};

/** The quieter line: the code in plain words, then the server's own error verbatim when it has one. */
export function stallWhy(stall: Pick<Stall, 'code' | 'error'>): string {
  const why = MW.stallWhy[stall.code];
  return stall.error !== undefined && stall.error !== '' ? `${why} ${stall.error}` : why;
}

/**
 * The stalled unmerge's reason and its ways on, under the line that says it stopped: *Resume* only
 * where the server marks the stall `resumable` (a dead end — undone, its record gone, the body merged
 * again — isn't), and *Abandon* on any stall, destructive, behind its reason dialog.
 */
function Stalled({
  stall,
  leftCount,
  levers,
}: {
  stall: Stall;
  leftCount: number;
  levers: StallLevers;
}) {
  const [asking, setAsking] = useState(false);
  const { resume, abandon } = levers;
  return (
    <>
      <span data-slot="unmerge-stalled-why" className="block text-assist text-fg3">
        {stallWhy(stall)}
      </span>
      <span data-slot="unmerge-unmoved" className="block text-assist text-fg3">
        {unmovedLine(stall.notReached)}
      </span>
      {(stall.resumable && resume !== null) || abandon !== null ? (
        <span className="mt-(--space-1) inline-flex gap-(--space-2)">
          {stall.resumable && resume !== null && (
            <Button
              size="xs"
              variant="outline"
              data-slot="unmerge-resume"
              disabled={resume.pending}
              onClick={resume.onResume}
            >
              {MW.resume}
            </Button>
          )}
          {abandon !== null && (
            <ReasonAsk
              open={asking}
              onOpenChange={setAsking}
              trigger={
                <Button size="xs" variant="danger" data-slot="unmerge-abandon">
                  {MW.abandon}
                </Button>
              }
              title={MW.abandonTitle}
              description={MW.abandonWhat(leftCount, unmovedLine(stall.notReached))}
              confirm={MW.abandon}
              label={MW.abandonReasonLabel}
              // An abandon's reason is its audit row's (the audit log's cap, from core).
              maxLength={AUDIT_REASON_MAX}
              destructive
              onConfirm={abandon.onAbandon}
            />
          )}
        </span>
      ) : null}
    </>
  );
}

/** The line for an answer the page already holds (a story, a test). */
export function UnmergeLeftView({
  receipt,
  fallback = null,
  levers = NO_LEVERS,
}: {
  receipt: UnmergeReceipt | undefined;
  /** What to say while there is nothing to say (the toast's usual line). */
  fallback?: ReactNode;
  levers?: StallLevers;
}): ReactNode {
  const line = unmergeLeftLine(receipt);
  if (line === null || receipt == null) return fallback;
  const stalled = !receipt.done && receipt.abandoned === null ? receipt.stalled : null;
  return (
    <span data-slot="unmerge-left" className="inline-flex flex-col items-start">
      <span>{line}</span>
      {stalled !== null && (
        <Stalled stall={stalled} leftCount={receipt.left.count} levers={levers} />
      )}
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

/**
 * *Abandon* for one merge's stalled unmerge: `null` when there is none to name or the viewer can't
 * abandon (`corpus.duplicates`, `unmerge.abandon`'s gate). A refusal is said in a toast in the server's
 * words, and the dialog stays open over the reason.
 */
export function useUnmergeAbandon(mergeActionId: string | null): AbandonLever | null {
  const { can } = useRole();
  const abandon = useMutation(api.unmerge.abandon);
  const onAbandon = useCallback(
    async (reason: string) => {
      if (mergeActionId === null) return false;
      const sent = await said(
        () => abandon({ mergeActionId: mergeActionId as Id<'moderationActions'>, reason }),
        (why) => ({ title: MW.notAbandoned, description: why }),
      );
      return sent.landed;
    },
    [mergeActionId, abandon],
  );
  if (mergeActionId === null || !can('corpus.duplicates')) return null;
  return { onAbandon };
}

/** Both ways on for one merge's unmerge, as the viewer holds them. */
export function useStallLevers(mergeActionId: string | null): StallLevers {
  return { resume: useUnmergeResume(mergeActionId), abandon: useUnmergeAbandon(mergeActionId) };
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
  const levers = useStallLevers(mergeActionId);
  const receipt = reads.receipt;
  return (
    <UnmergeLeftView
      receipt={isFailed(receipt) ? undefined : receipt}
      fallback={fallback}
      levers={levers}
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
  levers = NO_LEVERS,
  ...props
}: {
  /** The refusal's own words (the server's). */
  sentence: string;
  running: RunningUnmerge | undefined;
  levers?: StallLevers;
} & Omit<React.ComponentProps<typeof Note>, 'children'>): ReactNode {
  const stalled =
    running != null && !running.done && running.abandoned === null ? running.stalled : null;
  return (
    <Note data-slot="unmerging-note" {...props}>
      <span className="block">{sentence}</span>
      {stalled !== null && running != null && (
        <>
          <span className="block">{MW.unmergeStalled}</span>
          <Stalled stall={stalled} leftCount={running.left.count} levers={levers} />
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
  const levers = useStallLevers(running?.mergeActionId ?? null);
  return <UnmergingNoteView sentence={sentence} running={running} levers={levers} {...props} />;
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
