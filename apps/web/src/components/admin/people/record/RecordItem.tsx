import type { ReactNode } from 'react';

import { Badge } from '@/components/kit/badge';
import { Button } from '@/components/kit/button';
import { DisplayWord } from '@/components/kit/display-word';
import { Kbd } from '@/components/kit/kbd';
import { LabelRows } from '@/components/kit/label-rows';
import { LifeList } from '@/components/kit/life-list';
import { LifeStrip } from '@/components/kit/life-strip';
import { Note } from '@/components/kit/note';
import { PersonLockup } from '@/components/kit/person-lockup';
import { RetryNote } from '@/components/kit/retry-note';
import { Section } from '@/components/kit/section-slug';
import { SkeletonText } from '@/components/kit/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/kit/tooltip';
import { cn } from '@/lib/utils';
import { type Loadable, readState } from '../../reads/consoleReads';
import { personName } from '../person/personModel';
import {
  ACTION_KEY,
  type ByLine,
  type EndingUndo,
  endingUndoOf,
  type ItemRead,
  type ItemView,
  itemView,
  type Lever,
  type RecordAction,
  type RecordSubject,
  titleText,
} from './recordModel';
import { RECORD_WORDS as W } from './recordWords';

/**
 * **The item pane** (8.7–8.9): one thing on the record, read once (`contentRecord.item`) — its
 * decision (the badges, the reason it stands on, who did what and when), its words as they were
 * published or that they were erased, its life, what the lever would do, and the foot: the one lever
 * the server offers this viewer, or the server's sentence for why not — and the Undo of the write that
 * ended its newest decision, as the item's own read states it (`endingUndoOf`), whichever list it was
 * opened from. Nothing is drawn to press that the server would refuse — save an undo that ran out,
 * which says why (8.9).
 */
export type RecordItemProps = {
  item: Loadable<ItemRead | null>;
  /** The item's view, when the sheet already drew it from this read. */
  view?: ItemView | null;
  subject: RecordSubject;
  now: number;
  timeZone?: string;
  /** One column: its life reads top to bottom, and no key hints. */
  narrow: boolean;
  /** Key hints on the levers (a fine pointer). */
  keys: boolean;
  busy: RecordAction | null;
  /** The sheet's own note on this item (it changed under a dialog) — never a server's words. */
  note: string | null;
  onLever: (lever: Extract<Lever, { ok: true }>, view: ItemView) => void;
  /** Undo the write that ended the item's newest decision (offered only while available). */
  onUndoEnd: (ending: EndingUndo, item: ItemRead) => void;
};

export function RecordItem(props: RecordItemProps) {
  // The read's four answers, apart (`readState`): on its way, failed, never existed, the item.
  const state = readState(props.item);
  switch (state.kind) {
    case 'loading':
      return <ItemSkeleton />;
    case 'failed':
      return (
        <div className="p-gutter">
          <RetryNote
            data-slot="record-item-failed"
            onRetry={state.failure.retry}
            pending={state.failure.pending}
          >
            {W.itemFailed}
          </RetryNote>
        </div>
      );
    case 'none':
      return (
        <div className="p-gutter">
          <Note data-slot="record-item-none">{W.noSuchItem}</Note>
        </div>
      );
    case 'value':
      return <ItemBody {...props} read={state.value} />;
  }
}

function ItemBody({
  read,
  subject,
  now,
  timeZone,
  narrow,
  keys,
  busy,
  note,
  onLever,
  onUndoEnd,
  view: given,
}: RecordItemProps & { read: ItemRead }) {
  const view = given ?? itemView(read, subject, now, timeZone);
  const lever = view.lever;
  // The undo of the write that ended the newest decision, as the server states it for this viewer:
  // offered while available, drawn off with why once it ran out; gone once undone or overtaken.
  const ending = endingUndoOf(read);
  return (
    <section
      data-slot="record-item"
      data-target={`${view.target.targetType}:${view.target.targetId}`}
      aria-label={view.kicker}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <div className="flex h-top shrink-0 items-center gap-(--space-2_5) border-0 border-b border-solid border-line px-gutter">
        <span
          data-slot="record-item-kicker"
          className="text-kick leading-none font-semibold tracking-kick whitespace-nowrap text-fg uppercase"
        >
          {view.kicker}
        </span>
      </div>
      <div
        data-slot="record-item-scroll"
        className="flex min-h-0 flex-1 flex-col gap-section overflow-y-auto px-gutter pt-(--space-4) pb-(--space-7)"
      >
        <Verdict view={view} now={now} narrow={narrow} note={note} />
        <PlateView view={view} />
        {view.life !== null && view.life.stations.length > 1 && (
          <Section title={W.life} level={3} data-slot="record-life">
            {narrow ? (
              <LifeList
                aria-label={W.life}
                stations={view.life.stations}
                lines={lifeLines(view.life.ifLabel)}
              />
            ) : (
              <LifeStrip
                aria-label={W.life}
                stations={view.life.stations}
                lines={lifeLines(view.life.ifLabel)}
              />
            )}
          </Section>
        )}
        {view.comesBack !== null && (
          <Section title={view.comesBack.title} level={3} data-slot="record-comes-back">
            <LabelRows rows={view.comesBack.rows.map((r) => ({ label: r.label, value: r.text }))} />
          </Section>
        )}
        {view.would !== null && (
          <Section title={view.would.title} level={3} data-slot="record-would">
            <LabelRows rows={view.would.rows.map((r) => ({ label: r.label, value: r.text }))} />
          </Section>
        )}
      </div>
      <Foot
        lever={lever}
        keys={keys && !narrow}
        busy={busy}
        ending={ending}
        onLever={(l) => onLever(l, view)}
        onUndo={() => ending !== null && onUndoEnd(ending, read)}
      />
    </section>
  );
}

const lifeLines = (ifLabel: string | null) => [
  { line: 'heavy' as const, label: W.lines.up },
  { line: 'thin' as const, label: W.lines.down },
  ...(ifLabel !== null ? [{ line: 'dashed' as const, label: ifLabel }] : []),
];

/** The decision note: the badges and the reason it stands on, then who did what, and when. */
function Verdict({
  view,
  narrow,
  note,
}: {
  view: ItemView;
  now: number;
  narrow: boolean;
  note: string | null;
}) {
  return (
    <Note data-slot="record-verdict" className="flex flex-col gap-(--space-2)">
      <span className={cn('flex items-center gap-(--space-2)', narrow && 'flex-wrap')}>
        {view.badges.map((b) => (
          <Badge
            key={b.label}
            data-tone={b.tone}
            variant={b.tone === 'out' ? 'outline' : 'solid'}
            tone={b.tone === 'lit' ? 'lit' : b.tone === 'dim' ? 'dim' : 'default'}
          >
            {b.label}
          </Badge>
        ))}
        {view.reason !== null && (
          <span data-slot="record-reason" className="text-row leading-body text-fg2">
            {W.reason}: <span className="text-fg">“{view.reason}”</span>
          </span>
        )}
      </span>
      {view.byLines.map((b) => (
        <ByLineView key={`${b.at}-${b.did}`} line={b} narrow={narrow} />
      ))}
      {view.decisionsCapped && (
        <span className="text-assist leading-list text-fg3">{W.decisionsCapped}</span>
      )}
      {note !== null && (
        <span role="alert" data-slot="record-note" className="text-assist leading-list text-bad">
          {note}
        </span>
      )}
    </Note>
  );
}

function ByLineView({ line, narrow }: { line: ByLine; narrow: boolean }) {
  const name = line.who === null ? null : personName(line.who);
  return (
    <span
      data-slot="record-by"
      className={cn(
        'flex items-baseline gap-(--space-2_5) text-assist leading-list text-fg3',
        narrow && 'flex-wrap gap-y-(--space-0_5)',
      )}
    >
      {name === null ? (
        <span className="text-fg2">{W.notRecorded}</span>
      ) : (
        <PersonLockup
          size="sm"
          className="text-fg1"
          name={name}
          src={line.who?.profileImageUrl ?? null}
        />
      )}
      <span>
        {line.did}
        {line.reason !== null && (
          <>
            {` · ${W.reason}: `}
            <span className="text-fg1">“{line.reason}”</span>
          </>
        )}
        {line.note !== null && ` · ${line.note}`}
      </span>
    </span>
  );
}

/** The words as published — or that they were erased, and that the decisions stay. */
function PlateView({ view }: { view: ItemView }) {
  const plate = view.plate;
  return (
    <div data-slot="record-plate-part" className="flex flex-col gap-heading">
      <span className="text-kick leading-none font-semibold tracking-kick text-fg2 uppercase">
        {plate.heading}
      </span>
      {plate.kind === 'erased' ? (
        <div
          data-slot="record-plate"
          data-erased=""
          className="flex flex-col gap-(--space-1_5) border border-dashed border-line2 p-(--space-4)"
        >
          <span className="text-body leading-snug font-medium text-fg2">{plate.title}</span>
          <span className="text-assist leading-list text-fg3">{plate.sub}</span>
        </div>
      ) : (
        <div
          data-slot="record-plate"
          className="flex flex-col gap-(--space-2_5) border border-dashed border-line2 px-(--space-4) py-(--space-3_5)"
        >
          <span className="text-kick leading-snug font-semibold tracking-kick text-fg3 uppercase">
            {plate.kicker}
          </span>
          {plate.display !== null && (
            <DisplayWord size="column" className="whitespace-normal">
              {plate.display}
            </DisplayWord>
          )}
          {plate.text !== null && (
            <p className="m-0 text-body leading-body text-fg1">{titleText(plate.text)}</p>
          )}
        </div>
      )}
    </div>
  );
}

/** The foot: the one lever, the server's sentence for why not, and the ending write's undo. */
function Foot({
  lever,
  keys,
  busy,
  ending,
  onLever,
  onUndo,
}: {
  lever: Lever | null;
  keys: boolean;
  busy: RecordAction | null;
  ending: EndingUndo | null;
  onLever: (lever: Extract<Lever, { ok: true }>) => void;
  onUndo: () => void;
}) {
  const undo = ending?.undo ?? null;
  const undoWord = ending === null ? '' : W.undoTheEnd[ending.endedHow];
  const parts: ReactNode[] = [];
  if (lever !== null && !lever.ok) {
    parts.push(
      <span key="say" data-slot="record-say" className="me-auto text-assist leading-list text-fg2">
        {lever.why}
      </span>,
    );
  }
  if (undo?.state === 'unavailable') {
    parts.push(
      <Tooltip key="undo-off">
        <TooltipTrigger
          render={
            <Button size="sm" data-slot="record-undo-end" disabled focusableWhenDisabled>
              {undoWord}
            </Button>
          }
        />
        <TooltipContent title={W.cantUndo} side="top" align="end">
          {undo.why}
        </TooltipContent>
      </Tooltip>,
    );
  } else if (undo?.state === 'available') {
    parts.push(
      <Button key="undo" size="sm" data-slot="record-undo-end" onClick={onUndo}>
        {undoWord}
      </Button>,
    );
  }
  if (lever?.ok === true) {
    const working = busy === lever.action;
    parts.push(
      <Button
        key="lever"
        size="sm"
        variant="primary"
        data-slot="record-lever"
        data-lever-button="record-lever"
        data-action={lever.action}
        loading={working}
        aria-keyshortcuts={keys ? ACTION_KEY[lever.action] : undefined}
        onClick={() => onLever(lever)}
      >
        {working ? W.busy[lever.action] : W.lever[lever.action]}
        {keys && (
          <Kbd variant="dim" aria-hidden="true">
            {ACTION_KEY[lever.action]}
          </Kbd>
        )}
      </Button>,
    );
  }
  if (parts.length === 0) return null;
  return (
    <div
      tabIndex={-1}
      data-slot="record-foot"
      className="flex min-h-(--size-foot,3.5rem) shrink-0 items-center justify-end gap-(--space-2_5) border-0 border-t border-solid border-line px-gutter py-(--space-3) outline-none"
    >
      {parts}
    </div>
  );
}

function ItemSkeleton() {
  return (
    <div
      data-slot="record-item-loading"
      aria-busy="true"
      className="flex flex-col gap-(--space-3) p-gutter"
    >
      <SkeletonText className="text-kick" width="40%" />
      <SkeletonText className="text-row" width="80%" />
      <SkeletonText className="text-row" width="65%" />
    </div>
  );
}
