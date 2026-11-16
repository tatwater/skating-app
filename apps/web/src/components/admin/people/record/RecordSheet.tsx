import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { useMutation } from 'convex/react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { toast } from '@/components/kit/toast';

import { isFailed, read, useConsoleReadSet } from '../../reads/consoleReads';
import { useMinuteNow } from '../../shell/presence';
import { useUndo } from '../../shell/undo';
import { firstName, personName } from '../person/personModel';
import { RecordSheetView } from './RecordSheetView';
import {
  type ItemRead,
  nextRestored,
  placeName,
  type RecordCounts,
  type RecordSubject,
  type RecordTab,
  type Restored,
  type RestoredEvent,
  type ReversedRow,
  receiptWords,
  type StandingCount,
  type StandingRow,
  type Target,
  targetKey,
} from './recordModel';
import { useRecordList } from './recordReads';
import type { RecordKind } from './recordWords';
import { RECORD_WORDS as W } from './recordWords';
import { type RecordServer, type RecordWriteResult, useRecordWrites } from './useRecordWrites';

/**
 * **The record sheet, wired** — opened from the person page's *On the record* row. It runs the
 * sheet's reads through the console's one read layer (the list's pages, the open item, a Post's
 * chooser) and its writes through one path, and hands both to `RecordSheetView`.
 *
 * - **Reads only while open**: nothing is asked of the server while the sheet is closed.
 * - **What it remembers is the sitting's**: the tab, the filter, the open item and every row
 *   restored here start over when the sheet opens again.
 * - **Standing's count and whether the record is being prepared** come from the person page, which
 *   already reads them (`people.person.hidden`, `contentRecord.recordPresence`); the counts by kind
 *   (`contentRecord.recordCounts`) are the sheet's own, read only while it is open.
 */
export type RecordSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subject: RecordSubject;
  standing: StandingCount | null;
  pending: boolean;
  container?: HTMLElement | null;
};

export function RecordSheet(props: RecordSheetProps) {
  // A fresh sitting each time it opens: nothing restored, nothing open. It starts on opening, so a
  // closing sheet slides out as it was; the sitting stays mounted, its reads live, until the slide
  // is over (`live`), then it unmounts and asks nothing more. Nothing is mounted, or asked of the
  // server, until it first opens — so a mounted sitting is always a live one.
  const [sitting, setSitting] = useState(0);
  const [wasOpen, setWasOpen] = useState(props.open);
  const [live, setLive] = useState(props.open);
  if (props.open !== wasOpen) {
    setWasOpen(props.open);
    if (props.open) {
      setSitting((n) => n + 1);
      setLive(true);
    }
  }
  if (!props.open && !live) return null;
  return <SheetSitting key={sitting} {...props} onClosed={() => setLive(false)} />;
}

/** The sitting's own state: the tab, the filter, the open item, the chooser, what was restored. */
export function useSittingState() {
  const [tab, setTab] = useState<RecordTab>('standing');
  const [kind, setKind] = useState<RecordKind | null>(null);
  const [selected, setSelected] = useState<Target | null>(null);
  const [chooser, setChooser] = useState<Target | null>(null);
  const [restored, setRestored] = useState<readonly Restored[]>([]);
  const settle = useCallback((event: RestoredEvent) => {
    setRestored((list) => {
      const next = nextRestored(list, event);
      // Unchanged, the same array: nothing redraws for an answer that superseded nothing.
      return next.length === list.length && next.every((r, i) => r === list[i]) ? list : next;
    });
  }, []);
  return {
    tab,
    kind,
    selected,
    chooser,
    restored,
    onTab: useCallback((t: RecordTab) => {
      setTab(t);
      setSelected(null);
    }, []),
    onKind: useCallback((k: RecordKind | null) => {
      setKind(k);
      setSelected(null);
    }, []),
    onSelect: setSelected,
    onChooser: setChooser,
    /** A restore landed on a row the sheet holds: it keeps its place, with its undo, for now. */
    keepRestored: useCallback(
      (
        row: StandingRow | undefined,
        result: RecordWriteResult,
        at: number,
        actorId: string | null,
      ) => {
        if (row === undefined) return;
        settle({
          kind: 'kept',
          restored: {
            row,
            at,
            actionId: result.actionId,
            actorId,
            undo: result.undoable ? { needsReason: result.undoNeedsReason } : null,
          },
        });
      },
      [settle],
    ),
    /** The server's answers that can supersede a kept row: the list, the open item, an Undo. */
    settle,
  };
}

function SheetSitting({
  open,
  onOpenChange,
  subject,
  standing,
  pending,
  container,
  onClosed,
}: RecordSheetProps & { onClosed: () => void }) {
  const now = useMinuteNow();
  const state = useSittingState();
  const { tab, kind, selected, chooser } = state;
  const userId = subject.userId;

  // Mounted only while open or sliding out: every read here is the open sheet's own.
  const list = useRecordList({ tab, userId, kind });
  const { reads } = useConsoleReadSet({
    // Who is restoring, for a restored row's chip.
    viewer: read(api.profiles.current, {}),
    // The tabs' counts by kind, for the filter: only while the sheet is open.
    counts: read(api.contentRecord.recordCounts, { userId: userId as Id<'profiles'> }),
    item:
      selected !== null
        ? read(api.contentRecord.item, {
            targetType: selected.targetType,
            targetId: selected.targetId,
          })
        : null,
    choices:
      chooser !== null
        ? read(api.moderation.postRestoreChoices, { postId: chooser.targetId as Id<'posts'> })
        : null,
  });

  const counts =
    reads.counts === undefined || isFailed(reads.counts) ? null : (reads.counts as RecordCounts);
  const viewer = reads.viewer;
  const viewerName =
    viewer === undefined || viewer === null || isFailed(viewer) ? null : personName(viewer);
  const viewerId =
    viewer === undefined || viewer === null || isFailed(viewer) ? null : (viewer._id as string);
  const setModerationStatus = useMutation(api.moderation.setModerationStatus);
  const overturnVerdict = useMutation(api.moderation.overturnVerdict);
  const keepOnRecord = useMutation(api.moderation.keepOnRecord);
  const server = useMemo<RecordServer>(
    () => ({
      setStatus: (args) => setModerationStatus(args),
      overturn: (args) => overturnVerdict(args),
      keep: (args) => keepOnRecord(args),
    }),
    [setModerationStatus, overturnVerdict, keepOnRecord],
  );
  const { announce, undo } = useUndo();

  // Where an item is, for its receipt: from the open item's read, else the row it was opened from.
  const item = reads.item as ItemRead | null | undefined;
  const rows = list.rows;
  const placeOf = useCallback(
    (target: Target) => {
      const key = targetKey(target);
      const from =
        item != null && !('failed' in item) && targetKey(item) === key
          ? item
          : rows.find((r) => targetKey(r) === key);
      return from === undefined ? null : placeName(target.targetType, from);
    },
    [item, rows],
  );
  const keepRestored = state.keepRestored;
  const onRestored = useCallback(
    (target: Target, result: RecordWriteResult) => {
      const key = targetKey(target);
      const row =
        tab === 'standing' ? (rows as StandingRow[]).find((r) => targetKey(r) === key) : undefined;
      keepRestored(row, result, Date.now(), viewerId);
    },
    [tab, rows, keepRestored, viewerId],
  );
  // The server's answers settle the rows kept for the sitting: Standing as loaded, the open item.
  const settle = state.settle;
  const standingRows =
    tab === 'standing' && list.status !== 'loading' && list.status !== 'error'
      ? (rows as StandingRow[])
      : null;
  useEffect(() => {
    if (standingRows !== null) settle({ kind: 'listed', rows: standingRows });
  }, [settle, standingRows]);
  useEffect(() => {
    if (item != null && !('failed' in item)) settle({ kind: 'item', item });
  }, [settle, item]);
  const comesBackOf = useCallback(
    (target: Target) =>
      item != null && !('failed' in item) && targetKey(item) === targetKey(target)
        ? item.comesBack
        : undefined,
    [item],
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
      onOpenChange={onOpenChange}
      onClosed={onClosed}
      {...(container !== undefined && { container })}
      subject={subject}
      standing={standing}
      pending={pending || (counts?.pending.length ?? 0) > 0}
      counts={counts}
      tab={tab}
      onTab={state.onTab}
      kind={kind}
      onKind={state.onKind}
      list={list}
      restored={state.restored}
      viewerFirst={viewerName === null ? W.notRecorded : firstName(viewerName)}
      selected={selected}
      onSelect={state.onSelect}
      item={reads.item}
      chooser={chooser}
      onChooser={state.onChooser}
      choices={reads.choices}
      now={now}
      onAct={onAct}
      onUndoRestored={(r: Restored) => {
        if (r.undo === null) return;
        undo({
          actionId: r.actionId,
          needsReason: r.undo.needsReason,
          what: receiptWords(
            { kind: 'restore' },
            { kind: r.row.targetType, place: placeName(r.row.targetType, r.row), subject },
            {},
            now,
          ).title,
        });
      }}
      onUndoEnd={(row: ReversedRow) => {
        if (row.endActionId === null || row.undo?.state !== 'available') return;
        undo({
          actionId: row.endActionId,
          needsReason: row.undo.needsReason,
          // What happened, as every undo path says it: the restore's own receipt.
          what: receiptWords(
            { kind: 'restore' },
            { kind: row.targetType, place: placeName(row.targetType, row), subject },
            {},
            now,
          ).title,
        });
      }}
      onLateRefusal={(text) => toast({ title: W.lateRefusal, description: text, tone: 'bad' })}
    />
  );
}
