import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faStar } from '@fortawesome/sharp-solid-svg-icons';
import { buildFeedCardView, type FeedCardData } from '@skating/core';
import { BlockedChip } from './SafetyControls';
import { TrustAvatar } from './TrustDisplay';
import { Badge } from './ui/badge';

/** Max chips shown on a card before we stop (the drawer shows the full breakdown). */
const MAX_CHIPS = 4;

/**
 * A single newsfeed card (Phase 05) — body name + point-derived location, skate-end relative time,
 * quality + ice/surface chips, a photo thumbnail carousel, and blocked-author de-emphasis (D3: a
 * block never hides the report, only dims the author line + adds a "Blocked" chip). The whole card
 * is one button that opens the report drawer, preserving the feed scroll position. Pure/presentational
 * — the container maps `FeedCardData` → view-model via `buildFeedCardView` and wires `onOpen`.
 */
export function FeedCard({
  data,
  now,
  onOpen,
  nested = false,
}: {
  data: FeedCardData;
  now: number;
  onOpen: () => void;
  /**
   * Inside a `PostCard` (A10 / D186): no frame of its own and no author line — the Post already
   * said who and when, and the frame is the Post's. Standing alone, the card is what it always was.
   */
  nested?: boolean;
}) {
  const card = buildFeedCardView(data, now);
  const chips = card.chips.slice(0, MAX_CHIPS);

  return (
    <button
      type="button"
      onClick={onOpen}
      className={
        nested
          ? 'flex w-full flex-col gap-2 rounded-md p-3 text-left transition-colors hover:bg-surface-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary'
          : 'flex w-full flex-col gap-2 rounded-lg border border-border bg-surface p-3 text-left transition-colors hover:bg-surface-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary'
      }
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-1.5 truncate font-medium text-foreground">
            {card.isFavorite ? (
              <span
                role="img"
                aria-label="Favorited"
                title="Favorited"
                className="flex shrink-0 text-primary"
              >
                <FontAwesomeIcon icon={faStar} aria-hidden className="size-3.5" />
              </span>
            ) : null}
            {/* The finest name the report carries — a bay when the lake has one (A02/D60). Composed
                in `@skating/core`, never assembled here, so web and mobile can't drift. */}
            <span className="truncate">{card.locationPrimary}</span>
          </h3>
          {card.locationSecondary ? (
            <p className="truncate text-foreground-muted text-sm">{card.locationSecondary}</p>
          ) : null}
          {/* D87's third surface. The feed is where the **drive-time** filter lives, and a hike-in
              lake inside a "within 60 minutes" band is not the trip a skater thinks they are being
              offered. Shown beside the drive time, never folded into it. */}
          {card.isHikeIn ? (
            <span className="mt-1 inline-block rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-900 text-xs">
              Hike-in
            </span>
          ) : null}
        </div>
        <span className="shrink-0 text-foreground-muted text-xs">{card.relativeTime}</span>
      </div>

      {nested ? (
        card.durationLabel ? (
          <p className="text-foreground-muted text-sm">skated {card.durationLabel}</p>
        ) : null
      ) : (
        <div className="flex items-center gap-2 text-foreground-muted text-sm">
          <TrustAvatar
            displayName={card.author.displayName}
            imageUrl={card.author.profileImageUrl}
            trustClass={card.author.trustClass}
            size={20}
          />
          <span className="min-w-0 truncate">
            by{' '}
            <span className={card.blocked ? 'text-foreground-muted' : 'text-foreground'}>
              {card.author.displayName}
            </span>
            {card.durationLabel ? ` · skated ${card.durationLabel}` : null}
          </span>
          {card.blocked ? <BlockedChip /> : null}
        </div>
      )}

      {card.suitabilityLabel ||
      card.qualityLabel ||
      card.vantageLabel ||
      card.sightingLabel ||
      chips.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1">
          {/* The who-claim leads (D3 / D190): "Don't go" before "Great", in the warning treatment. */}
          {card.suitabilityLabel ? (
            <Badge variant={card.isDontGo ? 'destructive' : 'secondary'}>
              {card.suitabilityLabel}
            </Badge>
          ) : null}
          {card.qualityLabel ? <Badge variant="secondary">{card.qualityLabel}</Badge> : null}
          {/* Provenance a reader needs (D191): only off the ice, where it changes how a chip reads. */}
          {card.vantageLabel ? <Badge variant="outline">{card.vantageLabel}</Badge> : null}
          {card.sightingLabel ? <Badge variant="outline">{card.sightingLabel}</Badge> : null}
          {chips.map((chip) => (
            <Badge key={chip} variant="outline">
              {chip}
            </Badge>
          ))}
        </div>
      ) : null}

      {card.photoThumbUrls.length > 0 ? (
        <div className="flex gap-2 overflow-x-auto">
          {card.photoThumbUrls.map((url) => (
            <img
              key={url}
              src={url}
              alt="Report"
              className="h-20 w-20 shrink-0 rounded-md object-cover"
            />
          ))}
        </div>
      ) : null}
    </button>
  );
}
