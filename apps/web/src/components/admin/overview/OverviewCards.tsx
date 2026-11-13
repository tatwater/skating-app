import type { ComponentProps } from 'react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/kit/tooltip';

import { CountCard, CountFoot, CountRow, RowLink, SectionNote } from './CountCard';
import {
  type CorpusCardData,
  INBOX_LANE_LABEL,
  INBOX_LANES,
  type InboxCardData,
  inboxFootAges,
  inboxTotal,
  type JobState,
  type MachineryCardData,
  type PeopleCardData,
  suspensionDetail,
} from './overviewData';
import {
  countText,
  countTone,
  dayMonth,
  shortAge,
  sumCounts,
  type ValueTone,
} from './overviewModel';
import { StatusDot, type StatusDotTone } from './StatusDot';

/**
 * Home's four count cards: Inbox by lane, Corpus by task, Machinery by job, People. Each takes its
 * view model, or `undefined` while it loads (the rows hold their place).
 */

type CardProps<T> = Omit<ComponentProps<'section'>, 'title' | 'children'> & { data: T | undefined };

// ── Inbox ────────────────────────────────────────────────────────────────────────────────────

export function InboxCard({ data, now, ...props }: CardProps<InboxCardData> & { now: number }) {
  if (data === undefined) return <CountCard title="Inbox" loadingRows={7} {...props} />;
  const total = inboxTotal(data);
  const ages = inboxFootAges(data, now);
  return (
    <CountCard title="Inbox" end={<SectionNote>{countText(total)} open</SectionNote>} {...props}>
      {INBOX_LANES.map((lane) => {
        const count = data.lanes[lane];
        // A lane the viewer can't open isn't drawn at all — no "admin" mark, no empty row.
        if (count === null) return null;
        return (
          <CountRow
            key={lane}
            label={INBOX_LANE_LABEL[lane]}
            value={countText(count)}
            // Safety is red the moment anything waits in it.
            tone={countTone(count, lane === 'safety' ? 'bad' : 'default')}
            to={{ kind: 'inbox', lane }}
          />
        );
      })}
      {ages !== null && (
        <CountFoot>
          Oldest open {shortAge(ages.oldestMs)}
          {ages.medianMs !== null && <> · median age {shortAge(ages.medianMs)}</>}
        </CountFoot>
      )}
    </CountCard>
  );
}

// ── Corpus ───────────────────────────────────────────────────────────────────────────────────

export function CorpusCard({ data, ...props }: CardProps<CorpusCardData>) {
  if (data === undefined) return <CountCard title="Corpus" loadingRows={8} {...props} />;
  const pass = data.preIcePass;
  return (
    <CountCard
      title="Corpus"
      end={
        data.campaignAt !== null ? (
          <SectionNote>Campaign {dayMonth(data.campaignAt)}</SectionNote>
        ) : undefined
      }
      {...props}
    >
      <CountRow
        label="Duplicates"
        value={countText(data.duplicates)}
        tone={countTone(data.duplicates)}
        to={{ kind: 'corpus', task: 'duplicates' }}
      />
      <CountRow
        label="Name conflicts"
        value={countText(data.nameConflicts)}
        tone={countTone(data.nameConflicts)}
        to={{ kind: 'corpus', task: 'nameConflicts' }}
      />
      <CountRow
        label={
          <Tooltip>
            <TooltipTrigger variant="text" render={<span />}>
              Class conflicts
            </TooltipTrigger>
            <TooltipContent>
              The catalogs disagree on what kind of water it is, or one says it isn't a lake or pond
              at all
            </TooltipContent>
          </Tooltip>
        }
        value={countText(data.classConflicts)}
        tone={countTone(data.classConflicts)}
        to={{ kind: 'corpus', task: 'classConflicts' }}
      />
      <CountRow
        label="Orphan bays"
        value={countText(data.orphanBays)}
        tone={countTone(data.orphanBays)}
        to={{ kind: 'corpus', task: 'orphanBays' }}
      />
      {data.chordRefits !== null && (
        <CountRow
          label="Chord re-fits"
          value={countText(data.chordRefits)}
          // A re-fit waits on a person.
          tone={countTone(data.chordRefits, 'warn')}
          to={{ kind: 'corpus', task: 'chordRefits' }}
        />
      )}
      {data.placeNames !== null && (
        <CountRow
          label="Place names from the emails"
          value={countText(data.placeNames)}
          tone={countTone(data.placeNames)}
          to={{ kind: 'corpus', task: 'placeNames' }}
        />
      )}
      {pass !== null && (
        <CountRow
          label="Pre-ice pass"
          value={pass.state === 'done' ? dayMonth(pass.at) : 'not run'}
          tone={pass.state === 'done' ? 'default' : 'warn'}
          to={{ kind: 'corpus', task: 'preIcePass' }}
        />
      )}
      {data.enrichment !== null && (
        <CountRow
          label="Awaiting enrichment"
          value={countText(data.enrichment)}
          tone={countTone(data.enrichment)}
          to={{ kind: 'corpus', task: 'enrichment' }}
        />
      )}
    </CountCard>
  );
}

// ── Machinery ────────────────────────────────────────────────────────────────────────────────

const JOB: Record<JobState, { dot: StatusDotTone; tone: ValueTone; word: string }> = {
  stalled: { dot: 'bad', tone: 'bad', word: 'stalled' },
  failed: { dot: 'bad', tone: 'bad', word: 'failed' },
  late: { dot: 'warn', tone: 'warn', word: 'late' },
  retried: { dot: 'warn', tone: 'warn', word: 'retried' },
  ok: { dot: 'quiet', tone: 'dim', word: 'ok' },
  never: { dot: 'hollow', tone: 'dim', word: 'not run' },
};

export function MachineryCard({
  data,
  ...props
}: Omit<CardProps<MachineryCardData>, 'data'> & { data: MachineryCardData | null | undefined }) {
  // The status is a column of its own, right-aligned; the time a fixed column after it, wide
  // enough for a weekday and a time ("Sat 22:14").
  const columns = 'minmax(0, 1fr) auto 4.75rem';
  if (data === undefined)
    return <CountCard title="Machinery" columns={columns} loadingRows={8} {...props} />;
  // No read serves the jobs yet: say so, with no link to a health page that doesn't exist.
  if (data === null) {
    return (
      <CountCard title="Machinery" columns={columns} {...props}>
        <CountFoot data-slot="machinery-absent">Not recorded yet</CountFoot>
      </CountCard>
    );
  }
  return (
    <CountCard title="Machinery" columns={columns} {...props}>
      {data.jobs.map((job) => {
        const look = JOB[job.state];
        return (
          <CountRow
            key={job.id}
            data-state={job.state}
            mark={<StatusDot tone={look.dot} />}
            label={job.name}
            detail={look.word}
            detailTone={look.tone}
            value={job.at}
            tone="dim"
          />
        );
      })}
      <CountFoot action={<RowLink to={{ kind: 'machinery' }}>Health</RowLink>}>
        {data.more > 0
          ? `And ${data.more} more${data.moreAllOk ? ', all ok' : ''}`
          : 'Every job is listed'}
      </CountFoot>
    </CountCard>
  );
}

// ── People ───────────────────────────────────────────────────────────────────────────────────

export function PeopleCard({ data, ...props }: CardProps<PeopleCardData>) {
  if (data === undefined) return <CountCard title="People" loadingRows={7} {...props} />;
  const staff = sumCounts([data.admins, data.moderators]);
  const suspension = suspensionDetail(data.suspended, data.nextSuspensionEnds, dayMonth);
  return (
    <CountCard
      title="People"
      end={
        data.totalUsers != null ? (
          <SectionNote>{countText(data.totalUsers)} users</SectionNote>
        ) : undefined
      }
      {...props}
    >
      <CountRow
        label="Staff"
        detail={`${countText(data.admins)} admin · ${countText(data.moderators)} mod`}
        value={countText(staff)}
        tone={countTone(staff)}
        to={{ kind: 'people', list: 'staff' }}
      />
      <CountRow
        label="New this week"
        value={countText(data.newThisWeek)}
        tone={countTone(data.newThisWeek)}
        to={{ kind: 'people', list: 'new' }}
      />
      <CountRow
        label="Suspended"
        detail={suspension ?? undefined}
        value={countText(data.suspended)}
        tone={countTone(data.suspended, 'warn')}
        to={{ kind: 'people', list: 'suspended' }}
      />
      <CountRow
        label="Banned"
        value={countText(data.banned)}
        tone={countTone(data.banned)}
        to={{ kind: 'people', list: 'banned' }}
      />
      <CountRow
        label="Flagged people"
        detail={<RowLink to={{ kind: 'inbox', lane: 'contentFlags' }}>Inbox</RowLink>}
        value={countText(data.flaggedPeople)}
        tone={countTone(data.flaggedPeople)}
      />
      {data.appealsOpen !== null && (
        <CountRow
          label="Appeals open"
          detail={<RowLink to={{ kind: 'inbox', lane: 'support' }}>Support</RowLink>}
          value={countText(data.appealsOpen)}
          tone={countTone(data.appealsOpen)}
        />
      )}
      <CountRow
        label="Leaving · 30-day window"
        value={countText(data.leaving)}
        tone={countTone(data.leaving)}
        to={{ kind: 'people', list: 'leaving' }}
      />
    </CountCard>
  );
}
