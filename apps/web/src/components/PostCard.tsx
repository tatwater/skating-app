import { buildPostCardView, type PostCardData } from '@skating/core';
import { useState } from 'react';
import { FeedCard } from './FeedCard';
import { BlockedChip } from './SafetyControls';
import { TrustAvatar } from './TrustDisplay';
import { Button } from './ui/button';

/**
 * One Post in the newsfeed (A10 / D186): the author's words over the lakes they skated.
 *
 * Two registers, kept visibly apart because they *are* apart — the words are the author's and the
 * data is the lake's. The header is prose: who, when, the subject-line title the community already
 * writes ("Crystal Lake, Enfield 12/6"), and the body in the author's voice, clamped to a few lines
 * with the rest a tap away, in place. Under it, one `FeedCard` per Report as it has always looked,
 * each a button to that Report. A Post over two or more lakes gets a hairline rail down the left
 * with a mark per lake — the day's itinerary in the order the author skated it, which is the one
 * thing about a multi-lake Post a reader cannot get from the blocks alone.
 *
 * A legacy Post — one Report, no words — has no header and *is* the report card, unchanged: the
 * quarter of reporters who write five chips get the card they always got. `buildPostCardView`
 * makes that call so mobile and web make it the same way.
 */
export function PostCard({
  data,
  now,
  onOpenReport,
}: {
  data: PostCardData;
  now: number;
  onOpenReport: (reportId: string) => void;
}) {
  const view = buildPostCardView(data, now);
  const [expanded, setExpanded] = useState(false);
  const first = data.reports[0];
  if (!view.hasHeader && first) {
    return <FeedCard data={first} now={now} onOpen={() => onOpenReport(first.reportId)} />;
  }
  const sequence = view.reports.length > 1;

  return (
    <article className="flex flex-col rounded-lg border border-border bg-surface">
      <header className="flex flex-col gap-2 p-3 pb-1">
        <div className="flex items-center gap-2 text-foreground-muted text-sm">
          <TrustAvatar
            displayName={view.author.displayName}
            imageUrl={view.author.profileImageUrl}
            trustClass={view.author.trustClass}
            size={20}
          />
          <span className={`min-w-0 truncate ${view.blocked ? '' : 'text-foreground'}`}>
            {view.author.displayName}
          </span>
          {view.blocked ? <BlockedChip /> : null}
          <span className="ml-auto shrink-0 text-xs">
            {view.relativeTime}
            {view.edited ? ' · edited' : null}
          </span>
        </div>
        {view.title ? <h3 className="font-medium text-foreground">{view.title}</h3> : null}
        {view.body ? (
          <div className="flex flex-col items-start gap-1">
            <p
              className={`whitespace-pre-line text-foreground text-sm leading-relaxed ${expanded ? '' : 'line-clamp-4'}`}
            >
              {view.body}
            </p>
            {view.body.length > 240 || view.body.split('\n').length > 4 ? (
              <Button
                variant="ghost"
                size="sm"
                className="-ml-2 h-7 px-2 text-foreground-muted"
                onClick={() => setExpanded((e) => !e)}
                aria-expanded={expanded}
              >
                {expanded ? 'Show less' : 'Read more'}
              </Button>
            ) : null}
          </div>
        ) : null}
      </header>

      <div className={sequence ? 'relative pl-5' : ''}>
        {sequence ? (
          <div aria-hidden className="absolute top-3 bottom-3 left-[13px] w-px bg-border" />
        ) : null}
        {data.reports.map((report) => (
          <div key={report.reportId} className="relative">
            {sequence ? (
              <span
                aria-hidden
                className="absolute top-[18px] left-[-10px] size-[7px] rounded-full border border-border bg-surface"
              />
            ) : null}
            <FeedCard data={report} now={now} nested onOpen={() => onOpenReport(report.reportId)} />
          </div>
        ))}
      </div>

      {view.omittedLabel ? (
        <p className="px-3 pb-3 text-foreground-muted text-xs">{view.omittedLabel}</p>
      ) : (
        <div className="pb-1" />
      )}
    </article>
  );
}
