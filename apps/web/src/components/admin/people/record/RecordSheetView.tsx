import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/kit/button';
import { ListEnd } from '@/components/kit/list-end';
import { PersonLockup } from '@/components/kit/person-lockup';
import { Sheet, SheetClose, SheetContent, SheetHeader, SheetTitle } from '@/components/kit/sheet';
import { isTextEntry } from '@/lib/keys';
import { cn } from '@/lib/utils';

import { isFailed, type Loadable } from '../../reads/consoleReads';
import { useColumnsFit } from '../../shell/columnsFit';
import { AskDialog } from '../person/AskDialog';
import { PostChooser } from './PostChooser';
import { RecordItem } from './RecordItem';
import { RecordList } from './RecordList';
import {
  ACTION_KEY,
  type ChoicesRead,
  type DeletedRow,
  deletedRowView,
  headCount,
  type ItemRead,
  type ItemView,
  itemView,
  kindOptions,
  type Lever,
  listEnd,
  type RecordCounts,
  type RecordSubject,
  type RecordTab,
  type RecordWrite,
  type Restored,
  type ReversedRow,
  type RowView,
  restoredRowView,
  reversedRowView,
  type StandingCount,
  type StandingRow,
  standingRowView,
  subjectName,
  type Target,
  tabCounts,
  targetKey,
  withRestored,
} from './recordModel';
import type { RecordListState } from './recordReads';
import { KIND_WORDS, type RecordKind, RECORD_WORDS as W } from './recordWords';
import { useRecordActing } from './useRecordActing';

/**
 * **The record sheet** (boards 8.7–8.9): a person's record, a 1000-wide sheet over their page —
 * the list on the left (Standing, Deleted, Reversed; the kinds behind *Filter*), the open item on
 * the right. Props in, callbacks out: the wired sheet (`RecordSheet`) runs the reads and the writes.
 *
 * - **The head counts what stands** (`people.person.hidden`): "6 items", a floor ("500+ items"), or
 *   *Still being prepared* — never a zero for not knowing.
 * - **A row restored in this sitting keeps its place** (lit, its Undo beside it) until the sheet
 *   closes (8.8).
 * - **Narrow** (`shell/columnsFit`): below the two columns' width the sheet is the list, then one
 *   item with *The record* to go back; its life reads top to bottom, and no key hints show.
 * - **Every write is tied to its attempt** (`useRecordActing`): a late answer never acts on what the
 *   operator moved on to, and a reason dialog holds while its write is out.
 */
export type RecordSheetViewProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The sheet has finished closing (its slide out is over). */
  onClosed?: () => void;
  /** The main region the sheet sits over (the rail and status bar stay lit). */
  container?: HTMLElement | null;
  subject: RecordSubject;
  /** What stands: `people.person.hidden`; `null` while it loads. */
  standing: StandingCount | null;
  /** The record is still being prepared (the verdict backfill hasn't finished). */
  pending: boolean;
  counts: RecordCounts | null;
  tab: RecordTab;
  onTab: (tab: RecordTab) => void;
  kind: RecordKind | null;
  onKind: (kind: RecordKind | null) => void;
  list: RecordListState<StandingRow | DeletedRow | ReversedRow>;
  restored: readonly Restored[];
  /** The operator's first name, for a restored row's chip. */
  viewerFirst: string;
  selected: Target | null;
  onSelect: (target: Target | null) => void;
  item: Loadable<ItemRead | null>;
  /** The Post whose chooser is open, and its members. */
  chooser: Target | null;
  onChooser: (target: Target | null) => void;
  choices: Loadable<ChoicesRead | null>;
  now: number;
  timeZone?: string;
  /** The write; resolves to the server's refusal, or `null` once it landed. */
  onAct: (target: Target, write: RecordWrite) => Promise<string | null>;
  onUndoRestored: (restored: Restored) => void;
  onUndoEnd: (row: ReversedRow) => void;
  /** A refusal that came back for an item no longer open. */
  onLateRefusal: (text: string) => void;
  /** Force one column (a story's phone); measured otherwise. */
  narrow?: boolean;
  /** Key hints on the levers; a fine pointer's, by default. */
  keys?: boolean;
};

type Ask = {
  target: Target;
  view: ItemView;
  action: 'hideAgain' | 'keep' | 'overturn';
  serial: number;
};

export function RecordSheetView(props: RecordSheetViewProps) {
  const { open, onOpenChange, onClosed, container } = props;
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => onOpenChange(next)}
      onOpenChangeComplete={(isOpen) => {
        if (!isOpen) onClosed?.();
      }}
    >
      <SheetContent
        size="default"
        data-slot="record-sheet"
        {...(container != null && { container })}
      >
        {/* Unmounted while closed: what was restored in this sitting, and every press, end with it. */}
        <SheetBodyView {...props} />
      </SheetContent>
    </Sheet>
  );
}

function SheetBodyView({
  container,
  subject,
  standing,
  pending,
  counts,
  tab,
  onTab,
  kind,
  onKind,
  list,
  restored,
  viewerFirst,
  selected,
  onSelect,
  item,
  chooser,
  onChooser,
  choices,
  now,
  timeZone,
  onAct,
  onUndoRestored,
  onUndoEnd,
  onLateRefusal,
  narrow: forced,
  keys: keysProp,
}: RecordSheetViewProps) {
  const body = useRef<HTMLDivElement>(null);
  const pane = useRef<HTMLDivElement>(null);
  const fits = useColumnsFit(body, ['--size-list', '--size-inspector']);
  const narrow = forced ?? !fits;
  const [shown, setShown] = useState<'list' | 'item'>('list');
  const keys = keysProp ?? finePointer();

  const acting = useRecordActing({ current: selected, onAct, onLateRefusal });
  const [ask, setAsk] = useState<Ask | null>(null);
  const [askOpen, setAskOpen] = useState(false);

  // ── The list's rows ──
  const rows = useMemo(() => {
    if (tab === 'standing') {
      // A list narrowed to one kind holds only that kind's restored rows.
      const merged = withRestored(
        list.rows as StandingRow[],
        kind === null ? restored : restored.filter((r) => r.row.targetType === kind),
      );
      return {
        restoredCount: merged.restoredCount,
        rows: merged.rows.map(({ row, restored: r }) => ({
          view:
            r === null
              ? standingRowView(row, now, timeZone)
              : restoredRowView(r, viewerFirst, now, timeZone),
          restored: r,
        })),
      };
    }
    return {
      restoredCount: 0,
      rows: list.rows.map((row) => ({
        view:
          tab === 'deleted'
            ? deletedRowView(row as DeletedRow, now, timeZone)
            : reversedRowView(row as ReversedRow, now, timeZone),
        restored: null,
      })),
    };
  }, [tab, kind, list.rows, restored, viewerFirst, now, timeZone]);

  const status = list.status === 'unread' ? 'loading' : list.status;
  const end = listEnd({
    tab,
    kind,
    status,
    rows: rows.rows.length,
    restored: rows.restoredCount,
    pending: pending || list.pending,
  });
  const counted = tabCounts(tab, standing, counts);

  // Two columns and nothing open: the first row opens, as the boards draw it.
  const first = rows.rows[0]?.view.target ?? null;
  useEffect(() => {
    if (!narrow && selected === null && first !== null) onSelect(first);
  }, [narrow, selected, first, onSelect]);

  // ── The item ──
  const read = item === undefined || isFailed(item) || item === null ? null : item;
  const view = useMemo(
    () => (read === null ? null : itemView(read, subject, now, timeZone)),
    [read, subject, now, timeZone],
  );
  const selectedKey = selected === null ? null : targetKey(selected);
  const reversal =
    tab === 'reversed' && selectedKey !== null
      ? ((list.rows as ReversedRow[]).find((r) => targetKey(r) === selectedKey) ?? null)
      : null;

  const press = (lever: Extract<Lever, { ok: true }>, v: ItemView) => {
    const target = v.target;
    if (acting.busyOn(target) !== null) return;
    if (lever.action === 'restore') {
      if (lever.needsChoice) onChooser(target);
      else void acting.run(target, { kind: 'restore' }, { region: pane.current, inline: true });
      return;
    }
    setAsk((prev) => ({
      target,
      view: v,
      action: lever.action as Ask['action'],
      serial: (prev?.serial ?? 0) + 1,
    }));
    setAskOpen(true);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!keys || narrow || askOpen || chooser !== null) return;
    // React bubbles a portal's keys here too (the Filter popover, a tooltip): only a key pressed in
    // the sheet itself, and not already used by the control it was pressed in, pulls a lever.
    if (event.defaultPrevented || !event.currentTarget.contains(event.target as Node)) return;
    if (event.metaKey || event.ctrlKey || event.altKey || isTextEntry(event.target as Element))
      return;
    const lever = view?.lever;
    if (view == null || lever == null || !lever.ok) return;
    if (event.key.toUpperCase() !== ACTION_KEY[lever.action]) return;
    event.preventDefault();
    press(lever, view);
  };

  const open = (v: RowView) => {
    onSelect(v.target);
    if (narrow) {
      setShown('item');
      requestAnimationFrame(() => pane.current?.focus());
    }
  };
  const back = () => {
    setShown('list');
    requestAnimationFrame(() => {
      const row = body.current?.querySelector<HTMLElement>(`[data-key="${selectedKey ?? ''}"]`);
      row?.focus();
    });
  };

  const count = headCount(standing, pending);
  const showList = !narrow || shown === 'list';
  const showItem = !narrow || shown === 'item';

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the lever's key is heard from anywhere in the sheet; the lever is its own button
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown}>
      <SheetHeader close={!narrow} closeLabel={W.close} className={cn(narrow && 'px-(--space-4)')}>
        <SheetTitle>{W.title}</SheetTitle>
        <PersonLockup
          size="md"
          data-slot="record-person"
          className="min-w-0"
          name={subjectName(subject)}
          {...(!narrow && subject.username !== null && { handle: subject.username })}
          src={subject.profileImageUrl}
        />
        {count !== null && !narrow && (
          <span
            data-slot="record-count"
            className="shrink-0 font-(family-name:--family-mono) text-mono-sm leading-none whitespace-nowrap text-fg3 uppercase"
          >
            {count}
          </span>
        )}
        {narrow && (
          <SheetClose className="ml-auto" render={<Button size="sm" />}>
            {W.close}
          </SheetClose>
        )}
      </SheetHeader>
      <div
        ref={body}
        data-slot="record-body"
        data-narrow={narrow ? '' : undefined}
        className={cn(
          'grid min-h-0 flex-1',
          narrow ? 'grid-cols-[minmax(0,1fr)]' : 'grid-cols-[var(--size-list)_minmax(0,1fr)]',
        )}
      >
        {showList && (
          <div
            className={cn(
              'flex min-h-0 flex-col',
              !narrow && 'border-0 border-r border-solid border-line',
            )}
          >
            <RecordList
              tab={tab}
              onTab={onTab}
              kind={kind}
              onKind={onKind}
              kindOptions={kindOptions(counted, pending || (counts?.pending.length ?? 0) > 0)}
              rows={rows.rows}
              loading={status === 'loading'}
              end={end}
              pending={pending || list.pending}
              failure={list.failure}
              canLoadMore={status === 'more' && showList}
              onLoadMore={list.loadMore}
              selectedKey={narrow ? null : selectedKey}
              onOpen={open}
              onUndo={onUndoRestored}
            />
          </div>
        )}
        {showItem && (
          <div
            ref={pane}
            tabIndex={-1}
            data-slot="record-pane"
            className="flex min-h-0 min-w-0 flex-col outline-none"
          >
            {narrow && (
              <div
                data-slot="record-back"
                className="flex shrink-0 border-0 border-b border-solid border-line px-(--space-4) py-(--space-2)"
              >
                <Button size="xs" onClick={back}>
                  {W.back}
                </Button>
              </div>
            )}
            {selected === null ? (
              rows.rows.length === 0 ? null : (
                <ListEnd className="mt-(--space-3)">{W.chooseAnItem}</ListEnd>
              )
            ) : (
              <RecordItem
                // Each item is its own pane: a dialog, a busy press, a refusal belong to the item.
                key={selectedKey}
                item={item}
                view={view}
                subject={subject}
                now={now}
                {...(timeZone !== undefined && { timeZone })}
                narrow={narrow}
                keys={keys}
                busy={acting.busyOn(selected)}
                refusal={acting.refusalOn(selected)}
                reversal={reversal}
                onLever={press}
                onUndoEnd={onUndoEnd}
              />
            )}
          </div>
        )}
      </div>

      {ask !== null && (
        <AskDialog
          key={ask.serial}
          open={askOpen}
          onOpenChange={setAskOpen}
          title={
            ask.action === 'hideAgain'
              ? W.hideAgainTitle
              : ask.action === 'keep'
                ? W.keepTitle
                : W.overturnTitle
          }
          description={
            ask.action === 'hideAgain'
              ? W.hideAgainBody(subjectName(subject))
              : ask.action === 'keep'
                ? W.keepBody(subjectName(subject), KIND_WORDS[ask.target.targetType].one)
                : W.overturnBody(
                    subjectName(subject),
                    KIND_WORDS[ask.target.targetType].one,
                    ask.view.erasesOn,
                  )
          }
          confirm={W.lever[ask.action]}
          reason={ask.action === 'overturn' ? 'optional' : true}
          reasonLabel={ask.action === 'overturn' ? W.reasonOptionalLabel : W.reasonLabel}
          {...(ask.action === 'overturn' && { reasonPlaceholder: W.reasonOptionalPlaceholder })}
          onConfirm={(reason) => {
            const write: RecordWrite =
              ask.action === 'overturn'
                ? { kind: 'overturn', ...(reason !== '' && { reason }) }
                : { kind: ask.action, reason };
            return acting.run(ask.target, write, { region: pane.current, inline: false });
          }}
        />
      )}
      <PostChooser
        open={chooser !== null}
        onOpenChange={(o) => {
          if (!o) onChooser(null);
        }}
        choices={choices}
        now={now}
        {...(timeZone !== undefined && { timeZone })}
        {...(container != null && { container })}
        onRestore={(withReportIds) =>
          chooser === null
            ? Promise.resolve(null)
            : acting.run(
                chooser,
                { kind: 'restore', withReportIds },
                { region: pane.current, inline: false },
              )
        }
      />
    </div>
  );
}

/** A fine pointer shows key hints; a phone's doesn't. */
function finePointer(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(pointer: fine)').matches
    : true;
}
