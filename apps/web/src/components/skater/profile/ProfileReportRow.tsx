import { buildPostCardView, type PostCardData } from '@skating/core';

import { Badge } from '../../kit/badge';
import { navLinkProps } from '../chrome';
import { clockLabel, dayKicker } from './profileModel';

/**
 * One of the person's Posts on their profile (6.1, 6.3) — **an interim row**: the report card is
 * agent E's (`components/skater/cards/ReportCard`), and this stands in, over the same
 * `PostCardData` the feed sends, until it lands. The day and time head the post, then the author's
 * words, then a plate per lake. The whole row is someone's words: `ph-no-capture` (D240).
 */
export function ProfileReportRow({
  post,
  now,
  onNavigate,
}: {
  post: PostCardData;
  now: number;
  onNavigate: (href: string) => void;
}) {
  const view = buildPostCardView(post, now);
  return (
    <article
      data-slot="profile-post"
      className="ph-no-capture flex flex-col gap-(--space-3) border-0 border-line2 border-b border-dotted pb-(--space-6) last:border-b-0"
    >
      <div className="flex items-center gap-(--space-2_5)">
        <span className="font-medium text-fg2 text-kick uppercase leading-none tracking-kick">
          {dayKicker(post.latestSkateEndTime, now)}
        </span>
        <span className="ml-auto font-(family-name:--family-mono) text-fg2 text-mono-sm">
          {clockLabel(post.latestSkateEndTime)}
        </span>
      </div>
      {view.title && (
        <h3 className="m-0 font-semibold text-[1.1875rem] text-fg leading-[1.25]">{view.title}</h3>
      )}
      {view.body && <p className="m-0 text-pretty text-body text-fg1 leading-body">{view.body}</p>}
      {view.reports.map((r) => (
        <a
          key={r.reportId}
          {...navLinkProps(`/report/${r.reportId}`, onNavigate)}
          className="flex flex-col gap-(--space-2) rounded-control border border-line border-solid bg-panel px-(--space-4) py-(--space-3_5) text-inherit no-underline outline-none transition-colors duration-(--duration-fast) focus-visible:shadow-focus lit:border-line2"
        >
          <span className="flex items-baseline gap-(--space-2)">
            <b className="font-semibold text-fg">{r.locationPrimary}</b>
            {r.locationSecondary && (
              <span className="text-assist text-fg2">{r.locationSecondary}</span>
            )}
          </span>
          {(r.vantageLabel || r.durationLabel) && (
            <span className="text-assist text-fg2">
              {r.vantageLabel ?? `Skated ${r.durationLabel}`}
            </span>
          )}
          {(r.suitabilityLabel || r.qualityLabel) && (
            <span className="flex flex-wrap gap-(--space-1_5)">
              {r.suitabilityLabel && (
                <Badge variant="outline" tone={r.isDontGo ? 'bad' : 'default'}>
                  {r.suitabilityLabel}
                </Badge>
              )}
              {r.qualityLabel && <Badge>{r.qualityLabel}</Badge>}
            </span>
          )}
          {(r.chips.length > 0 || r.sightingLabels.length > 0) && (
            <span className="flex flex-wrap gap-(--space-1_5)">
              {[...r.chips, ...r.sightingLabels].map((chip) => (
                <span
                  key={chip}
                  className="border border-line2 border-solid px-(--space-2_5) py-(--space-1) text-assist text-fg1"
                >
                  {chip}
                </span>
              ))}
            </span>
          )}
        </a>
      ))}
    </article>
  );
}
