import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faComment, faThumbsUp } from '@fortawesome/sharp-light-svg-icons';
import { faStar } from '@fortawesome/sharp-solid-svg-icons';
import { buildFeedCardView, type FeedCardData, type FeedCardView } from '@skating/core';

import { cn } from '@/lib/utils';

import { BodySilhouette } from '../../BodySilhouette';
import { Avatar } from '../../kit/avatar';
import { Badge } from '../../kit/badge';
import { PersonName } from '../../PersonName';
import { navLinkProps } from '../chrome';
import { panelTriggerProps } from '../panels/panelNavigation';
import { whenLabel } from '../panels/panelTime';
import { Chips, ClaimBadges } from './ReportChips';

/**
 * One report, as a list shows it (boards 1.2, 4.1, 6.1): the shared row that Explore's Reports tab,
 * Latest and the profile all render, so a report reads the same wherever it's met.
 *
 * **Props only** — no Convex, no router. The report is core's `FeedCardData` (what `posts.listFeed`
 * and `profiles.getPublicProfile` already send); the caller says where the card goes (`href`, a
 * real link, so a modified click opens a new tab) and what a plain click does (`onOpen`, which
 * routes in-app — pass `panelLinkState(source)` as the navigation's state so the card counts its
 * door and Back can be a step back).
 *
 * A blocked author's report still shows (D3): the name dims and says "Blocked"; the report itself is
 * never hidden or faded, because a block is not a verdict on the ice.
 */
export interface ReportCardProps {
  report: FeedCardData;
  /** The clock the age words read from: one `now` per list, so its rows agree. */
  now: number;
  /** Where the card goes: `/report/<id>`, or `/latest?report=<id>` on Latest. */
  href: string;
  /** A plain left click (a modified one follows `href` in a new tab). */
  onOpen: () => void;
  /**
   * `row`: a list's row — the face and name, then where (the lake's Reports tab, a profile).
   * `block`: a report inside a post (`FeedCard`) — the panel ground, the lake's silhouette and the
   * hours, the author only when `showAuthor`.
   */
  variant?: 'row' | 'block';
  /** The author's face and name. A block inside a post leaves them to the post's head. */
  showAuthor?: boolean;
  /** The list is already this lake's (its own Reports tab): say the bay, not the lake. */
  hideBody?: boolean;
  /** The words the row quotes — the post's body or the report's notes — clamped to three lines. */
  excerpt?: string;
  /** The public counts for the row's foot, when the list carries them. */
  helpfulCount?: number;
  commentCount?: number;
  /** The server stopped counting at its cap: the count is a floor, shown as "20+". */
  helpfulCountCapped?: boolean;
  commentCountCapped?: boolean;
  /** The row is the one open beside it (Latest's center column). */
  selected?: boolean;
  /** The last row of a list carries no rule under it. */
  last?: boolean;
}

export function ReportCard({
  report,
  now,
  href,
  onOpen,
  variant = 'row',
  showAuthor = variant === 'row',
  hideBody = false,
  excerpt,
  helpfulCount,
  commentCount,
  helpfulCountCapped = false,
  commentCountCapped = false,
  selected = false,
  last = false,
}: ReportCardProps) {
  const card = buildFeedCardView(report, now);
  const link = navLinkProps(href, () => onOpen());
  const label = `Report on ${placeLine(card, hideBody) ?? card.bodyName}, ${whenLabel(card.skateEndTime, now)}`;
  return (
    <a
      href={link.href}
      onClick={link.onClick}
      aria-label={label}
      aria-current={selected ? 'true' : undefined}
      data-slot="report-card"
      data-variant={variant}
      data-blocked={card.blocked ? '' : undefined}
      data-attr="report-card"
      {...panelTriggerProps('report', card.reportId)}
      className={cn(
        // A whole-row link: square (it's a card), with the kit's focus ring and a lift on hover.
        'group/card block text-inherit no-underline outline-none focus-visible:shadow-focus',
        variant === 'row'
          ? [
              'flex flex-col gap-(--space-2_5) border-0 border-b border-dotted border-line2 py-(--space-4) hover:bg-lift-03',
              last && 'border-b-0',
            ]
          : 'flex gap-(--space-4) border border-solid border-line bg-panel py-(--space-3_5) pr-(--space-3_5) pl-(--space-4) hover:border-line2',
        selected && 'bg-lift-05 shadow-[inset_2px_0_0_var(--fg)]',
      )}
    >
      {variant === 'row' ? (
        <RowBody
          card={card}
          now={now}
          showAuthor={showAuthor}
          hideBody={hideBody}
          excerpt={excerpt}
          helpfulCount={helpfulCount}
          commentCount={commentCount}
          helpfulCountCapped={helpfulCountCapped}
          commentCountCapped={commentCountCapped}
        />
      ) : (
        <BlockBody card={card} report={report} showAuthor={showAuthor} hideBody={hideBody} />
      )}
    </a>
  );
}

/** "Mascoma South · Enfield, NH" — or, on the lake's own tab, only what's finer than the lake. */
function placeLine(card: FeedCardView, hideBody: boolean): string | null {
  if (hideBody) return card.locationPrimary === card.bodyName ? null : card.locationPrimary;
  return card.locationSecondary !== null
    ? `${card.locationPrimary} · ${card.locationSecondary}`
    : card.locationPrimary;
}

function Byline({ card, compact }: { card: FeedCardView; compact?: boolean }) {
  return (
    <span className="flex min-w-0 items-center gap-(--space-2_5)">
      <Avatar
        name={card.author.displayName}
        size={compact ? 'sm' : 'md'}
        {...(card.author.profileImageUrl !== undefined ? { src: card.author.profileImageUrl } : {})}
      />
      <PersonName
        className={cn(
          'min-w-0 truncate font-medium',
          compact ? 'text-assist' : 'text-body',
          card.blocked ? 'text-fg3' : 'text-fg',
        )}
      >
        {card.author.displayName}
      </PersonName>
      {card.blocked && <Badge variant="outline">Blocked</Badge>}
    </span>
  );
}

function RowBody({
  card,
  now,
  showAuthor,
  hideBody,
  excerpt,
  helpfulCount,
  commentCount,
  helpfulCountCapped,
  commentCountCapped,
}: {
  card: FeedCardView;
  now: number;
  showAuthor: boolean;
  hideBody: boolean;
  excerpt: string | undefined;
  helpfulCount: number | undefined;
  commentCount: number | undefined;
  helpfulCountCapped: boolean;
  commentCountCapped: boolean;
}) {
  const place = placeLine(card, hideBody);
  const where = [
    place,
    card.durationLabel !== null ? `on the ice ${card.durationLabel}` : null,
  ].filter((part): part is string => part !== null);
  return (
    <>
      <span className="flex items-center gap-(--space-2_5)">
        {showAuthor ? (
          <Byline card={card} />
        ) : (
          <span className="flex min-w-0 items-center gap-(--space-1_5) font-medium text-fg">
            {card.isFavorite && <FavoriteStar />}
            <span className="truncate">{card.locationPrimary}</span>
          </span>
        )}
        <span className="ml-auto font-(family-name:--family-mono) text-[0.71875rem] font-medium whitespace-nowrap text-fg2">
          {whenLabel(card.skateEndTime, now)}
          {card.edited ? ' · edited' : ''}
        </span>
      </span>
      {(where.length > 0 || card.isHikeIn) && (
        <span className="flex items-center gap-(--space-2) text-assist text-fg2">
          {showAuthor && card.isFavorite && <FavoriteStar />}
          <span className="min-w-0">{where.join(' · ')}</span>
          {card.isHikeIn && <HikeIn />}
        </span>
      )}
      <ClaimBadges claims={card} />
      {excerpt !== undefined && excerpt !== '' && (
        <span className="line-clamp-3 text-body leading-body text-fg1 [text-wrap:pretty]">
          {excerpt}
        </span>
      )}
      <Chips values={card.chips.slice(0, MAX_CHIPS)} />
      <Thumbs urls={card.photoThumbUrls} className="h-12 w-16" />
      <Counts
        helpful={helpfulCount}
        comments={commentCount}
        helpfulCapped={helpfulCountCapped}
        commentsCapped={commentCountCapped}
      />
    </>
  );
}

function BlockBody({
  card,
  report,
  showAuthor,
  hideBody,
}: {
  card: FeedCardView;
  report: FeedCardData;
  showAuthor: boolean;
  hideBody: boolean;
}) {
  const secondary = hideBody ? null : card.locationSecondary;
  return (
    <>
      <span className="flex min-w-0 flex-1 flex-col gap-(--space-2_5)">
        <span className="flex items-baseline gap-(--space-2)">
          {card.isFavorite && <FavoriteStar />}
          <b className="font-semibold text-fg">{card.locationPrimary}</b>
          {secondary !== null && <span className="text-assist text-fg2">{secondary}</span>}
          {card.isHikeIn && (
            <span className="ml-auto self-center">
              <HikeIn />
            </span>
          )}
        </span>
        {showAuthor ? (
          <span className="flex items-center gap-(--space-2) text-assist text-fg2">
            <Byline card={card} compact />
            {card.durationLabel !== null && <span>· skated {card.durationLabel}</span>}
          </span>
        ) : (
          <span className="text-assist text-fg2">
            {card.durationLabel !== null
              ? `Skated ${card.durationLabel}`
              : report.observedFrom === 'shore'
                ? 'Watched from shore'
                : null}
          </span>
        )}
        <ClaimBadges claims={card} />
        <Chips values={card.chips.slice(0, MAX_CHIPS)} />
      </span>
      <span className="flex w-[5.5rem] shrink-0 flex-col items-center gap-(--space-1_5)">
        {report.silhouette !== undefined && <BodySilhouette data={report.silhouette} size={64} />}
        <span className="font-(family-name:--family-mono) text-[0.65625rem] font-medium whitespace-nowrap text-fg3">
          {hoursLabel(card.skateEndTime, report.skateStartTime)}
        </span>
      </span>
    </>
  );
}

/** A card shows at most this many chips; the open report has them all. */
const MAX_CHIPS = 4;

/** "9:30–11:30", or "11:40" when the start wasn't given. The day is the list's. */
export function hoursLabel(end: number, start?: number): string {
  const fmt = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  const bare = (ms: number) => fmt.format(ms).replace(/\s?[AP]M$/, '');
  return start !== undefined && start < end ? `${bare(start)}–${bare(end)}` : bare(end);
}

function FavoriteStar() {
  return (
    <span role="img" aria-label="Favorite" className="flex shrink-0 text-star">
      <FontAwesomeIcon icon={faStar} aria-hidden="true" className="h-3" />
    </span>
  );
}

/** The easiest approach is a walk (D87): said beside the drive time, never folded into it. */
function HikeIn() {
  return (
    <Badge variant="outline" tone="warn">
      Hike-in
    </Badge>
  );
}

export function Thumbs({ urls, className }: { urls: readonly string[]; className?: string }) {
  if (urls.length === 0) return null;
  return (
    <span data-slot="report-thumbs" className="flex gap-(--space-1_5) overflow-hidden">
      {urls.map((url) => (
        <img
          key={url}
          src={url}
          alt=""
          className={cn(
            'shrink-0 border border-solid border-line bg-raise object-cover',
            className,
          )}
        />
      ))}
    </span>
  );
}

/**
 * "6 helpful · 2 comments" — a public signal about the report, never about the ice. A capped count
 * is a floor ("20+ helpful"), never shown as if it were the whole tally.
 */
export function Counts({
  helpful,
  comments,
  helpfulCapped = false,
  commentsCapped = false,
}: {
  helpful?: number | undefined;
  comments?: number | undefined;
  helpfulCapped?: boolean;
  commentsCapped?: boolean;
}) {
  if (helpful === undefined && comments === undefined) return null;
  return (
    <span
      data-slot="report-counts"
      className="flex items-center gap-(--space-3_5) text-[0.78125rem] text-fg3"
    >
      {helpful !== undefined && (
        <span className="flex items-center gap-(--space-1_5)">
          <FontAwesomeIcon icon={faThumbsUp} aria-hidden="true" className="h-3" />
          {helpful}
          {helpfulCapped ? '+' : ''} helpful
        </span>
      )}
      {comments !== undefined && (
        <span className="flex items-center gap-(--space-1_5)">
          <FontAwesomeIcon icon={faComment} aria-hidden="true" className="h-3" />
          {comments}
          {commentsCapped ? '+' : ''} {comments === 1 && !commentsCapped ? 'comment' : 'comments'}
        </span>
      )}
    </span>
  );
}
