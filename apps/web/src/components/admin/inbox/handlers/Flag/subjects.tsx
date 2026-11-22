import { humanizeEnum } from '@skating/core';
import type { ComponentProps, ReactNode } from 'react';

import { Badge } from '@/components/kit/badge';
import { Button } from '@/components/kit/button';
import { FactList } from '@/components/kit/fact-list';
import { LifeStrip } from '@/components/kit/life-strip';
import { Note } from '@/components/kit/note';
import { Section } from '@/components/kit/section-slug';
import { cn } from '@/lib/utils';
import { AroundLine, type AroundState } from '../../around/AroundLine';
import { VANTAGE_WORDS } from '../../around/aroundModel';
import { alertCardFoot, alertLife } from './alertModel';
import { dayMonth, dayTime } from './flagFormat';
import { claimChips, reportKicker, verdictRows } from './flagModel';
import type {
  AlertSubjectData,
  AuthorBlockData,
  BodyRefData,
  CommentSubjectData,
  HazardSubjectData,
  PostSubjectData,
  ReportSubjectData,
} from './flagTypes';
import { ALERT_WORDS as A, FLAG_WORDS as W } from './flagWords';
import {
  ClaimChips,
  ClaimWeather,
  type Retry,
  SubHead,
  SubjectText,
  SubjectTitle,
  type WeatherState,
} from './parts';

/**
 * **What was flagged, one view per kind** — props only, so each has stories. Every subject that has
 * a place on a map takes a `map` slot (the Inbox embed: a report's point, a hazard's footprint, an
 * alert's launch boxed) and draws it in the right column, as boards 2.1 and 2.6 do; the rest take the
 * pane's width. A photo is another handler's.
 */

/** The subject row: the subject on the left, the map on the right, a rule under both. */
export function SubjectRow({
  map,
  mapWidth = 'report',
  children,
  className,
  ...props
}: ComponentProps<'div'> & { map?: ReactNode; mapWidth?: 'report' | 'alert' }) {
  return (
    <div
      data-slot="flag-subject"
      className={cn(
        'grid min-w-0 border-0 border-b border-solid border-line',
        // One column on a narrow pane (the map under the subject); the boards' map column beside it
        // from W3's breakpoint up — 280 px (2.1) and 300 px (2.6), no size token yet.
        // Only while the slot holds something: a map that draws nothing (a kind with no place, an
        // empty answer, a viewer who can't read bodies) leaves no column and no rule behind.
        map !== undefined &&
          (mapWidth === 'report'
            ? '@[45rem]:has-[>[data-slot=flag-map]:not(:empty)]:grid-cols-[minmax(0,1fr)_17.5rem]'
            : '@[45rem]:has-[>[data-slot=flag-map]:not(:empty)]:grid-cols-[minmax(0,1fr)_18.75rem]'),
        className,
      )}
      {...props}
    >
      <div className="flex min-w-0 flex-col gap-(--space-3) px-gutter pt-(--space-5) pb-(--space-3_5)">
        {children}
      </div>
      {map !== undefined && (
        <div
          data-slot="flag-map"
          className="relative min-h-0 min-w-0 border-0 border-t border-solid border-line empty:hidden @[45rem]:border-t-0 @[45rem]:border-s"
        >
          {map}
        </div>
      )}
    </div>
  );
}

// ── A report (2.1) ─────────────────────────────────────────────────────────────────────────────

export type ReportSubjectProps = {
  report: ReportSubjectData;
  /** The Safety lane: the claim under question marked, *That night* and *Around it* drawn. */
  safety: boolean;
  weather?: WeatherState;
  around?: AroundState;
  onCompare?: () => void;
  /** *Try again* for a failed weather or *Around it* read. */
  retry?: Retry;
  map?: ReactNode;
  timeZone?: string;
};

/**
 * **A report** (board 2.1): where and when — and the vantage, on the ice, from shore or secondhand,
 * nothing else — the body, the notes, the claims as it states them, then (in the Safety lane) *That
 * night, at the body* and *Around it*, context beside the claim and never a verdict on it.
 */
export function ReportSubject({
  report,
  safety,
  weather,
  around,
  onCompare,
  retry,
  map,
  timeZone,
}: ReportSubjectProps) {
  return (
    <SubjectRow map={map} data-subject="report">
      <ReportCore report={report} safety={safety} timeZone={timeZone} />
      {weather !== undefined && <ClaimWeather weather={weather} {...retry} />}
      {around !== undefined && (
        <AroundLine
          state={around}
          {...retry}
          bodyName={report.body.name}
          {...(onCompare !== undefined && { onCompare })}
        />
      )}
    </SubjectRow>
  );
}

/** A report's own block: its kicker, its body, its notes, its claims. */
export function ReportCore({
  report,
  safety,
  timeZone,
  compact = false,
}: {
  report: ReportSubjectData;
  safety: boolean;
  timeZone?: string | undefined;
  /** A Post's member: the body's name stays in the kicker, not as a title. */
  compact?: boolean;
}) {
  return (
    <>
      {compact ? (
        <span
          data-slot="subject-kicker"
          className="text-kick leading-none font-semibold tracking-kick text-fg3 uppercase"
        >
          {reportKicker(report, timeZone)}
        </span>
      ) : (
        <SubjectTitle kicker={reportKicker(report, timeZone)} title={report.body.name} />
      )}
      {report.notes !== null && report.notes.trim() !== '' ? (
        <SubjectText>{report.notes}</SubjectText>
      ) : isDownStatus(report.moderationStatus) ? (
        <WordsHidden />
      ) : (
        <SubjectText className="text-fg3">{W.noNotes}</SubjectText>
      )}
      <ClaimChips chips={claimChips(report.claims, safety)} />
    </>
  );
}

// ── A Post ─────────────────────────────────────────────────────────────────────────────────────

/** **A Post** (derived from 2.1): its words, then each of its reports as 2.1's report block. */
export function PostSubject({
  post,
  safety,
  down = false,
  timeZone,
}: {
  post: PostSubjectData;
  safety: boolean;
  /** Hidden or removed: words the server held back say so. */
  down?: boolean;
  timeZone?: string;
}) {
  return (
    <SubjectRow data-subject="post">
      <SubjectTitle kicker={W.postKicker} title={post.title ?? W.untitledPost} />
      {post.body !== null && post.body.trim() !== '' ? (
        <SubjectText>{post.body}</SubjectText>
      ) : (
        down && post.title === null && <WordsHidden />
      )}
      <SubHead>{W.postReports(post.reports.length)}</SubHead>
      <ol className="m-0 flex list-none flex-col gap-(--space-4) p-0">
        {post.reports.map((r) => (
          <li
            key={r.reportId}
            data-slot="post-report"
            className="flex flex-col gap-(--space-2) border-0 border-s-(length:--stroke-hair) border-solid border-line ps-(--space-3)"
          >
            <ReportCore report={r} safety={safety} timeZone={timeZone} compact />
          </li>
        ))}
      </ol>
    </SubjectRow>
  );
}

// ── A comment ──────────────────────────────────────────────────────────────────────────────────

/** **A comment** (derived from 2.1): its thread's head above it, as far as the view gives it. */
export function CommentSubject({
  comment,
  down = false,
  timeZone,
}: {
  comment: CommentSubjectData;
  /** Hidden or removed: words the server held back say so. */
  down?: boolean;
  timeZone?: string;
}) {
  const head = comment.on.head;
  return (
    <SubjectRow data-subject="comment">
      <span
        data-slot="subject-kicker"
        className="text-kick leading-none font-semibold tracking-kick text-fg3 uppercase"
      >
        {W.commentKicker} · {dayTime(comment.createdAt, timeZone)}
      </span>
      {head !== null && (
        <div data-slot="comment-on" className="flex flex-col gap-(--space-1)">
          <span className="text-kick leading-none font-semibold tracking-kick text-fg3 uppercase">
            {W.commentOn}
          </span>
          <span className="text-row leading-snug text-fg2">{head}</span>
        </div>
      )}
      {comment.body.trim() !== '' ? (
        <SubjectText
          data-slot="comment-body"
          className="border-0 border-s-(length:--stroke-note) border-solid border-fg2 ps-(--space-3)"
        >
          {comment.body}
        </SubjectText>
      ) : (
        down && <WordsHidden />
      )}
    </SubjectRow>
  );
}

// ── A hazard ───────────────────────────────────────────────────────────────────────────────────

/** **A hazard** (derived from 2.1): its kind, its words, its footprint on the map, its votes. */
export function HazardSubject({
  hazard,
  down = false,
  map,
  timeZone,
}: {
  hazard: HazardSubjectData;
  /** Hidden or removed: words the server held back say so. */
  down?: boolean;
  map?: ReactNode;
  timeZone?: string;
}) {
  const kicker = [W.hazardKicker, hazard.body?.name, dayTime(hazard.createdAt, timeZone)]
    .filter((x): x is string => x !== undefined && x !== null)
    .join(' · ');
  return (
    <SubjectRow map={map} data-subject="hazard">
      <SubjectTitle kicker={kicker} title={humanizeEnum(hazard.type)} />
      {hazard.note !== null && hazard.note.trim() !== '' ? (
        <SubjectText>{hazard.note}</SubjectText>
      ) : (
        down && <WordsHidden />
      )}
      <HazardVotes hazard={hazard} />
      {hazard.point === null && (
        <span className="text-assist leading-list text-fg3">{W.hazardFootprintMissing}</span>
      )}
    </SubjectRow>
  );
}

/**
 * **A hazard's votes, as skaters cast them**: each of the four verdicts in core's order with core's
 * words for this hazard's type (a passage marker relabels them all) and its count, a verdict nobody
 * cast drawn quietly rather than left out. No net, no sides, no color, no order by count: who said
 * what is the moderator's to weigh, and none of it is a reading of the ice (D3).
 */
export function HazardVotes({
  hazard,
}: {
  hazard: Pick<HazardSubjectData, 'type' | 'votes' | 'votesCapped'>;
}) {
  const rows = verdictRows(hazard);
  return (
    <section data-slot="hazard-votes" className="flex flex-col gap-(--space-1_5)">
      <SubHead>{W.hazardVotesTitle}</SubHead>
      {rows === null ? (
        <span data-slot="hazard-votes-none" className="text-row leading-list text-fg2">
          {W.hazardVotesNone}
        </span>
      ) : (
        <>
          <ul className="m-0 flex list-none flex-col gap-(--space-1) p-0">
            {rows.map((r) => (
              <li
                key={r.verdict}
                data-slot="hazard-verdict"
                data-verdict={r.verdict}
                data-none={r.none ? '' : undefined}
                className={cn(
                  'grid grid-cols-[3rem_minmax(0,1fr)] items-baseline gap-x-(--space-2_5) text-row leading-list',
                  r.none ? 'text-fg3' : 'text-fg1',
                )}
              >
                <span
                  data-slot="hazard-verdict-count"
                  className="text-right font-(family-name:--family-mono) text-mono-sm tabular-nums"
                >
                  {r.count}
                </span>
                <span data-slot="hazard-verdict-label">{r.label}</span>
              </li>
            ))}
          </ul>
          <span data-slot="hazard-votes-what" className="text-assist leading-list text-fg3">
            {W.hazardVotesWhat}
          </span>
        </>
      )}
    </section>
  );
}

// ── An access alert (2.6) ──────────────────────────────────────────────────────────────────────

export type AlertSubjectProps = {
  alert: AlertSubjectData;
  /** The alert's one-line summary, quoted as its title ("Fairlee launch closed"). */
  summary: string;
  /** The flags, as the subject's own *The flag* (2.6 puts them under the skater's card). */
  flags: ReactNode;
  map?: ReactNode;
  now: number;
  timeZone?: string;
};

/**
 * **An access alert** (board 2.6): the alert as skaters meet it, the flag under it, the map with
 * the launch boxed; then its life as the kit's strip map.
 */
export function AlertSubject({ alert, summary, flags, map, now, timeZone }: AlertSubjectProps) {
  const kicker = [W.alertKicker, alert.body.name, alert.body.place]
    .filter((x): x is string => typeof x === 'string' && x !== '')
    .join(' · ');
  const life = alertLife(alert, now, timeZone);
  return (
    <>
      <SubjectRow map={map} mapWidth="alert" data-subject="accessAlert">
        <SubjectTitle kicker={kicker} title={`“${summary}”`} />
        <SubHead>{A.asSkatersSee}</SubHead>
        <div
          data-slot="alert-card"
          className="flex max-w-[26.25rem] flex-col gap-(--space-1_5) border border-solid border-line2 bg-panel px-(--space-3) py-(--space-2_5)"
        >
          <div className="flex items-center gap-(--space-2)">
            <i aria-hidden="true" className="size-(--space-2) shrink-0 bg-warn" />
            <span className="truncate text-kick leading-none font-semibold tracking-kick text-fg uppercase">
              {alert.place.name ?? alert.body.name}
            </span>
            {alert.status === 'official' && (
              <Badge variant="outline" tone="lit" className="ms-auto">
                {A.official}
              </Badge>
            )}
          </div>
          {alert.note !== null && alert.note.trim() !== '' && (
            <span className="text-row leading-body text-fg1">{alert.note}</span>
          )}
          <span className="font-(family-name:--family-mono) text-kick leading-none tracking-micro text-fg3 uppercase">
            {alertCardFoot(alert, timeZone)}
          </span>
        </div>
        {flags}
      </SubjectRow>
      <Section data-slot="alert-life" level={3} title={A.life} className="px-gutter pt-(--space-5)">
        {/* The kit strip stacks top to bottom on its own when its stations don't fit across. */}
        <LifeStrip aria-label={A.life} stations={life.stations} lines={life.lines} />
      </Section>
    </>
  );
}

/** 2.6's two columns under the life: the alert's facts, and what each drawn lever does. */
export function AlertFacts({
  alert,
  author,
  does,
}: {
  alert: AlertSubjectData;
  author: ReactNode;
  does: { label: string; value: string }[];
}) {
  return (
    <div className="grid grid-cols-1 gap-x-(--space-7) gap-y-(--space-5) px-gutter pt-(--space-5) @[45rem]:grid-cols-2">
      <Section data-slot="alert-facts" level={3} title={A.theAlert}>
        <FactList
          rows={[
            { label: A.author, value: author },
            { label: A.reason, value: humanizeEnum(alert.reason) },
            { label: A.votes, value: A.votesLine(alert.confirmCount, alert.denyCount) },
          ]}
        />
      </Section>
      {does.length > 0 && (
        <Section data-slot="alert-does" level={3} title={A.whatEachDoes}>
          <FactList rows={does} />
        </Section>
      )}
    </div>
  );
}

// ── A body ─────────────────────────────────────────────────────────────────────────────────────

/**
 * **A flag on a body** that isn't an access report (derived from 2.6's head): the body by name and
 * place, with the map; the head links its Body console. No content levers — a body is changed in the
 * Body console, never from a flag.
 */
export function BodySubject({
  body,
  summary,
  map,
}: {
  body: BodyRefData;
  summary: string;
  map?: ReactNode;
}) {
  return (
    <SubjectRow map={map} data-subject="waterbody">
      <SubjectTitle
        kicker={[W.bodyKicker, body.place].filter((x) => x !== null && x !== '').join(' · ')}
        title={body.name}
      />
      {summary.trim() !== '' && summary !== body.name && <SubjectText>{summary}</SubjectText>}
    </SubjectRow>
  );
}

// ── The states a target can be in ──────────────────────────────────────────────────────────

const isDownStatus = (s: string | null) => s === 'hidden' || s === 'removed';

/**
 * Hidden or removed words the server didn't send: only staff who can read hidden content get them
 * (`content.read`) — said, never drawn as an empty report.
 */
export function WordsHidden() {
  return (
    <SubjectText data-slot="words-hidden" className="text-fg3">
      {W.wordsHidden}
    </SubjectText>
  );
}

/**
 * Withdrawn by its author, or erased: never read as still up. What a moderator may still do — keep a
 * decision on the record (D248) — is the bar's, from `can`; nothing here brings it back.
 */
export function WithdrawnNote({
  at,
  withdrawal,
  timeZone,
}: {
  at: number;
  /** Which withdrawal: its author deleted it, or the 30-day sweep erased it (only a comment is). */
  withdrawal: 'deleted' | 'erased';
  timeZone?: string | undefined;
}) {
  return (
    <Note data-slot="subject-withdrawn" data-withdrawal={withdrawal}>
      <strong>{W.withdrawn(dayMonth(at, timeZone))}</strong>
      <span className="block">{W.withdrawnSub[withdrawal]}</span>
    </Note>
  );
}

/** An access alert its author took down: skaters no longer see it. */
export function RetractedNote({
  at,
  timeZone,
}: {
  at: number | null;
  timeZone?: string | undefined;
}) {
  return (
    <Note data-slot="subject-retracted">
      <strong>{at === null ? A.status.retracted : W.retracted(dayMonth(at, timeZone))}</strong>
      <span className="block">{W.retractedSub}</span>
    </Note>
  );
}

/** The content is gone (its author deleted it, or it was erased); the flags on it still wait. */
export function GoneSubject() {
  return (
    <SubjectRow data-subject="gone">
      <Note data-slot="subject-gone">
        <strong>{W.gone}</strong>
        <span className="block">{W.goneSub}</span>
      </Note>
    </SubjectRow>
  );
}

/** The content was already down when this flag was read: Restore is what the bar offers. */
export function DownNote({ status }: { status: 'hidden' | 'removed' }) {
  return (
    <Note tone="warn" data-slot="subject-down" data-status={status}>
      <strong>{W.down[status]}</strong>
      <span className="block">{W.downSub}</span>
    </Note>
  );
}

/**
 * The reports the contradiction check counted (a person flag), newest first: each its day and
 * vantage, and a link to the report in the app, in a new tab — the page is live today and shows the
 * report as skaters meet it, with a moderator's own controls there (Reports, in the console, isn't
 * built). The count is the rule's tally; the list is its newest ten.
 */
export function ContradictedReports({
  author,
  timeZone,
}: {
  author: AuthorBlockData;
  timeZone?: string | undefined;
}) {
  if (author.contradictedReports.length === 0) return null;
  return (
    <Section
      data-slot="contradicted-reports"
      level={3}
      title={W.contradictedReports}
      count={author.contradicted ?? author.contradictedReports.length}
      className="pt-(--space-3)"
    >
      <ol className="m-0 flex list-none flex-col p-0">
        {author.contradictedReports.map((r) => (
          <li
            key={r.reportId}
            data-slot="contradicted-report"
            className="flex min-h-(--size-td) items-center justify-between gap-(--space-3) border-0 border-b border-dotted border-line last:border-b-0"
          >
            <span className="text-row leading-list text-fg1">
              {[
                dayMonth(r.skateEndTime, timeZone),
                r.observedFrom === null ? null : VANTAGE_WORDS[r.observedFrom],
              ]
                .filter((x): x is string => x !== null)
                .join(' · ')}
            </span>
            <Button
              variant="link"
              size="xs"
              external
              nativeButton={false}
              render={
                <a href={`/report/${r.reportId}`} target="_blank" rel="noopener noreferrer" />
              }
            >
              {W.openInApp}
            </Button>
          </li>
        ))}
      </ol>
    </Section>
  );
}
