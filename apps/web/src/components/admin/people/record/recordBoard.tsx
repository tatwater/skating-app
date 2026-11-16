/**
 * Story support: the record sheet over a board frame (8.7–8.9: the sheet at its 1000 px, over the
 * person page's main region), on the pinned clock, with the shell's real undo toast over a fixture
 * server and the sheet's own state and write path (`useSittingState`, `useRecordWrites`) — so a
 * press in a story goes through exactly what the console runs. Story-only; nothing in the app
 * imports it.
 */
import { ConvexError } from 'convex/values';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { createToastManager, Toaster, toast } from '@/components/kit/toast';

import type { ReadFailure } from '../../reads/consoleReads';
import { UndoProvider, type UndoServer, useUndo } from '../../shell/undo';
import { useSittingState } from './RecordSheet';
import { RecordSheetView } from './RecordSheetView';
import { COUNTS, DANA, HIDDEN, NOW, SUBJECT } from './recordFixtures';
import {
  type ChoicesRead,
  type DeletedRow,
  type ItemRead,
  placeName,
  type RecordCounts,
  type RecordSubject,
  type RecordTab,
  type RecordWrite,
  type Restored,
  type ReversedRow,
  type StandingCount,
  type StandingRow,
  subjectName,
  type Target,
  targetKey,
} from './recordModel';
import type { RecordListState } from './recordReads';
import { RECORD_WORDS as W } from './recordWords';
import { type RecordServer, type RecordWriteResult, useRecordWrites } from './useRecordWrites';

export type BoardList = {
  rows: Array<StandingRow | DeletedRow | ReversedRow>;
  status?: RecordListState<unknown>['status'];
  pending?: boolean;
  failed?: boolean;
};

/** What a fixture write answers: a refusal (thrown as the server would), or nothing (it landed). */
export type BoardWrite = (
  target: Target,
  write: RecordWrite,
) => Promise<string | null | undefined> | string | null | undefined;

export type RecordBoardProps = {
  subject?: RecordSubject;
  standing?: StandingCount | null;
  pending?: boolean;
  counts?: RecordCounts | null;
  lists?: Partial<Record<RecordTab, BoardList>>;
  items?: Record<string, ItemRead | null | 'failed' | 'loading'>;
  /** Each item as it reads once restored, by key. */
  restoredItems?: Record<string, ItemRead>;
  choices?: ChoicesRead | null;
  initialTab?: RecordTab;
  initialSelected?: Target | null;
  initialRestored?: Restored[];
  narrow?: boolean;
  keys?: boolean;
  width?: string;
  height?: string;
  now?: number;
  onWrite?: BoardWrite;
  /** Whether each write answers `undoable` (default yes, the undo asking a reason after a restore). */
  undoable?: boolean;
  onUndone?: (actionId: string) => void;
  onRetry?: () => void;
};

const failure = (retry: () => void): ReadFailure => ({ failed: true, pending: false, retry });

export function RecordBoard({
  width = '68.75rem',
  height = '56.25rem',
  ...props
}: RecordBoardProps) {
  const [manager] = useState(createToastManager);
  const [box, setBox] = useState<HTMLElement | null>(null);
  const server: UndoServer = {
    latestOwn: async () => null,
    run: async ({ actionId }) => {
      props.onUndone?.(actionId);
    },
  };
  return (
    <UndoProvider server={server} manager={manager}>
      <div
        ref={setBox}
        data-slot="record-board"
        className="relative overflow-hidden bg-bg"
        style={{ width, height }}
      >
        {box !== null && <Board {...props} container={box} manager={manager} />}
        {box !== null && <Toaster manager={manager} contained container={box} />}
      </div>
    </UndoProvider>
  );
}

function Board({
  subject = SUBJECT,
  standing = HIDDEN,
  pending = false,
  counts = COUNTS,
  lists = {},
  items = {},
  restoredItems = {},
  choices = null,
  initialTab = 'standing',
  initialSelected = null,
  initialRestored = [],
  narrow,
  keys,
  now = NOW,
  onWrite,
  undoable = true,
  onRetry = () => {},
  container,
  manager,
}: Omit<RecordBoardProps, 'width' | 'height' | 'onUndone'> & {
  container: HTMLElement;
  manager: ReturnType<typeof createToastManager>;
}) {
  const [open, setOpen] = useState(true);
  const state = useSittingState();
  const [started, setStarted] = useState(false);
  // The story's starting place, set once.
  if (!started) {
    setStarted(true);
    if (initialTab !== 'standing') state.onTab(initialTab);
    if (initialSelected !== null) state.onSelect(initialSelected);
    for (const r of initialRestored) {
      state.keepRestored(r.row, restoredResult(r), r.at, r.actorId);
    }
  }
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const [over, setOver] = useState<Record<string, ItemRead>>({});
  const { announce, undo } = useUndo();

  const shown = lists[state.tab] ?? { rows: [] };
  const rows = useMemo(
    () =>
      shown.rows.filter(
        (r) =>
          !(state.tab === 'standing' && gone.has(targetKey(r))) &&
          (state.kind === null || r.targetType === state.kind),
      ),
    [shown.rows, state.tab, state.kind, gone],
  );
  const list: RecordListState<StandingRow | DeletedRow | ReversedRow> = {
    status: shown.failed ? 'error' : (shown.status ?? 'done'),
    rows,
    pending: shown.pending ?? false,
    failure: shown.failed ? failure(onRetry) : null,
    loadMore: () => {},
  };

  // The board's server answers settle the rows kept for the sitting, as the console's do.
  const settle = state.settle;
  const standingRows = state.tab === 'standing' && !shown.failed ? (rows as StandingRow[]) : null;
  useEffect(() => {
    if (standingRows !== null) settle({ kind: 'listed', rows: standingRows });
  }, [settle, standingRows]);
  const key = state.selected === null ? null : targetKey(state.selected);
  const raw = key === null ? undefined : (over[key] ?? items[key]);
  const item = raw === 'loading' ? undefined : raw === 'failed' ? failure(onRetry) : raw;

  const server = useMemo<RecordServer>(() => {
    const answer = async (target: Target, write: RecordWrite) => {
      const refused = (await onWrite?.(target, write)) ?? null;
      if (refused !== null) throw new ConvexError(refused);
    };
    const result = (targetId: string, undoNeedsReason: boolean): RecordWriteResult =>
      undoable
        ? { targetId, actionId: `a-${targetId}`, undoable: true, undoNeedsReason }
        : { targetId, actionId: `a-${targetId}`, undoable: false };
    return {
      setStatus: async ({ targetType, targetId, status, reason, withReportIds }) => {
        const t = { targetType, targetId };
        await answer(
          t,
          status === 'visible'
            ? { kind: 'restore', ...(withReportIds !== undefined && { withReportIds }) }
            : { kind: 'hideAgain', reason: reason ?? '' },
        );
        return result(targetId, status === 'visible');
      },
      overturn: async ({ targetType, targetId, reason }) => {
        await answer(
          { targetType, targetId },
          { kind: 'overturn', ...(reason !== undefined && { reason }) },
        );
        return { targetId, actionId: `a-${targetId}`, eraseAt: null };
      },
      keep: async ({ targetType, targetId, reason }) => {
        await answer({ targetType, targetId }, { kind: 'keep', reason });
        return { targetId, actionId: `a-${targetId}`, undoable: false };
      },
    };
  }, [onWrite, undoable]);

  const placeOf = useCallback(
    (target: Target) => {
      const row = Object.values(lists)
        .flatMap((l) => l?.rows ?? [])
        .find((r) => targetKey(r) === targetKey(target));
      return row === undefined ? null : placeName(target.targetType, row);
    },
    [lists],
  );
  const keepRestored = state.keepRestored;
  const onRestored = useCallback(
    (target: Target, result: RecordWriteResult) => {
      const k = targetKey(target);
      const row = (lists.standing?.rows as StandingRow[] | undefined)?.find(
        (r) => targetKey(r) === k,
      );
      keepRestored(row, result, now, DANA.userId);
      // The server no longer lists it as standing; the item reads restored.
      setGone((g) => new Set(g).add(k));
      const after = restoredItems[k];
      if (after !== undefined) setOver((o) => ({ ...o, [k]: after }));
    },
    [lists, keepRestored, restoredItems, now],
  );
  const comesBackOf = useCallback(
    (target: Target) => {
      const read = items[targetKey(target)];
      return typeof read === 'object' && read !== null ? read.comesBack : undefined;
    },
    [items],
  );
  const onAct = useRecordWrites({
    server,
    announce,
    subject,
    placeOf,
    comesBackOf,
    onRestored,
    now,
  });

  return (
    <RecordSheetView
      open={open}
      onOpenChange={setOpen}
      container={container}
      subject={subject}
      standing={standing}
      pending={pending}
      counts={counts}
      tab={state.tab}
      onTab={state.onTab}
      kind={state.kind}
      onKind={state.onKind}
      list={list}
      restored={state.restored}
      viewerFirst="Dana"
      selected={state.selected}
      onSelect={state.onSelect}
      item={item}
      chooser={state.chooser}
      onChooser={state.onChooser}
      choices={state.chooser === null ? undefined : choices}
      now={now}
      onAct={onAct}
      onUndoRestored={(r) =>
        r.undo !== null &&
        undo({ actionId: r.actionId, needsReason: r.undo.needsReason, what: 'The report is back' })
      }
      onUndoEnd={(row) =>
        row.endActionId !== null &&
        row.undo?.state === 'available' &&
        undo({ actionId: row.endActionId, needsReason: row.undo.needsReason })
      }
      onLateRefusal={(text) =>
        toast(
          { title: W.lateRefusalOf(subjectName(subject)), description: text, tone: 'bad' },
          manager,
        )
      }
      {...(narrow !== undefined && { narrow })}
      {...(keys !== undefined && { keys })}
    />
  );
}

const restoredResult = (r: Restored): RecordWriteResult =>
  r.undo === null
    ? { targetId: r.row.targetId, actionId: r.actionId, undoable: false }
    : {
        targetId: r.row.targetId,
        actionId: r.actionId,
        undoable: true,
        undoNeedsReason: r.undo.needsReason,
      };
