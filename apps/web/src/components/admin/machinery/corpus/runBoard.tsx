import { ConvexError } from 'convex/values';
import { type ReactNode, useRef, useState } from 'react';

import { createToastManager, Toaster } from '@/components/kit/toast';

import { InspectorProvider } from '../../inspector/inspectorContext';
import { UndoProvider, type UndoServer, useUndo } from '../../shell/undo';
import { type RunServer, type RunWrites, useRunWrites } from '../actions/useRunWrites';
import { CampaignView, type TailFor } from './CampaignView';
import { RunTail } from './RunTail';
import { RunView } from './RunView';
import { cappedEvents, loadEvents, ZONE } from './runFixtures';
import type { CampaignView as CampaignData, RunView as RunData, RunEventView } from './runViews';

/**
 * **The run pages in a story's console pane** (story support only: it draws the board's fixtures,
 * so only stories may import it): the detail column at board 6.2's size (830 × 1630, or a phone's
 * 360), the console's undo with a fake server that records each Undo, a toast dock of its own, the
 * writes through the real write path against a fake server that answers or refuses, the tails from
 * the fixture logs, and core's stall rule's fake.
 */

/** What each fake write answered with, and what the undo ran — for a story's play to read. */
export type BoardCalls = {
  marks: { runId: string; reason: string }[];
  waits: { runId: string; now: number }[];
  undone: string[];
};

const REFUSED = new ConvexError('That run has already finished, so it can’t be marked failed.');

function fakeServer(calls: BoardCalls, refuse: boolean): RunServer {
  return {
    markRunFailed: async (args) => {
      calls.marks.push(args);
      if (refuse) throw REFUSED;
      return { actionId: 'act_mark' as never };
    },
    waitOnRun: async (args) => {
      calls.waits.push(args);
      if (refuse) throw REFUSED;
      return { actionId: 'act_wait' as never, until: args.now + 30 * 60_000 };
    },
    requestRunStop: async () => ({ actionId: 'act_stop' as never }),
  };
}

/** The tail a story draws: the load's own log (or the capped one), whatever run is shown. */
export const fixtureTail =
  (events: readonly RunEventView[] = loadEvents(), more = true) =>
  (t: TailFor) => <RunTail {...t} events={events} more={more} />;

export const cappedTail = fixtureTail(cappedEvents(), false);

function Writes({
  calls,
  refuse,
  manager,
  children,
}: {
  calls: BoardCalls;
  refuse: boolean;
  manager: ReturnType<typeof createToastManager>;
  children: (writes: RunWrites) => ReactNode;
}) {
  const { announce } = useUndo();
  const [server] = useState(() => fakeServer(calls, refuse));
  const writes = useRunWrites({
    server,
    announce,
    manager,
    clockNow: () => 0,
    timeZone: ZONE,
  });
  return children(writes);
}

export type RunBoardProps = {
  now: number;
  /** One of the two pages. */
  campaign?: CampaignData;
  run?: RunData;
  tail?: (t: TailFor) => ReactNode;
  /** The fake server refuses every write. */
  refuse?: boolean;
  /** The viewer can't write: no bar. */
  readOnly?: boolean;
  /** A phone's width. */
  narrow?: boolean;
  calls?: BoardCalls;
};

export function RunBoard({
  now,
  campaign,
  run,
  tail = fixtureTail(),
  refuse = false,
  readOnly = false,
  narrow = false,
  calls = { marks: [], waits: [], undone: [] },
}: RunBoardProps) {
  const pane = useRef<HTMLElement>(null);
  const [manager] = useState(createToastManager);
  const [undo] = useState<UndoServer>(() => ({
    latestOwn: async () => null,
    run: async ({ actionId }) => {
      calls.undone.push(actionId);
    },
  }));
  return (
    <UndoProvider server={undo} manager={manager}>
      <InspectorProvider value={{ pane, decidedOnOpen: false, now, timeZone: ZONE, narrow }}>
        <section
          ref={pane}
          tabIndex={-1}
          aria-label="Run"
          data-slot="story-run-pane"
          className={
            narrow
              ? 'relative flex h-[50rem] w-[22.5rem] flex-col overflow-hidden bg-bg font-(family-name:--family-sans) text-fg outline-none'
              : 'relative flex h-[101.875rem] w-[51.875rem] max-w-full flex-col overflow-hidden border-0 border-s border-solid border-line bg-bg font-(family-name:--family-sans) text-fg outline-none'
          }
        >
          <Writes calls={calls} refuse={refuse} manager={manager}>
            {(writes) =>
              campaign !== undefined ? (
                <CampaignView
                  view={campaign}
                  now={now}
                  timeZone={ZONE}
                  tail={tail}
                  writes={readOnly ? null : writes}
                  pane={pane}
                />
              ) : run !== undefined ? (
                <RunView
                  view={run}
                  now={now}
                  timeZone={ZONE}
                  tail={tail}
                  writes={readOnly ? null : writes}
                  pane={pane}
                  linkToRun={(_id, label) => (
                    <a href="#campaign" className="text-assist text-fg2">
                      {label}
                    </a>
                  )}
                />
              ) : null
            }
          </Writes>
        </section>
      </InspectorProvider>
      <Toaster manager={manager} />
    </UndoProvider>
  );
}
