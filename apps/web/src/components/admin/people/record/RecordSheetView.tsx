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
 *   closes (8.8) — or the server's answer supersedes it (`nextRestored`).
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
  /** Whether the lever asked a reason when it was pressed; the live answer wins while it stands. */
  needsReason: boolean;
  serial: number;
};

/** A dialog's write on one item, held as that dialog's own while it is out. */
type Held = { by: 'ask' | 'chooser'; key: string };

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

  // Two columns and nothing open: the first row opens, as the boards draw it — once the list has
  // drawn its rows (while it loads, only a restored row could be first, and it isn't drawn).
  const first = status === 'loading' ? null : (rows.rows[0]?.view.target ?? null);
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
      needsReason: lever.needsReason,
      serial: (prev?.serial ?? 0) + 1,
    }));
    setAskOpen(true);
  };

  // ── An open dialog follows the live answer ──
  // Each render reads the item's `can` as the server answers it now. A dialog (or the chooser) whose
  // lever no longer stands — refused, another lever offered, nothing offered — closes: a refusal is
  // the foot's, in the server's words; anything else is said in the item's place. Never while its
  // own write is out: that write is what moves the answer, and it answers for itself. A hold and a
  // kept refusal are each dialog's own (the Ask's or the chooser's, on one item), and end with it.
  const writing = useRef<Held | null>(null);
  const lastRefusal = useRef<(Held & { text: string }) | null>(null);
  // A refusal ends the hold: the dialog judges the live answer again, which may have moved while
  // its write was out (a ref alone would never run the check again).
  const [refusals, setRefusals] = useState(0);
  const holds = (by: Held['by'], key: string | null) =>
    writing.current !== null && writing.current.by === by && writing.current.key === key;
  const liveLever = (target: Target | null): Lever | null | undefined => {
    if (target === null || selectedKey !== targetKey(target)) return null;
    // On its way, or failed: the answer can't be judged yet. Gone: nothing is offered.
    if (item === undefined || isFailed(item)) return undefined;
    return view === null ? null : view.lever;
  };
  const askKey = ask === null ? null : targetKey(ask.target);
  const askLive = liveLever(ask?.target ?? null);
  const askStands =
    ask !== null && askLive != null && askLive.ok === true && askLive.action === ask.action;
  const chooserLive = liveLever(chooser);
  const chooserStands =
    chooserLive != null && chooserLive.ok === true && chooserLive.action === 'restore';
  const closeUnder = (by: Held['by'], target: Target, live: Lever | null | undefined) => {
    const key = targetKey(target);
    const kept = lastRefusal.current;
    lastRefusal.current = null;
    // The foot says the server's why; an item no longer open is not spoken over.
    if (live?.ok === false || selectedKey !== key) return;
    acting.say(
      target,
      kept !== null && kept.by === by && kept.key === key ? kept.text : W.changedWhileOpen,
    );
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the live answer, by value.
  useEffect(() => {
    if (!askOpen || ask === null) {
      // Closed: its hold and its refusal end with it — never the chooser's.
      if (writing.current?.by === 'ask') writing.current = null;
      if (lastRefusal.current?.by === 'ask') lastRefusal.current = null;
      return;
    }
    // Still being read (the answer can't be judged yet), or its own write is out: hold.
    if (askLive === undefined || holds('ask', askKey) || askStands) return;
    setAskOpen(false);
    closeUnder('ask', ask.target, askLive);
  }, [askOpen, askKey, askStands, askLive === undefined, askLive?.ok, refusals]);
  const chooserKey = chooser === null ? null : targetKey(chooser);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the live answer, by value.
  useEffect(() => {
    if (chooser === null) {
      // Closed: its hold and its refusal end with it — never the Ask's.
      if (writing.current?.by === 'chooser') writing.current = null;
      if (lastRefusal.current?.by === 'chooser') lastRefusal.current = null;
      return;
    }
    if (chooserLive === undefined || holds('chooser', chooserKey) || chooserStands) return;
    onChooser(null);
    closeUnder('chooser', chooser, chooserLive);
  }, [chooserKey, chooserStands, chooserLive === undefined, chooserLive?.ok, refusals]);
  /** A dialog's write: held as its own while out; a refusal kept for a close that follows. */
  const dialogWrite = async (by: Held['by'], target: Target, write: RecordWrite) => {
    const key = targetKey(target);
    writing.current = { by, key };
    lastRefusal.current = null;
    const refused = await acting.run(target, write, { region: pane.current, inline: false });
    if (refused !== null) {
      if (holds(by, key)) writing.current = null;
      lastRefusal.current = { by, key, text: refused };
      setRefusals((n) => n + 1);
    }
    return refused;
  };
  const askView = askStands && view !== null ? view : ask?.view;
  const askReason = askStands && askLive?.ok === true ? askLive.needsReason : ask?.needsReason;

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
                    askView?.erasure == null || askView.erasure.kind === 'unrecorded'
                      ? 'unrecorded'
                      : askView.erasure.kind === 'held'
                        ? null
                        : askView.erasure.kind === 'atOnce'
                          ? 'atOnce'
                          : askView.erasure.kind === 'erased'
                            ? 'already'
                            : askView.erasure.day,
                  )
          }
          confirm={W.lever[ask.action]}
          // A reason exactly when the live answer asks one; else one may be given.
          reason={askReason === true ? true : 'optional'}
          reasonLabel={askReason === true ? W.reasonLabel : W.reasonOptionalLabel}
          {...(askReason !== true && { reasonPlaceholder: W.reasonOptionalPlaceholder })}
          onConfirm={(reason) => {
            const write: RecordWrite =
              ask.action === 'overturn'
                ? { kind: 'overturn', ...(reason !== '' && { reason }) }
                : { kind: ask.action, reason };
            return dialogWrite('ask', ask.target, write);
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
            : dialogWrite(
                'chooser',
                chooser,
                // Nothing chosen is a plain restore (the server's answer allowed it): nothing beside it.
                withReportIds.length === 0
                  ? { kind: 'restore' }
                  : { kind: 'restore', withReportIds },
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
