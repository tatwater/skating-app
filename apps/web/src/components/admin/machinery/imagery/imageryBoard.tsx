/**
 * Story support: Machinery › Imagery inside the console's frame at board 6.4's width (1440), so a
 * story can be set beside the boards and read the same — the page drawn from the fixtures, the
 * writes through the real write path against a fake server that answers or refuses, the console's
 * undo recording each Undo, a toast dock of its own. The open granule, its attempt, the filter and
 * the runs drawer are held in state, so a story can be driven like the page. Story-only; nothing in
 * the app imports it.
 */
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faArrowUpRightFromSquare,
  faEngine,
  faInbox,
  faMapLocationDot,
  faTachographDigital,
  faUsers,
} from '@fortawesome/sharp-light-svg-icons';
import { fahrenheitToCelsius } from '@skating/core';
import { ConvexError } from 'convex/values';
import { createElement, type ReactNode, useRef, useState } from 'react';

import { AppShell, ShellRailItem } from '@/components/kit/app-shell';
import { RailViewer } from '@/components/kit/rail-item';
import { createToastManager, Toaster } from '@/components/kit/toast';
import { SearchTrigger, SeasonTape } from '@/components/kit/top-bar-parts';
import type { GoLetter } from '@/lib/keys';

import { OverviewLamp } from '../../overview/overviewStatus';
import { LOWS_BOARD } from '../../season/sentinelLowsFixtures';
import { type LowsState, lowsView } from '../../season/sentinelLowsModel';
import { UndoProvider, type UndoServer, useUndo } from '../../shell/undo';
import type { ImageryRunsTab } from '../imagerySearch';
import { MachineryLanes } from '../MachineryLanes';
import { AttemptLog } from './AttemptLog';
import { GranuleDetail } from './GranuleDetail';
import { granuleRowModel } from './granuleRows';
import { ImageryActions } from './ImageryActions';
import { type GranuleDetailState, type ImageryPageState, ImageryView } from './ImageryView';
import {
  BOARD_FAILED,
  BOARD_ROWS,
  logFor,
  NOW,
  RUNNING_PAGE,
  viewFor,
  ZONE,
} from './imageryFixtures';
import {
  allListRows,
  type GranuleFilter,
  type GranuleRowView,
  type GranuleView,
  type ImageryPageView,
  imageryLaneTailFromPage,
  lowsFactsOf,
  pageShapeOf,
  type SentinelLowsRead,
  sentinelRows,
} from './imageryModel';
import { type ImageryServer, type ImageryWrites, useImageryWrites } from './useImageryWrites';

const MODES: ReadonlyArray<{ key: GoLetter; name: string; icon: typeof faInbox }> = [
  { key: 'O', name: 'Overview', icon: faTachographDigital },
  { key: 'I', name: 'Inbox', icon: faInbox },
  { key: 'C', name: 'Corpus', icon: faMapLocationDot },
  { key: 'P', name: 'People', icon: faUsers },
  { key: 'M', name: 'Machinery', icon: faEngine },
];

/** What each fake write was sent, and what the undo ran — for a story's play to read. */
export type ImageryCalls = {
  sent: { write: keyof ImageryServer; args: unknown }[];
  undone: string[];
};

const REFUSED = new ConvexError('Imagery has already started this season.');

function fakeServer(calls: ImageryCalls, refuse: boolean): ImageryServer {
  const answer =
    (write: keyof ImageryServer, extra: Record<string, unknown> = {}) =>
    async (args: unknown) => {
      calls.sent.push({ write, args });
      if (refuse) throw REFUSED;
      return { actionId: `act_${write}`, ...extra } as never;
    };
  return {
    startImagery: answer('startImagery'),
    pauseImagery: answer('pauseImagery'),
    pollNow: answer('pollNow'),
    retryFailed: answer('retryFailed', { requeued: 1 }),
    tryAgainNow: answer('tryAgainNow'),
  };
}

/** The sentinels' lows the waiting boards draw: below the line by 7 Oct (crossed), or not yet. */
export const LOWS_CROSSED: SentinelLowsRead = LOWS_BOARD;
export const LOWS_WAITING: SentinelLowsRead = {
  ...LOWS_BOARD,
  sentinels: LOWS_BOARD.sentinels.map((s) => ({
    ...s,
    lows: s.lows.map((c) => (c === null ? null : Math.max(c, fahrenheitToCelsius(20.8)))),
  })),
  imageryLine: null,
};

export type ImageryBoardProps = {
  view: ImageryPageView | null;
  /** The page's read on its way, or failed. */
  read?: 'loading' | 'failed';
  failedRows?: readonly GranuleRowView[];
  rows?: readonly GranuleRowView[];
  /** The granule open at the start, and its attempt. */
  initialOpen?: string | null;
  initialAttempt?: number | null;
  initialRuns?: ImageryRunsTab | null;
  /** The detail drawn for an open granule: by default, the fixtures'. */
  detailFor?: (id: string) => GranuleView | null;
  lows?: SentinelLowsRead | null;
  /** The viewer can't write: no bar, no switch, no *Run now*. */
  readOnly?: boolean;
  /** The fake server refuses every write. */
  refuse?: boolean;
  calls?: ImageryCalls;
  /** The frame's size; the board's 1440 × 1060 by default. */
  className?: string;
};

function Writes({
  calls,
  refuse,
  manager,
  children,
}: {
  calls: ImageryCalls;
  refuse: boolean;
  manager: ReturnType<typeof createToastManager>;
  children: (writes: ImageryWrites) => ReactNode;
}) {
  const { announce } = useUndo();
  const [server] = useState(() => fakeServer(calls, refuse));
  return children(useImageryWrites({ server, announce, manager }));
}

export function ImageryBoard({
  view,
  read,
  failedRows = BOARD_FAILED,
  rows = BOARD_ROWS,
  initialOpen = null,
  initialAttempt = null,
  initialRuns = null,
  detailFor = viewFor,
  lows,
  readOnly = false,
  refuse = false,
  calls = { sent: [], undone: [] },
  className = 'h-[66.25rem] w-[90rem]',
}: ImageryBoardProps) {
  const [open, setOpen] = useState<string | null>(initialOpen);
  const [attempt, setAttempt] = useState<number | null>(initialAttempt);
  const [runs, setRuns] = useState<ImageryRunsTab | null>(initialRuns);
  const [filter, setFilter] = useState<GranuleFilter>('all');
  const pane = useRef<HTMLElement | null>(null);
  const [manager] = useState(createToastManager);
  const [undo] = useState<UndoServer>(() => ({
    latestOwn: async () => null,
    run: async ({ actionId }) => {
      calls.undone.push(actionId);
    },
  }));

  const page: ImageryPageState =
    read === 'loading'
      ? { kind: 'loading' }
      : read === 'failed'
        ? { kind: 'failed', retry: () => {}, retrying: false }
        : view === null
          ? { kind: 'none' }
          : { kind: 'view', view };
  const lowsRead =
    lows !== undefined
      ? lows
      : view?.watch != null && view.watch.closestNight !== null
        ? view.watch.closestNight.lowC <= view.watch.lineC
          ? LOWS_CROSSED
          : LOWS_WAITING
        : null;
  const lowsDrawn: LowsState =
    lowsRead === null
      ? { kind: 'none' }
      : lowsRead.state === 'value'
        ? { kind: 'value', view: lowsView(lowsRead) }
        : { kind: 'none' };
  const filtered = (all: readonly GranuleRowView[]) =>
    filter === 'all'
      ? all
      : all.filter((r) => (filter === 'cutting' ? r.status === 'spawned' : r.status === filter));
  const listed =
    filter === 'all'
      ? allListRows(failedRows, rows)
      : { failed: [], rest: filtered([...failedRows, ...rows]) };
  const granule = open === null ? null : detailFor(open);
  const detail: GranuleDetailState =
    open === null
      ? { kind: 'none' }
      : granule === null
        ? { kind: 'missing' }
        : { kind: 'granule', view: granule };

  return (
    <UndoProvider server={undo} manager={manager}>
      <Writes calls={calls} refuse={refuse} manager={manager}>
        {(live) => {
          const writes = readOnly ? null : live;
          const actions =
            view === null ? null : (
              <ImageryActions view={view} now={NOW} writes={writes} pane={pane} />
            );
          return (
            <AppShell
              className={className}
              railHead={
                <span className="mb-(--space-2_5) flex h-(--space-8) items-center justify-center text-logo font-extrabold tracking-logo text-fg italic">
                  GLI
                </span>
              }
              rail={MODES.map((m) => (
                <ShellRailItem
                  key={m.key}
                  goKey={m.key}
                  name={m.name}
                  icon={<FontAwesomeIcon icon={m.icon} />}
                  current={m.name === 'Machinery'}
                  href={`#${m.name.toLowerCase()}`}
                  onClick={(e) => e.preventDefault()}
                />
              ))}
              railFoot={
                <>
                  <ShellRailItem
                    variant="app"
                    goKey="A"
                    name="App"
                    icon={<FontAwesomeIcon icon={faArrowUpRightFromSquare} />}
                    href="#app"
                    onClick={(e) => e.preventDefault()}
                  />
                  <RailViewer name="Teagan Atwater" />
                </>
              }
              topCenter={
                <SeasonTape
                  season="Winter 2026–27"
                  badge="Day 14"
                  ticks={[0.146, 0.288, 0.43, 0.58, 0.712, 0.858]}
                  marks={[{ at: 0.06, kind: 'now', title: 'Today', detail: '14 Oct' }]}
                />
              }
              topEnd={<SearchTrigger />}
              pageKeys={[
                { keys: 'Tab', label: 'panels' },
                { keys: '↑↓', label: 'move' },
                { keys: 'G', label: 'go to' },
                { keys: '?', label: 'keys' },
              ]}
              lamp={<OverviewLamp state="live" />}
            >
              <ImageryView
                sidebar={
                  <MachineryLanes
                    tails={{
                      corpus: { state: 'ok', at: NOW - 2 * 3_600_000 },
                      ...(view !== null && { imagery: imageryLaneTailFromPage(view) }),
                    }}
                    selected="imagery"
                    now={NOW}
                  />
                }
                page={page}
                now={NOW}
                timeZone={ZONE}
                seasonsLink={createElement('a', { href: '#seasons' })}
                lows={lowsDrawn}
                lowsFacts={lowsFactsOf(lowsRead)}
                sentinelRows={sentinelRows(lowsRead)}
                list={{
                  filter,
                  onFilter: setFilter,
                  failed:
                    filter === 'all'
                      ? {
                          rows: listed.failed.map((r) => granuleRowModel(r, NOW, ZONE)),
                          status: 'done',
                        }
                      : null,
                  rows: listed.rest.map((r) => granuleRowModel(r, NOW, ZONE)),
                  status: 'done',
                  selectedId: open,
                  onOpen: (id) => {
                    setOpen(id);
                    setAttempt(null);
                  },
                }}
                detail={detail}
                granulePage={(g) => (
                  <GranuleDetail
                    view={g}
                    now={NOW}
                    timeZone={ZONE}
                    attempt={attempt}
                    onAttempt={setAttempt}
                    log={(a, failed) => (
                      <AttemptLog
                        lines={logFor(a.id)}
                        more={false}
                        failed={failed}
                        timeZone={ZONE}
                      />
                    )}
                    recordedFrom={view?.fly.countedFrom ?? null}
                    actions={actions}
                  />
                )}
                actions={actions}
                onClose={() => setOpen(null)}
                runs={runs}
                onRuns={setRuns}
                {...(writes !== null &&
                  view !== null && {
                    onRunNow: () => writes.pollNow(view.season),
                    ...(pageShapeOf(view.state) === 'waiting' && {
                      onStart: () => writes.start(view.season),
                    }),
                  })}
                detailRef={pane}
              />
            </AppShell>
          );
        }}
      </Writes>
      <Toaster manager={manager} />
    </UndoProvider>
  );
}

/** The running board's page, for a story's args. */
export const BOARD_PAGE = RUNNING_PAGE;
