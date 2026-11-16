import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { useMutation } from 'convex/react';
import { useCallback, useMemo, useState } from 'react';

import { toast } from '@/components/kit/toast';

import { isFailed, read, useConsoleReadSet } from '../../reads/consoleReads';
import { useMinuteNow } from '../../shell/presence';
import { useUndo } from '../../shell/undo';
import { firstName, personName } from '../person/personModel';
import { RecordSheetView } from './RecordSheetView';
import {
  type ItemRead,
  placeName,
  type RecordCounts,
  type RecordSubject,
  type RecordTab,
  type Restored,
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
 *   already reads them (`people.person.hidden`, `contentRecord.recordCounts`).
 */
export type RecordSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subject: RecordSubject;
  standing: StandingCount | null;
  pending: boolean;
  counts: RecordCounts | null;
  container?: HTMLElement | null;
};

export function RecordSheet(props: RecordSheetProps) {
  // A fresh sitting each time it opens: nothing restored, nothing open.
  const [sitting, setSitting] = useState(0);
  // Nothing is mounted, or asked of the server, until the sheet first opens.
  const [opened, setOpened] = useState(props.open);
  if (props.open && !opened) setOpened(true);
  if (!opened) return null;
  return (
    <SheetSitting
      key={sitting}
      {...props}
      onOpenChange={(open) => {
        props.onOpenChange(open);
        if (!open) setSitting((n) => n + 1);
      }}
    />
  );
}

/** The sitting's own state: the tab, the filter, the open item, the chooser, what was restored. */
export function useSittingState() {
  const [tab, setTab] = useState<RecordTab>('standing');
  const [kind, setKind] = useState<RecordKind | null>(null);
  const [selected, setSelected] = useState<Target | null>(null);
  const [chooser, setChooser] = useState<Target | null>(null);
  const [restored, setRestored] = useState<readonly Restored[]>([]);
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
    /** A restore landed on a row the sheet holds: it keeps its place, with its undo, till closing. */
    keepRestored: useCallback(
      (row: StandingRow | undefined, result: RecordWriteResult, at: number) => {
        if (row === undefined) return;
        const key = targetKey(row);
        setRestored((list) => [
          ...list.filter((r) => targetKey(r.row) !== key),
          {
            row,
            at,
            actionId: result.actionId,
            undo: result.undoable ? { needsReason: result.undoNeedsReason } : null,
          },
        ]);
      },
      [],
    ),
  };
}

function SheetSitting({
  open,
  onOpenChange,
  subject,
  standing,
  pending,
  counts,
  container,
}: RecordSheetProps) {
  const now = useMinuteNow();
  const state = useSittingState();
  const { tab, kind, selected, chooser } = state;
  const userId = subject.userId;

  const list = useRecordList(open ? { tab, userId, kind } : null);
  const { reads } = useConsoleReadSet({
    // Who is restoring, for a restored row's chip.
    viewer: open ? read(api.profiles.current, {}) : null,
    item:
      open && selected !== null
        ? read(api.contentRecord.item, {
            targetType: selected.targetType,
            targetId: selected.targetId,
          })
        : null,
    choices:
      open && chooser !== null
        ? read(api.moderation.postRestoreChoices, { postId: chooser.targetId as Id<'posts'> })
        : null,
  });

  const viewer = reads.viewer;
  const viewerName =
    viewer === undefined || viewer === null || isFailed(viewer) ? null : personName(viewer);
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
      keepRestored(row, result, Date.now());
    },
    [tab, rows, keepRestored],
  );
  const onAct = useRecordWrites({ server, announce, subject, placeOf, onRestored, now });

  return (
    <RecordSheetView
      open={open}
      onOpenChange={onOpenChange}
      {...(container !== undefined && { container })}
      subject={subject}
      standing={standing}
      pending={pending}
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
          what: W.undoTheRestore,
        });
      }}
      onLateRefusal={(text) => toast({ title: W.lateRefusal, description: text, tone: 'bad' })}
    />
  );
}
