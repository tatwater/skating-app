import { ROLE_RANK } from '@skating/core';
import type { ReactNode } from 'react';

import { Avatar } from '@/components/kit/avatar';
import { Badge } from '@/components/kit/badge';
import { Button } from '@/components/kit/button';
import { ListEnd } from '@/components/kit/list-end';
import { Note } from '@/components/kit/note';
import { RetryNote } from '@/components/kit/retry-note';
import { SkeletonBlock, SkeletonText } from '@/components/kit/skeleton';
import { PersonName } from '@/components/PersonName';
import { cn } from '@/lib/utils';

import { isFailed, type Loadable } from '../../reads/consoleReads';
import { LeverBlock } from './LeverBlock';
import { accountRows, canDoRows, type PersonAction } from './levers';
import {
  DecisionsBlock,
  defaultLinkTo,
  GoLink,
  HistoryBlock,
  type LinkTo,
  OpenAbout,
} from './PersonFeeds';
import { SkaterStrip, StaffStrip } from './PersonStrips';
import {
  type ActionRow,
  countText,
  type DecisionsRead,
  dateWords,
  type HistoryRead,
  momentWords,
  type PersonRead,
  type StaffSeasonRead,
  type StaffStatsRead,
  statusNoteWords,
  TRUST_WORDS,
  type TrendRead,
} from './personModel';
import { useActing } from './useActing';

/**
 * **The person page** (boards 8.1, 8.2, 8.5, 8.6): one person — a skater, or staff — as the detail
 * pane. Props only: `PersonPane` runs the reads and the writes and hands their states here.
 *
 * - **The head**: the face, the name with the handle under it, the trust class, and *Public profile*
 *   (a new tab) when the profile can open. A status note under it for a suspension or a ban (who,
 *   when, why, when it lifts), or for an account on its way out.
 * - **The strips**: the skater's, then — on a staff page — the staffer's.
 * - **Two columns**: *Can do*, then what is open about them (only when something is), then on a staff
 *   page their History; on the right *Account*, then their History (a skater) or their Decisions
 *   (staff). A staff page is a skater's page plus the staff rows.
 * - **Every read states itself** in its own block; a person that failed to read says so with *Try
 *   again* while the History beside it stays up. No such person — an id of the wrong shape, or one
 *   with no account — says so, with the way back.
 */
export type PersonViewProps = {
  /** `null`: no such person. */
  person: Loadable<PersonRead | null>;
  trend: Loadable<TrendRead | null>;
  /** `'not-shown'` for a viewer who can't read the audit. */
  history: Loadable<HistoryRead | null> | 'not-shown';
  staffStats: Loadable<StaffStatsRead | null>;
  staffSeason: Loadable<StaffSeasonRead | null>;
  decisions: Loadable<DecisionsRead>;
  /** The clock every time on the page is read against. */
  now: number;
  /** The zone times are written in; the reader's own when absent. */
  timeZone?: string;
  /** Who is looking: their own page has no levers on themselves. */
  viewerId: string | null;
  /** The router's link for each target; a plain `<a>` when absent. */
  linkTo?: LinkTo;
  /** Runs a write; resolves to the server's refusal, or `null` once it landed. */
  onAct: (action: PersonAction) => Promise<string | null>;
  /** A History or Decisions row's Undo. */
  onUndo: (row: ActionRow) => void;
  /** Asks for more decisions, while the read says there are more. */
  onMoreDecisions?: () => void;
  /** Opens the role menu on mount (a board's drawn state). */
  defaultMenuOpen?: boolean;
  className?: string;
};

export function PersonView({
  person,
  trend,
  history,
  staffStats,
  staffSeason,
  decisions,
  now,
  timeZone,
  viewerId,
  linkTo = defaultLinkTo,
  onAct,
  onUndo,
  onMoreDecisions,
  defaultMenuOpen = false,
  className,
}: PersonViewProps) {
  const acting = useActing(onAct);
  const tz = timeZone !== undefined ? { timeZone } : {};

  let body: ReactNode;
  if (person === null) {
    body = (
      <div
        data-slot="no-such-person"
        className="flex flex-col items-start gap-(--space-3) pt-(--space-5)"
      >
        <ListEnd>No such person</ListEnd>
        <GoLink to={{ kind: 'people' }} linkTo={linkTo}>
          People
        </GoLink>
      </div>
    );
  } else if (person === undefined) {
    body = <PersonSkeleton />;
  } else if (isFailed(person)) {
    body = (
      <>
        <RetryNote
          data-slot="person-error"
          className="pt-(--space-5)"
          onRetry={person.retry}
          pending={person.pending}
        >
          This person couldn’t be read
        </RetryNote>
        <HistoryBlock history={history} now={now} {...tz} onUndo={onUndo} />
      </>
    );
  } else {
    const p = person as PersonRead;
    const staff = ROLE_RANK[p.role] >= ROLE_RANK.moderator;
    const self = viewerId !== null && viewerId === p.userId;
    const historyBlock = <HistoryBlock history={history} now={now} {...tz} onUndo={onUndo} />;
    const statsValue = staffStats === undefined || isFailed(staffStats) ? null : staffStats;
    body = (
      <>
        <PersonHead person={p} />
        <StatusNoteBlock person={p} now={now} {...tz} />
        <SkaterStrip person={p} trend={trend} />
        {staff && (
          <StaffStrip person={p} stats={staffStats} season={staffSeason} now={now} {...tz} />
        )}
        <div
          data-slot="person-columns"
          className="grid grid-cols-1 items-start gap-x-(--space-8) @2xl:grid-cols-2"
        >
          <div data-slot="person-left" className="flex min-w-0 flex-col">
            <LeverBlock
              title="Can do"
              rows={canDoRows(p)}
              person={p}
              acting={acting}
              now={now}
              {...tz}
            />
            <OpenAbout person={p} now={now} linkTo={linkTo} />
            {staff && historyBlock}
          </div>
          <div data-slot="person-right" className="flex min-w-0 flex-col">
            <LeverBlock
              title="Account"
              rows={accountRows(p, { now, self })}
              person={p}
              acting={acting}
              now={now}
              {...tz}
              defaultMenuOpen={defaultMenuOpen}
            />
            {staff ? (
              <DecisionsBlock
                decisions={decisions}
                thisWeek={
                  statsValue === null
                    ? null
                    : `${countText(statsValue.decisions.thisWeek)} this week`
                }
                now={now}
                {...tz}
                onUndo={onUndo}
                onMore={onMoreDecisions}
              />
            ) : (
              historyBlock
            )}
          </div>
        </div>
      </>
    );
  }

  return (
    <article
      data-slot="person-pane"
      aria-busy={person === undefined || undefined}
      className={cn('@container flex h-full min-h-0 flex-col', className)}
    >
      <div
        data-slot="person-scroll"
        className="min-h-0 flex-1 overflow-y-auto px-(--space-5) pb-(--space-14)"
      >
        {body}
      </div>
    </article>
  );
}

// ── The head ─────────────────────────────────────────────────────────────────────────────────

/** Whether the profile can open in the app: public, and not a tombstone. */
export function profileOpens(p: Pick<PersonRead, 'profileVisibility' | 'status'>): boolean {
  return p.profileVisibility === 'public' && p.status !== 'deleted' && p.status !== 'deleting';
}

function PersonHead({ person }: { person: PersonRead }) {
  return (
    <header
      data-slot="person-head"
      className="flex items-center gap-(--space-3_5) border-0 border-b border-solid border-line py-(--space-3_5)"
    >
      <span className="flex min-w-0 items-center gap-(--space-2_5)">
        <Avatar
          name={person.displayName}
          {...(person.profileImageUrl !== null && { src: person.profileImageUrl })}
          size="xl"
          tone="head"
          aria-hidden="true"
        />
        <span className="flex min-w-0 flex-col items-start gap-(--space-1_5)">
          <h1
            data-slot="person-name"
            // The boards' 15 px tracked caps: the type scale's 15 px step is the logo's (no name step).
            className="m-0 truncate text-logo leading-none font-semibold tracking-rail text-fg uppercase"
          >
            <PersonName>{person.displayName}</PersonName>
          </h1>
          <span
            data-slot="person-handle"
            className="font-(family-name:--family-mono) text-mono-sm leading-none text-fg2"
          >
            <PersonName>@{person.username}</PersonName>
          </span>
        </span>
      </span>
      <span className="ms-auto flex shrink-0 items-center gap-(--space-2_5)">
        {person.trustClass !== null && (
          <Badge variant="outline" tone="lit" data-slot="trust-class">
            {TRUST_WORDS[person.trustClass]}
          </Badge>
        )}
        {profileOpens(person) && (
          <Button
            variant="link"
            size="xs"
            external
            data-slot="public-profile"
            nativeButton={false}
            render={
              <a
                href={`/u/${encodeURIComponent(person.username)}`}
                target="_blank"
                rel="noreferrer"
              />
            }
          >
            Public profile
          </Button>
        )}
      </span>
    </header>
  );
}

// ── The status note ──────────────────────────────────────────────────────────────────────────

function StatusNoteBlock({
  person,
  now,
  timeZone,
}: {
  person: PersonRead;
  now: number;
  timeZone?: string;
}) {
  if (person.status === 'deleted') {
    return (
      <Note data-slot="status-note" className="mt-(--space-3_5)">
        <strong>Deleted</strong>
        {person.deletedAt !== null ? ` · ${dateWords(person.deletedAt, now, timeZone)}` : ''}
      </Note>
    );
  }
  if (person.leavingUntil !== null) {
    return (
      <Note data-slot="status-note" className="mt-(--space-3_5)">
        <strong>Leaving</strong> · The account is deleted{' '}
        {momentWords(person.leavingUntil, now, timeZone)}
      </Note>
    );
  }
  if (person.statusNote === null) return null;
  const w = statusNoteWords(person.statusNote, now, timeZone);
  return (
    <Note
      data-slot="status-note"
      tone={w.tone}
      className="mt-(--space-3_5) flex flex-col gap-(--space-2)"
    >
      <span className="flex flex-wrap items-center gap-(--space-2_5)">
        <Badge tone={w.tone} data-slot="status-badge">
          {w.badge}
        </Badge>
        <span data-slot="status-reason">
          Reason:{' '}
          {w.reason !== null ? (
            <strong className="font-regular">“{w.reason}”</strong>
          ) : (
            'Not recorded yet'
          )}
        </span>
      </span>
      <span
        data-slot="status-by"
        className="flex flex-wrap items-center gap-(--space-2_5) text-assist text-fg3"
      >
        {w.by === null ? (
          <span>Who and when: not recorded yet</span>
        ) : (
          <>
            <span className="inline-flex items-center gap-(--space-1_5) text-fg1">
              {w.by !== 'system' && <Avatar name={w.by.name} size="sm" aria-hidden="true" />}
              {w.by === 'system' ? 'System' : w.by.name}
              {w.by !== 'system' && w.by.via !== null && (
                <>
                  {' via '}
                  <span className="font-(family-name:--family-mono) text-mono-sm">{w.by.via}</span>
                </>
              )}
            </span>
            <span>{w.when ?? 'When: not recorded yet'}</span>
          </>
        )}
      </span>
      {w.lifts !== null && (
        <span data-slot="status-lifts" className="text-assist text-fg3">
          {w.lifts}
        </span>
      )}
    </Note>
  );
}

// ── Loading ──────────────────────────────────────────────────────────────────────────────────

function PersonSkeleton() {
  return (
    <div data-slot="person-loading" className="flex flex-col gap-(--space-4) pt-(--space-3_5)">
      <span className="flex items-center gap-(--space-2_5)">
        <SkeletonBlock className="size-avatar-xl rounded-full" />
        <SkeletonText className="w-[12rem] text-logo" />
      </span>
      <SkeletonBlock className="h-(--space-14)" />
      <SkeletonBlock className="h-[12rem]" />
    </div>
  );
}
