import { buildFeedCardView, type FeedCardData } from '@skating/core';
import { BlockedChip } from './SafetyControls';
import { TrustAvatar } from './TrustDisplay';
import { Badge } from './ui/badge';

/** Max chips shown on a card before we stop (the drawer shows the full breakdown). */
const MAX_CHIPS = 4;

/**
 * A single newsfeed card (Phase 5) — body name + point-derived location, skate-end relative time,
 * quality + ice/surface chips, a photo thumbnail carousel, and blocked-author de-emphasis (D3: a
 * block never hides the report, only dims the author line + adds a "Blocked" chip). The whole card
 * is one button that opens the report drawer, preserving the feed scroll position. Pure/presentational
 * — the container maps `FeedCardData` → view-model via `buildFeedCardView` and wires `onOpen`.
 */
export function FeedCard({
  data,
  now,
  onOpen,
}: {
  data: FeedCardData;
  now: number;
  onOpen: () => void;
}) {
  const card = buildFeedCardView(data, now);
  const chips = card.chips.slice(0, MAX_CHIPS);

  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full flex-col gap-2 rounded-lg border border-border bg-surface p-3 text-left transition-colors hover:bg-surface-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-1.5 truncate font-medium text-foreground">
            {card.isFavorite ? (
              <span role="img" aria-label="Favorited" title="Favorited" className="text-primary">
                ★
              </span>
            ) : null}
            {/* The finest name the report carries — a bay when the lake has one (N2/D60). Composed
                in `@skating/core`, never assembled here, so web and mobile can't drift. */}
            <span className="truncate">{card.locationPrimary}</span>
          </h3>
          {card.locationSecondary ? (
            <p className="truncate text-foreground-muted text-sm">{card.locationSecondary}</p>
          ) : null}
        </div>
        <span className="shrink-0 text-foreground-muted text-xs">{card.relativeTime}</span>
      </div>

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

      {card.qualityLabel || chips.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1">
          {card.qualityLabel ? <Badge variant="secondary">{card.qualityLabel}</Badge> : null}
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
