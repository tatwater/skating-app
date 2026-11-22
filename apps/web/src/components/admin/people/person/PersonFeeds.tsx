import {
  type ComponentProps,
  cloneElement,
  type FocusEvent,
  type ReactElement,
  type ReactNode,
  useLayoutEffect,
  useRef,
} from 'react';

import { Button, buttonVariants } from '@/components/kit/button';
import { GridList, HistoryRow } from '@/components/kit/grid-list';
import { Note } from '@/components/kit/note';
import { PersonLockup } from '@/components/kit/person-lockup';
import { Section } from '@/components/kit/section-slug';
import { SkeletonRow } from '@/components/kit/skeleton';
import { personNameClass } from '@/components/PersonName';
import { ageInWords } from '@/lib/ages';
import { cn } from '@/lib/utils';
import { FLAG_WORDS } from '../../bodies/askWords';
import { isFailed, type Loadable } from '../../reads/consoleReads';
import { ReadNote } from '../../reads/ReadNote';
import { historyWhen } from '../../shell/consoleTime';
import { settledEmpty } from '../answers';
import { FACT_WORDS } from './factWords';
import { rowActor, rowReason, rowSentence, undoneWords } from './feedWords';
import { useSectionLevel } from './headingLevel';
import { ClampedText } from './kit-candidates/clamped-text';
import {
  type ActionRow,
  type DecisionsRead,
  type HistoryRead,
  type PersonRead,
  personName,
  plural,
} from './personModel';
import { WORDS } from './personWords';

/**
 * The page's feeds: what is open about the person, their History, and — on a staff page — their
 * Decisions. Each says its own state: rows on their way hold the list's shape, a read that failed
 * says so with *Try again*, and an open item links to the page that handles it.
 */

/** Where a feed can send the operator; the route hands the router's link. */
export type PersonTarget =
  /** An open flag's item in the Inbox: the Inbox resolves a source ref to the item that holds it. */
  | { kind: 'inboxFlag'; flagId: string }
  | { kind: 'flags' }
  /** An appeal's (a ticket's) item in the Inbox, by its source ref (B01-5f). */
  | { kind: 'inboxTicket'; ticketId: string }
  | { kind: 'people' };

/** The console's routes for each target, when no router is handed in. */
export function personHref(to: PersonTarget): string {
  switch (to.kind) {
    case 'inboxFlag':
      return `/admin/inbox?item=${encodeURIComponent(`flag:${to.flagId}`)}`;
    case 'flags':
      // Flags are decided in the Inbox (B01-5e): its Safety lane, where the old Flags page now goes.
      return '/admin/inbox?lane=safety';
    case 'inboxTicket':
      return `/admin/inbox?item=${encodeURIComponent(`ticket:${to.ticketId}`)}`;
    case 'people':
      return '/admin/people';
  }
}

export type LinkTo = (to: PersonTarget) => ReactElement;
// biome-ignore lint/a11y/useAnchorContent: the content is cloned in
export const defaultLinkTo: LinkTo = (to) => <a href={personHref(to)} />;

/** The feeds' tag column: the boards' 76 px (no token holds it). */
const FEED_COLUMNS = '4.75rem minmax(0, 1fr) auto';

/** A tag in the feed's first column ("Inbox"), in the time column's mono. */
const Tag = ({ children }: { children: ReactNode }) => (
  <span className="uppercase">{children}</span>
);

/** A link chip to another page ("Handle →"), the router's link worn in the kit's link face. */
export function GoLink({
  to,
  linkTo,
  children,
}: {
  to: PersonTarget;
  linkTo: LinkTo;
  children: ReactNode;
}) {
  return cloneElement(
    linkTo(to) as ReactElement<ComponentProps<'a'>>,
    {
      'data-slot': 'go-link',
      className: cn(buttonVariants({ variant: 'link', size: 'xs' }), 'no-underline'),
      children: (
        <span data-slot="label" className="inline-flex items-center gap-[inherit]">
          {children}
          {/* The arrow sits 3 px tighter to the edge (the boards' arrow pad), as the kit's link. */}
          <span aria-hidden="true" className="-mr-[3px]">
            →
          </span>
        </span>
      ),
    } as ComponentProps<'a'>,
  );
}

// ── Open about this person ───────────────────────────────────────────────────────────────────

/**
 * What a person wrote, as their words — quoted, never reworded — clamped to four lines as they
 * render (the kit candidate `ClampedText`, which measures whether they are cut and offers *Show
 * all* exactly then). Every word is in the page: an appeal's body is capped at its write (5,000
 * characters). The words are a support ticket's (PII, D37), so they are never autocaptured: masked
 * as a name is (`personNameClass`), while the press beside them is still counted.
 */
function TheirWords({ text }: { text: string }) {
  const words = text.trim();
  if (words === '') return null;
  return (
    <ClampedText
      data-slot="their-words"
      lines={THEIR_WORDS_LINES}
      showAll={FACT_WORDS.showAll}
      showLess={FACT_WORDS.showLess}
      className="mt-(--space-0_5) text-fg2"
    >
      <span data-slot="their-words-text" className={personNameClass}>
        “{words}”
      </span>
    </ClampedText>
  );
}

/** Lines of a person's own words shown before *Show all*. */
const THEIR_WORDS_LINES = 4;

/** The body a flag is on, as the server named it — never for a flag on the person, whose page it is. */
function flagLabel(flag: PersonRead['open']['flags'][number]): string | null {
  if (flag.targetType === 'user') return null;
  const label = flag.targetLabel?.trim() ?? '';
  return label === '' ? null : label;
}

/**
 * Open flags on them or their content, and appeals for a viewer the read gives them to — drawn only
 * when something is open (or while flags on their content are still being prepared, which may hide
 * some). A flag names the body it is on; an appeal shows what the person wrote.
 */
export function OpenAbout({
  person,
  now,
  linkTo,
}: {
  person: PersonRead;
  now: number;
  linkTo: LinkTo;
}) {
  const level = useSectionLevel();
  const { flags, appeals, flagsCapped, appealsCapped, flagLabelsCapped } = person.open;
  const pending = person.pending.includes('flagSubjects');
  const count = flags.length + (appeals?.length ?? 0);
  const capped = flagsCapped || appealsCapped;
  // Left out only for a complete, genuinely empty answer — never for a floor or a figure still
  // being prepared, which may hide what is open (the oldest appeals, the flags on their content).
  if (settledEmpty({ count, capped, pending })) return null;
  return (
    <Section
      level={level}
      title="Open about this person"
      // While flags on their content are still being prepared the figure may be wrong, not merely
      // short: the rule ends in those words, never a number (and never a zero).
      {...(pending
        ? {
            end: (
              <span
                data-slot="open-count-pending"
                className="text-kick leading-none font-medium tracking-micro text-fg3"
              >
                {WORDS.pending}
              </span>
            ),
          }
        : count > 0 && { count: { count, capped } })}
      data-slot="open-about"
      className="pt-(--space-5_5)"
    >
      {count > 0 && (
        <GridList columns={FEED_COLUMNS} data-variant="history">
          {flags.map((f) => {
            const label = flagLabel(f);
            return (
              <HistoryRow
                key={f.flagId}
                data-slot="open-flag"
                when={<Tag>Inbox</Tag>}
                who={ageInWords(f.createdAt, now)}
                action={
                  // The flag's item in the Inbox.
                  <GoLink to={{ kind: 'inboxFlag', flagId: f.flagId }} linkTo={linkTo}>
                    Handle
                  </GoLink>
                }
              >
                <b className="font-medium text-fg">{FLAG_WORDS[f.reason]} flag</b> on{' '}
                {WORDS.flagOn[f.targetType] ?? WORDS.flagOnUnknown}
                {label !== null && (
                  <>
                    {' · '}
                    <span data-slot="open-flag-label">{label}</span>
                  </>
                )}
              </HistoryRow>
            );
          })}
          {(appeals ?? []).map((a) => (
            <HistoryRow
              key={a.ticketId}
              data-slot="open-appeal"
              when={<Tag>Support</Tag>}
              who={ageInWords(a.createdAt, now)}
              action={
                // The appeal's own item in the Inbox (its ticket handler, B01-5f).
                <GoLink to={{ kind: 'inboxTicket', ticketId: a.ticketId }} linkTo={linkTo}>
                  Handle
                </GoLink>
              }
            >
              <b className="font-medium text-fg">Appeal</b> ·{' '}
              {a.status === 'open' ? WORDS.appealWaiting : a.status.replace(/_/g, ' ')}
              {/* What they wrote is support's to read (D37): the read sends it only to a viewer who may. */}
              <TheirWords text={a.body} />
            </HistoryRow>
          ))}
        </GridList>
      )}
      {pending && <Note data-slot="open-pending">{WORDS.flagsPending}</Note>}
      {capped && <Note data-slot="open-capped">{WORDS.openCapped}</Note>}
      {/* Only when a flag drawn here is left unnamed for it: a flag on the person past the cap
          names nothing more either way. */}
      {flagLabelsCapped && flags.some((f) => f.targetType !== 'user' && flagLabel(f) === null) && (
        <Note data-slot="open-labels-capped">{FACT_WORDS.flagLabelsCapped}</Note>
      )}
    </Section>
  );
}

// ── History and Decisions ────────────────────────────────────────────────────────────────────

function Who({ row }: { row: ActionRow }) {
  const { name, via } = rowActor(row);
  // A face only for a person named: *System*, and a name still being prepared, are words — never
  // a circle of initials drawn from them.
  const named = row.actor !== null && personName(row.actor) !== null;
  return (
    <span className="inline-flex items-center gap-(--space-1_5)">
      <span>
        {named ? <PersonLockup size="sm" name={name} /> : name}
        {via !== null && (
          <>
            {' via '}
            <span data-slot="feed-via" className="font-(family-name:--family-mono) text-mono-sm">
              {via}
            </span>
          </>
        )}
      </span>
    </span>
  );
}

function FeedRows({
  rows,
  now,
  timeZone,
  onUndo,
  tail,
}: {
  rows: readonly ActionRow[];
  now: number;
  timeZone?: string;
  onUndo: (row: ActionRow) => void;
  tail?: ReactNode;
}) {
  return (
    <GridList columns={FEED_COLUMNS} data-variant="history">
      {rows.map((row) => {
        const reason = rowReason(row);
        const undone = undoneWords(row, rows);
        return (
          <HistoryRow
            key={row.id}
            data-slot="feed-row"
            data-state={row.undo.state}
            when={historyWhen(row.createdAt, now, timeZone)}
            who={<Who row={row} />}
            action={
              row.undo.state === 'available' ? (
                <Button size="xs" onClick={() => onUndo(row)}>
                  Undo
                </Button>
              ) : undone !== null ? (
                <span data-slot="feed-undone" className="text-assist leading-list text-fg3">
                  {undone}
                </span>
              ) : row.undo.state === 'overtaken' ? (
                <span data-slot="feed-overtaken" className="text-assist leading-list text-fg3">
                  {WORDS.changedSince}
                </span>
              ) : undefined
            }
          >
            {rowSentence(row, now, timeZone)}
            {reason !== null && (
              <>
                {' · Reason: '}
                <span className="text-fg2">“{reason}”</span>
              </>
            )}
          </HistoryRow>
        );
      })}
      {tail}
    </GridList>
  );
}

/**
 * Focus that sat on a feed's control — *Show more*, a row's *Undo* — and went with it (the button
 * gone once the page holds all it may, the read says it is done, or the row is undone) comes back to
 * the feed itself, never to the page. Spread on the feed's `Section`.
 */
function useFocusKept() {
  const block = useRef<HTMLElement>(null);
  const held = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const el = held.current;
    if (el === null || el.isConnected) return;
    held.current = null;
    const active = document.activeElement;
    if (active === null || active === document.body) block.current?.focus({ preventScroll: true });
  });
  return {
    ref: block,
    tabIndex: -1,
    onFocus: (event: FocusEvent<HTMLElement>) => {
      held.current = event.target === event.currentTarget ? null : (event.target as HTMLElement);
    },
    onBlur: (event: FocusEvent<HTMLElement>) => {
      // Focus moved on to something else: nothing to keep. A control taken out from under focus
      // sends it nowhere (`relatedTarget` is null), so it stays held for the effect above — which
      // runs in the same commit that removed it. Focus sent nowhere while the control stays (a
      // press on the page's blank ground, the window left) is let go once that commit is past, so
      // a later redraw that takes the control away never pulls focus back to the feed.
      if (event.relatedTarget !== null) {
        held.current = null;
        return;
      }
      const from = event.target;
      queueMicrotask(() => {
        if (from.isConnected && held.current === from) held.current = null;
      });
    },
  };
}

/** A feed row's cells while it loads: the time, the sentence. */
const ROW_CELLS = ['3rem', '60%'] as const;

function FeedSkeleton() {
  return (
    <div data-slot="feed-loading" aria-busy="true" className="flex flex-col">
      <SkeletonRow cells={ROW_CELLS} />
      <SkeletonRow cells={ROW_CELLS} />
      <SkeletonRow cells={ROW_CELLS} />
    </div>
  );
}

/**
 * The person's History: every action on them and their content and every decision on a flag about
 * them, newest first, each with its way back; capped, it says more happened before; its last line
 * is the account's creation, which has no way back.
 */
export function HistoryBlock({
  history,
  now,
  timeZone,
  onUndo,
}: {
  history: Loadable<HistoryRead | null> | 'not-shown';
  now: number;
  timeZone?: string;
  onUndo: (row: ActionRow) => void;
}) {
  const level = useSectionLevel();
  const kept = useFocusKept();
  if (history === 'not-shown') return null;
  const value = history === undefined || isFailed(history) ? null : history;
  const rows = value?.rows ?? [];
  return (
    <Section
      level={level}
      title="History"
      {...(value !== null && { count: { count: rows.length, capped: value.capped } })}
      data-slot="person-history"
      className="pt-(--space-5_5) outline-none"
      aria-busy={history === undefined || undefined}
      {...kept}
    >
      <ReadNote reads={[history]} data-slot="history-error">
        {WORDS.historyFailed}
      </ReadNote>
      {history === undefined && <FeedSkeleton />}
      {/* A read that answered `null` has nothing on record for this id — said so, never a failure
          and never a bare heading. */}
      {history === null && <Note data-slot="history-none">{WORDS.notRecorded}</Note>}
      {value !== null && (
        <FeedRows
          rows={rows}
          now={now}
          {...(timeZone !== undefined && { timeZone })}
          onUndo={onUndo}
          tail={
            <>
              {value.capped && (
                <li
                  data-slot="history-capped"
                  className="col-span-full py-(--space-1_5) text-assist leading-list text-fg3"
                >
                  {WORDS.moreBefore}
                </li>
              )}
              <HistoryRow
                data-slot="history-created"
                when={historyWhen(value.createdAt, now, timeZone)}
              >
                {WORDS.accountCreated}
              </HistoryRow>
            </>
          }
        />
      )}
      {value !== null && value.pending.length > 0 && (
        <Note data-slot="history-pending">{WORDS.verdictsPending}</Note>
      )}
    </Section>
  );
}

/** A staffer's Decisions, newest first; more on request while the read says there are more. */
export function DecisionsBlock({
  decisions,
  thisWeek,
  now,
  timeZone,
  onUndo,
  onMore,
}: {
  decisions: Loadable<DecisionsRead>;
  /** "18 this week", from the staff figures, at the rule's end. */
  thisWeek: string | null;
  now: number;
  timeZone?: string;
  onUndo: (row: ActionRow) => void;
  onMore?: (() => void) | undefined;
}) {
  const level = useSectionLevel();
  const kept = useFocusKept();
  const value = decisions === undefined || isFailed(decisions) ? null : decisions;
  return (
    <Section
      level={level}
      title="Decisions"
      {...(thisWeek !== null && {
        end: (
          <span className="font-(family-name:--family-mono) text-kick leading-none font-medium tracking-micro text-fg2">
            {thisWeek}
          </span>
        ),
      })}
      data-slot="person-decisions"
      className="pt-(--space-5_5) outline-none"
      aria-busy={decisions === undefined || undefined}
      {...kept}
    >
      <ReadNote reads={[decisions]} data-slot="decisions-error">
        {WORDS.decisionsFailed}
      </ReadNote>
      {decisions === undefined && <FeedSkeleton />}
      {value !== null && value.rows.length === 0 && (
        <Note data-slot="decisions-none">{WORDS.noDecisions}</Note>
      )}
      {value !== null && value.rows.length > 0 && (
        <FeedRows
          rows={value.rows}
          now={now}
          {...(timeZone !== undefined && { timeZone })}
          onUndo={onUndo}
        />
      )}
      {value !== null && !value.isDone && (
        <div className="flex items-center gap-(--space-3)">
          {onMore !== undefined ? (
            <Button size="xs" data-slot="decisions-more" onClick={onMore}>
              {WORDS.showMore}
            </Button>
          ) : (
            <span data-slot="decisions-capped" className="text-assist leading-list text-fg3">
              {WORDS.decisionsShown(plural(value.rows.length, 'decision', 'decisions'))}
            </span>
          )}
        </div>
      )}
    </Section>
  );
}
