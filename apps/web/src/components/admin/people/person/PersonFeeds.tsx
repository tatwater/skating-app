import { type ComponentProps, cloneElement, type ReactElement, type ReactNode } from 'react';

import { Avatar } from '@/components/kit/avatar';
import { Button, buttonVariants } from '@/components/kit/button';
import { GridList, HistoryRow } from '@/components/kit/grid-list';
import { Note } from '@/components/kit/note';
import { Section } from '@/components/kit/section-slug';
import { SkeletonRow } from '@/components/kit/skeleton';

import { cn } from '@/lib/utils';

import { FLAG_WORDS } from '../../bodies/askWords';
import { isFailed, type Loadable } from '../../reads/consoleReads';
import { ReadNote } from '../../reads/ReadNote';
import { historyWhen } from '../../shell/consoleTime';
import { rowActor, rowReason, rowSentence, undoneWords } from './feedWords';
import {
  type ActionRow,
  agoWords,
  type DecisionsRead,
  type HistoryRead,
  PENDING_WORDS,
  type PersonRead,
  plural,
} from './personModel';

/**
 * The page's feeds: what is open about the person, their History, and — on a staff page — their
 * Decisions. Each says its own state: rows on their way hold the list's shape, a read that failed
 * says so with *Try again*, and an open item links to the page that handles it.
 */

/** Where a feed can send the operator; the route hands the router's link. */
export type PersonTarget = { kind: 'flags' } | { kind: 'support' } | { kind: 'people' };

/** The console's routes for each target, when no router is handed in. */
export function personHref(to: PersonTarget): string {
  switch (to.kind) {
    case 'flags':
      return '/admin/flags';
    case 'support':
      return '/admin/support';
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

const TARGET_WORDS: Record<string, string> = {
  report: 'a report',
  comment: 'a comment',
  photo: 'a photo',
  user: 'the person',
  hazard: 'a hazard',
  accessAlert: 'an access alert',
  waterbody: 'a body',
  post: 'a post',
};

// ── Open about this person ───────────────────────────────────────────────────────────────────

/**
 * Open flags on them or their content, and appeals for a viewer the read gives them to — drawn only
 * when something is open (or while flags on their content are still being prepared, which may hide
 * some).
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
  const { flags, appeals, flagsCapped, appealsCapped } = person.open;
  const pending = person.pending.includes('flagSubjects');
  const count = flags.length + (appeals?.length ?? 0);
  if (count === 0 && !pending) return null;
  return (
    <Section
      title="Open about this person"
      count={{ count, capped: flagsCapped || appealsCapped }}
      data-slot="open-about"
      className="pt-(--space-5_5)"
    >
      {count > 0 && (
        <GridList columns={FEED_COLUMNS} data-variant="history">
          {flags.map((f) => (
            <HistoryRow
              key={f.flagId}
              data-slot="open-flag"
              when={<Tag>Inbox</Tag>}
              who={agoWords(f.createdAt, now)}
              action={
                <GoLink to={{ kind: 'flags' }} linkTo={linkTo}>
                  Handle
                </GoLink>
              }
            >
              <b className="font-medium text-fg">{FLAG_WORDS[f.reason]} flag</b> on{' '}
              {TARGET_WORDS[f.targetType] ?? 'their content'}
            </HistoryRow>
          ))}
          {(appeals ?? []).map((a) => (
            <HistoryRow
              key={a.ticketId}
              data-slot="open-appeal"
              when={<Tag>Support</Tag>}
              who={agoWords(a.createdAt, now)}
              action={
                <GoLink to={{ kind: 'support' }} linkTo={linkTo}>
                  Handle
                </GoLink>
              }
            >
              <b className="font-medium text-fg">Appeal</b> ·{' '}
              {a.status === 'open' ? 'waiting' : a.status.replace(/_/g, ' ')}
            </HistoryRow>
          ))}
        </GridList>
      )}
      {pending && (
        <Note data-slot="open-pending">
          Flags on their content are {PENDING_WORDS.toLowerCase()}
        </Note>
      )}
    </Section>
  );
}

// ── History and Decisions ────────────────────────────────────────────────────────────────────

function Who({ row }: { row: ActionRow }) {
  const { name, via } = rowActor(row);
  return (
    <span className="inline-flex items-center gap-(--space-1_5)">
      {row.actor !== null && <Avatar name={name} size="sm" aria-hidden="true" />}
      <span>
        {name}
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
                  Changed since
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
  if (history === 'not-shown') return null;
  const value = history === undefined || isFailed(history) ? null : history;
  const rows = value?.rows ?? [];
  return (
    <Section
      title="History"
      {...(value !== null && { count: { count: rows.length, capped: value.capped } })}
      data-slot="person-history"
      className="pt-(--space-5_5)"
      aria-busy={history === undefined || undefined}
    >
      <ReadNote reads={[history]} data-slot="history-error">
        The history couldn’t be read
      </ReadNote>
      {history === undefined && <FeedSkeleton />}
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
                  More happened before these
                </li>
              )}
              <HistoryRow
                data-slot="history-created"
                when={historyWhen(value.createdAt, now, timeZone)}
              >
                Account created
              </HistoryRow>
            </>
          }
        />
      )}
      {value !== null && value.pending.length > 0 && (
        <Note data-slot="history-pending">
          Decisions on flags about their content are {PENDING_WORDS.toLowerCase()}
        </Note>
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
  const value = decisions === undefined || isFailed(decisions) ? null : decisions;
  return (
    <Section
      title="Decisions"
      {...(thisWeek !== null && {
        end: (
          <span className="font-(family-name:--family-mono) text-kick leading-none font-medium tracking-micro text-fg2">
            {thisWeek}
          </span>
        ),
      })}
      data-slot="person-decisions"
      className="pt-(--space-5_5)"
      aria-busy={decisions === undefined || undefined}
    >
      <ReadNote reads={[decisions]} data-slot="decisions-error">
        The decisions couldn’t be read
      </ReadNote>
      {decisions === undefined && <FeedSkeleton />}
      {value !== null && value.rows.length === 0 && (
        <Note data-slot="decisions-none">No decisions on record</Note>
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
              Show more
            </Button>
          ) : (
            <span data-slot="decisions-capped" className="text-assist leading-list text-fg3">
              {plural(value.rows.length, 'decision', 'decisions')} shown · more happened before
              these
            </span>
          )}
        </div>
      )}
    </Section>
  );
}
