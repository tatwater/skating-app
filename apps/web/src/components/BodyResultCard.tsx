import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faStar } from '@fortawesome/sharp-solid-svg-icons';
import { type BodyResultData, buildBodyResultView } from '@skating/core';
import { Badge } from './ui/badge';

/**
 * A weather-matched **lake** in the Latest feed (N6h / D165) — the card type that makes the feed
 * heterogeneous. It is an *Overview* object where a report card is a *Reporting* one (D159), and the
 * layout says so: no author, no quality, no photos; a place, the chain sentence that matched, and
 * the date the reading is as of. Every sentence comes from `buildBodyResultView` in core, where the
 * D3 line is tested — a chain of cold nights is weather, never a verdict on the ice.
 *
 * Tapping opens the lake on the map (the bay, when the reading was taken at one).
 */
export function BodyResultCard({
  data,
  now,
  onOpen,
}: {
  data: BodyResultData;
  now: number;
  onOpen: (focusSubAreaId: string | null) => void;
}) {
  const card = buildBodyResultView(data, now);
  return (
    <button
      type="button"
      onClick={() => onOpen(card.focusSubAreaId)}
      className="flex w-full flex-col gap-2 rounded-lg border border-border border-dashed bg-surface p-3 text-left transition-colors hover:bg-surface-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
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
            <span className="truncate">{card.locationPrimary}</span>
          </h3>
          {card.locationSecondary ? (
            <p className="truncate text-foreground-muted text-sm">{card.locationSecondary}</p>
          ) : null}
        </div>
        <span className="shrink-0 text-foreground-muted text-xs">{card.relativeTime}</span>
      </div>

      <p className="text-foreground text-sm">
        {card.headline}
        <span className="text-foreground-muted"> · {card.asOfLabel}</span>
      </p>
      {card.alsoAtLabel ? (
        <p className="text-foreground-muted text-xs">{card.alsoAtLabel}</p>
      ) : null}
      {card.caveat ? <p className="text-foreground-muted text-xs italic">{card.caveat}</p> : null}

      <div className="flex flex-wrap items-center gap-1">
        <Badge variant="secondary">Weather match</Badge>
        {card.isHikeIn ? <Badge variant="outline">Hike-in</Badge> : null}
        {card.noPublicAccess ? <Badge variant="outline">No public access</Badge> : null}
      </div>
    </button>
  );
}
