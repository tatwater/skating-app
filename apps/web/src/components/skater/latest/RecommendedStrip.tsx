import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faStar } from '@fortawesome/sharp-solid-svg-icons';
import { buildFeedCardView, type FeedCardData, SKATE_QUALITY_LABELS } from '@skating/core';

import { BodySilhouette } from '../../BodySilhouette';
import { Section } from '../../kit/section-slug';
import { PersonName } from '../../PersonName';
import { Chips } from '../cards/ReportChips';
import { navLinkProps } from '../chrome';
import { panelTriggerProps } from '../panels/panelNavigation';
import { ageLabel, dayLabel } from '../panels/panelTime';

/** One recommended bundle: a lake and its one or two exceptional reports (`reports.recommended`). */
export interface RecommendedBundle {
  waterBodyId: string;
  cards: FeedCardData[];
}

/**
 * The Recommended strip (boards 4.1–4.3; D50): exceptional, corroborated ice **outside the viewer's
 * filters**, labeled as exactly that — it ignores the filter row on purpose, which is why it sits in
 * its own column and never inside the filtered feed. A separate query; the page subtracts these
 * reports from the feed so nobody sees one twice. Renders nothing when nothing qualifies, which is
 * the common case.
 *
 * Each lake is one card that opens its newest recommended report in the drawer. A lake with a second
 * recommended report lists it under the card as its own link: the page takes every recommended
 * report out of the feed, so a report the card counted but couldn't open would be nowhere on the
 * page.
 */
export function RecommendedStrip({
  bundles,
  now,
  reportHref,
  onOpenReport,
}: {
  bundles: readonly RecommendedBundle[] | undefined;
  now: number;
  reportHref: (reportId: string) => string;
  onOpenReport: (reportId: string) => void;
}) {
  if (bundles === undefined || bundles.length === 0) return null;
  return (
    <Section title="Recommended" data-slot="latest-recommended">
      <p className="m-0 max-w-[13.5rem] text-assist text-fg2 [text-wrap:pretty]">
        Exceptional, corroborated ice outside your usual filters.
      </p>
      {bundles.map((bundle) => (
        <RecommendedCard
          key={bundle.waterBodyId}
          bundle={bundle}
          now={now}
          reportHref={reportHref}
          onOpenReport={onOpenReport}
        />
      ))}
    </Section>
  );
}

function RecommendedCard({
  bundle,
  now,
  reportHref,
  onOpenReport,
}: {
  bundle: RecommendedBundle;
  now: number;
  reportHref: (reportId: string) => string;
  onOpenReport: (reportId: string) => void;
}) {
  const [first] = bundle.cards;
  if (first === undefined) return null;
  const view = buildFeedCardView(first, now);
  const newest = Math.max(...bundle.cards.map((c) => c.skateEndTime));
  const quality =
    first.skateQuality !== undefined ? SKATE_QUALITY_LABELS[first.skateQuality] : null;
  const n = bundle.cards.length;
  const line = [`${n} ${n === 1 ? 'report' : 'reports'}`, quality, dayLabel(newest, now)]
    .filter((part): part is string => part !== null)
    .join(' · ');
  const link = navLinkProps(reportHref(first.reportId), () => onOpenReport(first.reportId));
  const others = bundle.cards.slice(1);
  return (
    <div data-slot="recommended-card" className="flex flex-col border border-solid border-line2">
      <a
        href={link.href}
        onClick={link.onClick}
        {...panelTriggerProps('report', first.reportId)}
        data-attr="latest-recommended"
        aria-label={`Recommended: ${first.bodyName}, ${line}`}
        className="ph-no-capture flex flex-col gap-(--space-2) p-(--space-3_5) text-inherit no-underline outline-none hover:bg-lift-03 focus-visible:shadow-focus"
      >
        <span className="flex items-center gap-(--space-3)">
          {first.silhouette !== undefined && (
            <span className="flex size-10 shrink-0 items-center justify-center">
              <BodySilhouette data={first.silhouette} size={40} />
            </span>
          )}
          <span className="flex min-w-0 flex-col">
            <span className="flex items-center gap-(--space-1_5) font-semibold text-fg">
              {view.isFavorite && (
                <span role="img" aria-label="Favorite" className="flex shrink-0 text-star">
                  <FontAwesomeIcon icon={faStar} aria-hidden="true" className="h-3" />
                </span>
              )}
              <span className="truncate">{first.bodyName}</span>
            </span>
            <span className="text-assist text-fg2">{line}</span>
          </span>
        </span>
        <Chips values={view.chips.slice(0, 3)} />
      </a>
      {others.map((card) => (
        <OtherReportLink
          key={card.reportId}
          card={card}
          now={now}
          reportHref={reportHref}
          onOpenReport={onOpenReport}
        />
      ))}
    </div>
  );
}

/** A lake's further recommended report, under its card: who posted it and when, opening it. */
function OtherReportLink({
  card,
  now,
  reportHref,
  onOpenReport,
}: {
  card: FeedCardData;
  now: number;
  reportHref: (reportId: string) => string;
  onOpenReport: (reportId: string) => void;
}) {
  const link = navLinkProps(reportHref(card.reportId), () => onOpenReport(card.reportId));
  return (
    <a
      href={link.href}
      onClick={link.onClick}
      {...panelTriggerProps('report', card.reportId)}
      data-slot="recommended-other"
      data-attr="latest-recommended"
      className="ph-no-capture border-0 border-t border-solid border-line2 px-(--space-3_5) py-(--space-2) text-assist text-fg2 no-underline outline-none hover:bg-lift-03 focus-visible:shadow-focus"
    >
      Also from <PersonName>{card.author.displayName}</PersonName> ·{' '}
      {ageLabel(card.skateEndTime, now)}
    </a>
  );
}
