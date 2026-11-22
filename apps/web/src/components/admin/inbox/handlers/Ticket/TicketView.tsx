import {
  MAX_SUPPORT_NOTE_LENGTH,
  MAX_SUPPORT_REPLY_LENGTH,
  TRUST_CLASS_LABELS,
} from '@skating/core';
import {
  type ReactElement,
  type ReactNode,
  type RefObject,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { ActionBar } from '@/components/kit/action-bar';
import { Badge } from '@/components/kit/badge';
import { Button } from '@/components/kit/button';
import { FactList } from '@/components/kit/fact-list';
import { Note } from '@/components/kit/note';
import { PersonLockup } from '@/components/kit/person-lockup';
import { ReplyDock, type ReplyDockMode } from '@/components/kit/reply-dock';
import { Section } from '@/components/kit/section-slug';
import { ThreadEvent, ThreadMessage } from '@/components/kit/thread-message';
import { ageInWords } from '@/lib/ages';
import { cn } from '@/lib/utils';
import { reportsWords } from '../../blocks/AuthorBlock';
import { LinkChip } from '../../blocks/LinkChip';
import { shownName } from '../../blocks/shownName';
import {
  type DecidedState,
  InspectorFrame,
  InspectorHeadAge,
  InspectorHeadEnd,
  InspectorHeadTitle,
} from '../../inspector/InspectorFrame';
import { TARGET_CHIP } from '../../words/inboxWords';
import { dayMonth, dayTime } from '../Flag/flagFormat';
import { FLAG_WORDS, REASON_HEAD } from '../Flag/flagWords';
import type { TicketDraft } from './ticketDrafts';
import {
  askerName,
  askerShown,
  authorName,
  cutLine,
  type DockMode,
  dockModeOf,
  headAge,
  headTitle,
  leversOf,
  peopleTarget,
  replyState,
  replyStateWords,
  type ThreadEntry,
  type TicketItem,
  type TicketMessage,
  threadOf,
  ticketLine,
} from './ticketModel';
import { TICKET_WORDS as W } from './ticketWords';
import type { TicketAct } from './useTicketWrites';

/**
 * **Board 2.8, drawn from props** — a support ticket as a thread, with the person and what else is
 * open on them at its side (D284: no assignee, no *in progress*; open until someone resolves it).
 *
 * - **Head** — *Support · ‹category›*, the age written out, *Open in People →* (live, never for
 *   someone gone).
 * - **The thread** — the ticket line (when, from where), then the ticket's own words and every note
 *   and reply oldest to newest: a note in the dashed staff box (*Note · staff only*), a reply with its
 *   state — *Sending in 42 s* with its *Cancel* while it settles, *Sent*, *Canceled · never sent*,
 *   *Not sent* with why. Never anything that reads as sent unless the server said so. A thread the
 *   read cut short says how many of how many it shows, from the server's count.
 * - **The dock** — *Reply by email* / *Note*, under the thread like a mail client's (⌘⏎ sends): who
 *   it reaches, where a reply goes from and that their emailed answer isn't read.
 * - **The side** — *User* (who wrote in, their standing), *Related* (what else is open on them,
 *   linked), and the full-width *Resolve* (R) at its foot; a resolved ticket offers *Reopen*.
 *
 * Every lever is from `item.can` alone: a verb allowed is drawn, a sentence is the server's refusal
 * said in place (never a button), a verb absent is neither. No reads, no writes: the container binds
 * them; a refusal is the shell's toast (D268).
 *
 * **Two columns where they fit** (the board's 508 | 280 at 1440), measured on the pane, not the
 * window: the thread scrolls above its dock and *Resolve* floats at the side's foot. Narrower (a
 * phone, a narrow window), one column — the thread, the dock, the side — and *Resolve* is the
 * frame's floating bar at the pane's foot.
 */

export type TicketViewProps = {
  item: TicketItem;
  locked: DecidedState | null;
  /** The minute clock ages are read against. */
  now: number;
  /** The second clock a settling reply counts down against. */
  clock: number;
  timeZone?: string;
  /** *Open in People →*: the router's link to a person, unstyled. */
  personLink: (userId: string) => ReactElement;
  /** Related's *Inbox →* on one flag: the router's link to its Inbox item (`flag:<id>`), unstyled. */
  itemLink: (ref: string) => ReactElement;
  /** Related's last row when the server capped its list: the Inbox filtered to the person. */
  inboxAboutLink: (userId: string) => ReactElement;
  draft: TicketDraft;
  onDraftText: (text: string) => void;
  onDraftMode: (mode: DockMode) => void;
  onReply: (text: string) => void;
  onNote: (text: string) => void;
  onResolve: () => void;
  onReopen: () => void;
  /** A settling reply's *Cancel* (`support.cancelReply`), by its message. */
  onCancelReply: (messageId: string) => void;
  /** A note's *Remove* (`support.removeNote`), by its message. */
  onRemoveNote: (messageId: string) => void;
  pending: TicketAct | null;
  /** The inspector pane: R acts only while focus is inside it. */
  pane?: RefObject<HTMLElement | null>;
  /** The page shows one pane at a time: one column, the bar at the pane's foot. */
  narrow?: boolean;
};

/** The width the two columns need (the board's 280 px side and a thread no narrower than 360). */
const COLUMNS_FROM = 640;

/** Whether the pane is wide enough for the board's two columns, measured on `ref`. */
function useColumns(narrow: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null || narrow) {
      setWide(false);
      return;
    }
    const decide = () => setWide(el.getBoundingClientRect().width >= COLUMNS_FROM);
    decide();
    const observer = new ResizeObserver(decide);
    observer.observe(el);
    return () => observer.disconnect();
  }, [narrow]);
  return { ref, wide: wide && !narrow };
}

export function TicketView(props: TicketViewProps) {
  const { item, locked, narrow = false } = props;
  const { ref, wide } = useColumns(narrow);
  const levers = leversOf(item);
  const resolveBar = locked === null && levers.resolve ? <ResolveBar {...props} /> : null;
  return (
    <InspectorFrame
      head={<TicketHead {...props} />}
      locked={locked}
      // Two columns fill the scroll to its foot: the thread scrolls itself, the side carries the bar.
      fill={wide}
      // One column: the frame floats the bar at the pane's foot. Two: it is the side's own.
      {...(!wide && resolveBar !== null && { actions: resolveBar })}
    >
      <div
        ref={ref}
        data-slot="ticket-handler"
        data-layout={wide ? 'columns' : 'stack'}
        className={cn(
          'min-w-0',
          wide && 'grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_17.5rem] grid-rows-[minmax(0,1fr)]',
        )}
      >
        <div data-slot="ticket-main" className={cn('flex min-w-0 flex-col', wide && 'min-h-0')}>
          <div
            data-slot="ticket-thread-scroll"
            className={cn(wide && 'min-h-0 flex-1 overflow-y-auto overscroll-contain')}
          >
            <Thread {...props} />
          </div>
          {locked === null && <Dock {...props} />}
        </div>
        <aside
          data-slot="ticket-side"
          aria-label={W.user}
          className={cn(
            'relative flex min-w-0 flex-col gap-(--space-5_5) px-gutter pt-(--space-4)',
            wide
              ? 'border-0 border-l border-solid border-line pb-(--space-14)'
              : 'border-0 border-t border-solid border-line pb-(--space-4)',
          )}
        >
          <UserBlock {...props} />
          <RelatedBlock {...props} />
          <ResolvedLine {...props} />
          {wide && resolveBar}
        </aside>
      </div>
    </InspectorFrame>
  );
}

// ── Head ─────────────────────────────────────────────────────────────────────────────────────

function TicketHead({ item, now, personLink }: TicketViewProps) {
  const person = peopleTarget(item);
  return (
    <>
      <InspectorHeadTitle>{headTitle(item)}</InspectorHeadTitle>
      <InspectorHeadAge>{headAge(item, now)}</InspectorHeadAge>
      {person !== null && (
        <InspectorHeadEnd>
          <LinkChip link={personLink(person)} label={W.openInPeople} slot="ticket-open-in-people" />
        </InspectorHeadEnd>
      )}
    </>
  );
}

// ── The thread ───────────────────────────────────────────────────────────────────────────────

function Thread(props: TicketViewProps) {
  const { item, timeZone } = props;
  const levers = leversOf(item);
  const entries = threadOf(item);
  const cut = cutLine(item);
  const [first, ...rest] = entries;
  return (
    <div
      data-slot="ticket-thread"
      className="flex min-w-0 flex-col gap-(--space-4_5) px-gutter pt-(--space-4) pb-(--space-5)"
    >
      <span
        data-slot="ticket-line"
        className="text-kick leading-none font-medium tracking-kick text-fg3 uppercase"
      >
        {ticketLine(item, timeZone)}
      </span>
      {levers.refusals.map((r) => (
        <Note key={r} data-slot="ticket-refusal">
          {r}
        </Note>
      ))}
      <ol aria-label={W.thread} className="m-0 flex list-none flex-col gap-(--space-4) p-0">
        {first !== undefined && (
          <li>
            <Entry entry={first} {...props} />
          </li>
        )}
        {cut !== null && (
          <li data-slot="ticket-cut" className="text-assist leading-list text-fg3">
            {cut}
          </li>
        )}
        {rest.map((entry) => (
          <li
            key={entry.kind === 'ticket' ? 'ticket' : entry.msg.messageId}
            data-message={entry.kind === 'ticket' ? undefined : entry.msg.messageId}
          >
            <Entry entry={entry} {...props} />
          </li>
        ))}
      </ol>
    </div>
  );
}

function Entry({ entry, ...props }: TicketViewProps & { entry: ThreadEntry }) {
  const { item, timeZone } = props;
  switch (entry.kind) {
    case 'ticket': {
      const name = askerName(item);
      return (
        <ThreadMessage
          data-slot="ticket-body"
          name={name}
          face={askerShown(item)}
          at={dayTime(entry.at, timeZone)}
        >
          {entry.body}
        </ThreadMessage>
      );
    }
    case 'removed':
      return <ThreadEvent data-slot="ticket-note-removed">{W.noteRemoved}</ThreadEvent>;
    case 'message':
      return <Message message={entry.msg} {...props} />;
  }
}

function Message({ message, ...props }: TicketViewProps & { message: TicketMessage }) {
  const { timeZone, clock, onCancelReply, onRemoveNote, pending } = props;
  const name = authorName(message.author);
  const face = shownName(message.author);
  const note = message.kind === 'note';
  const state = message.reply === null ? null : replyState(message.reply, clock);
  return (
    <ThreadMessage
      data-slot={note ? 'ticket-note' : 'ticket-reply'}
      data-state={state?.kind}
      name={name}
      face={face}
      kicker={note ? W.note : W.reply}
      at={dayTime(message.createdAt, timeZone)}
      staff={note}
      {...(note &&
        message.remove === null && {
          status: (
            <Button
              data-slot="ticket-note-remove"
              variant="outline"
              size="xs"
              title={W.removeWhat}
              disabled={pending !== null}
              onClick={() => onRemoveNote(message.messageId)}
            >
              {W.remove}
            </Button>
          ),
        })}
      {...(state !== null && {
        status: (
          <>
            <span
              data-slot="ticket-reply-state"
              className={cn(
                state.kind === 'failed' && 'text-bad',
                state.kind === 'sent' && 'text-fg2',
              )}
            >
              {replyStateWords(state, timeZone)}
            </span>
            {state.kind === 'settling' && state.canCancel && (
              <Button
                data-slot="ticket-reply-cancel"
                variant="outline"
                size="xs"
                title={W.cancelWhat}
                disabled={pending !== null}
                onClick={() => onCancelReply(message.messageId)}
              >
                {W.cancel}
              </Button>
            )}
          </>
        ),
      })}
    >
      {message.body}
    </ThreadMessage>
  );
}

// ── The dock ─────────────────────────────────────────────────────────────────────────────────

function Dock({
  item,
  draft,
  onDraftText,
  onDraftMode,
  onReply,
  onNote,
  pending,
}: TicketViewProps) {
  const levers = leversOf(item);
  const mode = dockModeOf(draft.mode, levers.modes);
  if (mode === null) return null;
  const to = askerShown(item);
  const from = item.replyFrom;
  const blocked = item.replyBlocked;
  const modes: ReplyDockMode<DockMode>[] = levers.modes.map((m) =>
    m === 'reply'
      ? {
          id: 'reply',
          label: W.replyMode,
          to: to === null ? W.toThem : W.to(to),
          field: W.replyLabel,
          foot:
            blocked !== null || from === null ? (
              <span
                data-slot="ticket-no-sender"
                data-blocked={blocked ?? 'unconfigured'}
                className="text-warn"
              >
                {blocked === 'seed' ? W.seedNoSend : W.noSender}
              </span>
            ) : (
              <>
                {W.sentFrom(from)} {W.answersNotRead}
              </>
            ),
          send: W.sendReply,
          max: MAX_SUPPORT_REPLY_LENGTH,
          tooLong: (n) => W.tooLong(MAX_SUPPORT_REPLY_LENGTH, n, W.replyNoun),
        }
      : {
          id: 'note',
          label: W.noteMode,
          to: W.staffOnly,
          field: W.noteLabel,
          foot: W.noteFoot,
          send: W.addNote,
          max: MAX_SUPPORT_NOTE_LENGTH,
          tooLong: (n) => W.tooLong(MAX_SUPPORT_NOTE_LENGTH, n, W.noteNoun),
        },
  );
  return (
    <ReplyDock
      modes={modes}
      mode={mode}
      onModeChange={onDraftMode}
      modesLabel={W.modes}
      value={draft.text}
      onValueChange={onDraftText}
      onSend={(text) => (mode === 'reply' ? onReply(text) : onNote(text))}
      sending={pending === 'reply' || pending === 'note'}
    />
  );
}

// ── The side ─────────────────────────────────────────────────────────────────────────────────

function UserBlock({ item, timeZone }: TicketViewProps) {
  const author = item.person;
  if (author === null) {
    return (
      <Section level={3} title={W.user} data-slot="ticket-user">
        <p className="m-0 text-row leading-body text-fg3">{W.noProfile}</p>
      </Section>
    );
  }
  const { person, standing } = author;
  const gone = person.deleted || standing.status === 'deleted';
  const tone =
    standing.status === 'suspended' ? 'warn' : standing.status === 'banned' ? 'bad' : null;
  const by = standing.by === null ? null : shownName(standing.by);
  const rows: { label: string; value: ReactNode }[] = [
    {
      label: FLAG_WORDS.status,
      value:
        tone === null ? (
          FLAG_WORDS.standing[standing.status]
        ) : (
          <Badge variant="outline" tone={tone} data-slot="ticket-user-standing">
            {FLAG_WORDS.standing[standing.status]}
          </Badge>
        ),
    },
  ];
  if (standing.until !== null) {
    rows.push({
      label: W.untilLabel,
      value:
        by === null
          ? dayMonth(standing.until, timeZone)
          : W.until(dayMonth(standing.until, timeZone), by),
    });
  }
  if (!gone) {
    rows.push({ label: FLAG_WORDS.reports, value: reportsWords(author) });
    const tickets = item.personTickets;
    if (tickets !== null) {
      rows.push({
        label: W.tickets,
        value: W.ticketsCount(tickets.total, tickets.resolved, tickets.capped),
      });
    }
    if (person.trustClass !== null) {
      rows.push({
        label: FLAG_WORDS.trust,
        value: `${TRUST_CLASS_LABELS[person.trustClass]} · ${person.points.toLocaleString('en-US')} pts`,
      });
    }
  }
  return (
    <Section level={3} title={W.user} data-slot="ticket-user">
      <div className="flex min-w-0 flex-col gap-(--space-2_5)">
        {gone ? (
          <span className="text-row leading-body text-fg3">{W.formerSkater}</span>
        ) : (
          <PersonLockup
            size="md"
            name={person.displayName}
            {...(person.username !== '' && { handle: person.username })}
          />
        )}
        <FactList rows={rows} />
      </div>
    </Section>
  );
}

function RelatedBlock({ item, timeZone, now, itemLink, inboxAboutLink }: TicketViewProps) {
  const author = item.person;
  if (author === null || author.person.deleted || author.standing.status === 'deleted') return null;
  const { flags, capped } = item.related;
  const rows: { key: string; title: string; sub: string; link: ReactElement; label: string }[] =
    flags.map((f) => ({
      key: f.flagId,
      title: W.flagTitle(REASON_HEAD[f.reason]),
      sub:
        f.status === 'open' || f.resolvedAt === null
          ? W.openFlagSub(TARGET_CHIP[f.targetType], ageInWords(f.createdAt, now))
          : W.actionedSub(dayMonth(f.resolvedAt, timeZone)),
      link: itemLink(`flag:${f.flagId}`),
      label: W.inbox,
    }));
  // A list the server cut says so, with the way to the rest: never read as all there is.
  if (capped) {
    rows.push({
      key: 'more',
      title: W.moreFlags,
      sub: W.moreFlagsSub,
      link: inboxAboutLink(author.person.userId),
      label: W.inbox,
    });
  }
  return (
    <Section level={3} title={W.related} data-slot="ticket-related">
      {rows.length === 0 ? (
        <p className="m-0 text-row leading-body text-fg3">{W.nothingRelated}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {rows.map((r) => (
            <li
              key={r.key}
              data-related={r.key}
              className="flex min-w-0 items-center gap-(--space-2_5) border-0 border-b border-dotted border-line py-(--space-3) first:pt-(--space-0_5) last:border-b-0"
            >
              <span className="flex min-w-0 flex-1 flex-col gap-px">
                <span className="text-row leading-(--lead-snug) text-fg2">{r.title}</span>
                <span className="text-assist leading-(--lead-snug) text-fg3">{r.sub}</span>
              </span>
              <LinkChip link={r.link} label={r.label} slot={`ticket-related-${r.key}`} />
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/** A resolved ticket: who resolved it and when, and *Reopen* where `can` allows. */
function ResolvedLine({ item, timeZone, onReopen, pending }: TicketViewProps) {
  const levers = leversOf(item);
  if (item.ticket.status !== 'resolved' && !levers.reopen) return null;
  const at = item.ticket.resolvedAt;
  return (
    <div
      data-slot="ticket-resolved"
      className="flex min-w-0 flex-col items-start gap-(--space-2_5)"
    >
      {at !== null && (
        <span className="text-assist leading-list text-fg3">
          {W.resolvedBy(shownName(item.ticket.resolvedBy), dayTime(at, timeZone))}
        </span>
      )}
      {levers.reopen && (
        <Button
          data-slot="ticket-reopen"
          variant="outline"
          size="sm"
          title={W.reopenWhat}
          loading={pending === 'reopen'}
          disabled={pending !== null}
          onClick={onReopen}
        >
          {W.reopen}
        </Button>
      )}
    </div>
  );
}

/** The full-width *Resolve* (R): one action spans its bar. */
function ResolveBar({ onResolve, pending, pane }: TicketViewProps) {
  return (
    <ActionBar
      data-slot="ticket-actions"
      aria-label={W.bar}
      {...(pane !== undefined && { pane })}
      groups={[
        {
          id: 'ticket',
          items: [
            {
              id: 'resolve',
              label: W.resolve,
              what: W.resolveWhat,
              onPress: onResolve,
              loading: pending === 'resolve',
              disabled: pending !== null,
            },
          ],
        },
      ]}
    />
  );
}
