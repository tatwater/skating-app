import { buildPostCardView, type PostCardData } from '@skating/core';
import { useState } from 'react';

import { cn } from '@/lib/utils';
import { Avatar } from '../../kit/avatar';
import { Badge } from '../../kit/badge';
import { Button } from '../../kit/button';
import { PersonName } from '../../PersonName';
import { clockLabel, dayLabel, whenLabel } from '../panels/panelTime';
import { Counts, ReportCard, Thumbs } from './ReportCard';

/**
 * One post (boards 4.1, 6.1; A10 / D186): the author's words over the lakes they skated, each lake a
 * `ReportCard` block. A post over two or more lakes draws its itinerary down the left, in the order
 * the author skated it. A legacy post — one report, no words — is just its report, with the byline.
 *
 * Props only, like `ReportCard`: the caller says where each report goes and what a click does.
 */
export interface FeedCardProps {
  post: PostCardData;
  now: number;
  /** Each report's link: `/report/<id>`, or `/latest?report=<id>` on Latest. */
  reportHref: (reportId: string) => string;
  onOpenReport: (reportId: string) => void;
  /**
   * `author`: Latest — the face, the name and the time. `date`: the profile, where whose it is is the
   * page — the day as a kicker instead.
   */
  head?: 'author' | 'date';
  /** The post's public counts, when the list carries them. */
  helpfulCount?: number;
  commentCount?: number;
  /** The report open beside the feed (Latest's center column). */
  selectedReportId?: string;
  /** The last post of a list carries no rule under it. */
  last?: boolean;
}

/** Past this, the body folds behind "Read more". */
const FOLD_CHARS = 240;
const FOLD_LINES = 4;

export function FeedCard({
  post,
  now,
  reportHref,
  onOpenReport,
  head = 'author',
  helpfulCount,
  commentCount,
  selectedReportId,
  last = false,
}: FeedCardProps) {
  const view = buildPostCardView(post, now);
  const [expanded, setExpanded] = useState(false);
  const sequence = post.reports.length > 1;
  const photos = post.reports.flatMap((r) => r.photoThumbUrls);
  const long =
    view.body !== null &&
    (view.body.length > FOLD_CHARS || view.body.split('\n').length > FOLD_LINES);

  return (
    <article
      data-slot="feed-card"
      className={cn(
        // Names and words: never autocaptured (D240).
        'ph-no-capture flex flex-col gap-(--space-3) border-0 border-b border-dotted border-line2 pb-[1.625rem]',
        last && 'border-b-0',
      )}
    >
      {view.hasHeader && (
        <>
          <header className="flex items-center gap-(--space-2_5)">
            {head === 'author' ? (
              <span className="flex min-w-0 items-center gap-(--space-2_5)">
                <Avatar
                  name={view.author.displayName}
                  {...(view.author.profileImageUrl !== undefined
                    ? { src: view.author.profileImageUrl }
                    : {})}
                />
                <PersonName
                  className={cn(
                    'min-w-0 truncate font-medium',
                    view.blocked ? 'text-fg3' : 'text-fg',
                  )}
                >
                  {view.author.displayName}
                </PersonName>
                {view.blocked && <Badge variant="outline">Blocked</Badge>}
              </span>
            ) : (
              <span className="text-kick leading-none font-medium tracking-label text-fg3 uppercase">
                {dayLabel(post.latestSkateEndTime, now)}
              </span>
            )}
            <span className="ml-auto font-(family-name:--family-mono) text-[0.71875rem] font-medium whitespace-nowrap text-fg2">
              {head === 'author'
                ? whenLabel(post.latestSkateEndTime, now)
                : clockLabel(post.latestSkateEndTime)}
              {view.edited ? ' · edited' : ''}
            </span>
          </header>
          {view.title !== null && (
            <h3 className="m-0 text-[1.1875rem] leading-[1.25] font-semibold text-fg">
              {view.title}
            </h3>
          )}
          {view.body !== null && (
            <div className="flex flex-col items-start gap-(--space-1)">
              <p
                className={cn(
                  'm-0 text-body leading-[1.55] whitespace-pre-line text-fg1 [text-wrap:pretty]',
                  !expanded && 'line-clamp-4',
                )}
              >
                {view.body}
              </p>
              {long && (
                <Button
                  size="xs"
                  variant="bare"
                  aria-expanded={expanded}
                  onClick={() => setExpanded((e) => !e)}
                >
                  {expanded ? 'Show less' : 'Read more'}
                </Button>
              )}
            </div>
          )}
        </>
      )}
      <ol
        className={cn(
          'm-0 flex list-none flex-col gap-(--space-2_5) p-0',
          sequence &&
            'relative pl-[1.125rem] before:absolute before:top-2 before:bottom-2 before:left-1 before:w-px before:bg-line2',
        )}
      >
        {post.reports.map((report) => (
          <li
            key={report.reportId}
            className={cn(
              'relative',
              sequence &&
                'before:absolute before:top-5 before:-left-[1.125rem] before:size-[0.5625rem] before:bg-fg2',
            )}
          >
            <ReportCard
              report={report}
              now={now}
              variant="block"
              showAuthor={!view.hasHeader}
              href={reportHref(report.reportId)}
              onOpen={() => onOpenReport(report.reportId)}
              selected={selectedReportId === report.reportId}
            />
          </li>
        ))}
      </ol>
      {view.omittedLabel !== null && (
        <p className="m-0 text-[0.75rem] text-fg3">{view.omittedLabel}</p>
      )}
      <Thumbs urls={photos} className="size-20" />
      <Counts helpful={helpfulCount} comments={commentCount} />
    </article>
  );
}
