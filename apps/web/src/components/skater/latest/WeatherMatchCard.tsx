import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faStar } from '@fortawesome/sharp-solid-svg-icons';
import { type BodyResultData, buildBodyResultView } from '@skating/core';

import { Badge } from '../../kit/badge';
import { navLinkProps } from '../chrome';

/**
 * A lake the weather filter matched, as its own card in the feed (boards 4.2, 4.10; A06h / D165) —
 * the old `BodyResultCard` re-skinned. A place, the run of cold nights that matched, and the day
 * the reading is as of: no author, no quality, no photos, because a match describes the weather,
 * never the ice (D3). Every sentence is core's `buildBodyResultView`, where that line is tested.
 *
 * A link to the lake (the bay, when the match was read at one).
 */
export function weatherMatchHref(card: { waterBodyId: string; focusSubAreaId: string | null }) {
  const sub = card.focusSubAreaId !== null ? `?sub=${encodeURIComponent(card.focusSubAreaId)}` : '';
  return `/water/${encodeURIComponent(card.waterBodyId)}${sub}`;
}

export function WeatherMatchCard({
  data,
  now,
  onOpen,
}: {
  data: BodyResultData;
  now: number;
  /** A plain left click: the lake (or bay) to open. */
  onOpen: (waterBodyId: string, focusSubAreaId: string | null) => void;
}) {
  const card = buildBodyResultView(data, now);
  const link = navLinkProps(weatherMatchHref(card), () =>
    onOpen(card.waterBodyId, card.focusSubAreaId),
  );
  return (
    <a
      href={link.href}
      onClick={link.onClick}
      data-slot="weather-match"
      data-attr="latest-weather-match"
      aria-label={`Weather match: ${card.locationPrimary}, ${card.headline}, ${card.asOfLabel}`}
      className="ph-no-capture flex flex-col gap-(--space-2) border border-l-2 border-solid border-line border-l-acc px-(--space-4) py-(--space-3_5) text-inherit no-underline outline-none hover:border-line2 hover:border-l-acc focus-visible:shadow-focus"
    >
      <span className="text-kick leading-none font-medium tracking-head text-acc uppercase">
        Weather match
      </span>
      <span className="flex items-baseline gap-(--space-2)">
        {card.isFavorite && (
          <span role="img" aria-label="Favorite" className="flex shrink-0 self-center text-star">
            <FontAwesomeIcon icon={faStar} aria-hidden="true" className="h-3" />
          </span>
        )}
        <b className="font-semibold text-fg">{card.locationPrimary}</b>
        {card.locationSecondary !== null && (
          <span className="text-assist text-fg2">{card.locationSecondary}</span>
        )}
        {card.isHikeIn && (
          <span className="ml-auto self-center">
            <Badge variant="outline" tone="warn">
              Hike-in
            </Badge>
          </span>
        )}
      </span>
      <span className="text-body text-fg1">
        {card.headline}
        <span className="text-fg3"> · {card.asOfLabel}</span>
      </span>
      {card.alsoAtLabel !== null && (
        <span className="text-assist text-fg2">{card.alsoAtLabel}</span>
      )}
      {card.caveat !== null && <span className="text-assist text-fg3">{card.caveat}</span>}
    </a>
  );
}
