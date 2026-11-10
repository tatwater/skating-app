import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faTemperatureLow } from '@fortawesome/sharp-light-svg-icons';
import type { FeedFilters } from '@skating/core';
import { useMemo } from 'react';

import { Button } from '../../kit/button';
import { InViewList } from '../lake/InViewList';
import { latestMapSpec } from '../map/mapSpec';
import { useMapSpec } from '../map/useMapSpec';
import { mapBannerLine } from './latestModel';

/**
 * 4.4, "on the map": Latest's matches on the **one** region map (never a second instance, §1.8).
 * The page declares `latestMapSpec()`, so the layout's map shows beside the In view list, and the
 * map dims every lake the saved filters don't match — it reads the same D166 store the filter
 * column writes, so there's nothing to pass it. A banner over the map says what the dimming is,
 * with the way back to the feed and the way to drop the weather filter.
 */
export function LatestMapView({
  filters,
  asOfDayMs,
  onBack,
  onClearWeather,
}: {
  filters: FeedFilters;
  asOfDayMs: number | null;
  onBack: () => void;
  onClearWeather: () => void;
}) {
  useMapSpec(useMemo(() => latestMapSpec(), []));
  return (
    <>
      <InViewList />
      <MapBanner
        line={mapBannerLine(filters, asOfDayMs)}
        weatherOn={filters.weather !== undefined}
        onBack={onBack}
        onClearWeather={onClearWeather}
      />
    </>
  );
}

/**
 * The plate over the map's top-left. It sits in the view's column in the tree but over the map in
 * the layout: the map frame is the positioned ancestor, and the view column is 27.5 rem wide.
 */
export function MapBanner({
  line,
  weatherOn,
  onBack,
  onClearWeather,
}: {
  line: string;
  weatherOn: boolean;
  onBack: () => void;
  onClearWeather: () => void;
}) {
  return (
    <div
      role="status"
      data-slot="latest-map-banner"
      className="absolute top-(--space-4) left-[calc(var(--size-sidebar)+var(--space-4))] z-(--z-raised) flex max-w-[calc(100%-var(--size-sidebar)-6rem)] items-center gap-(--space-3) border border-solid border-line2 bg-panel py-(--space-1_5) pr-(--space-1_5) pl-(--space-3) text-assist text-fg1 shadow-plate max-md:hidden"
    >
      <FontAwesomeIcon icon={faTemperatureLow} aria-hidden="true" className="h-3.5 text-acc" />
      <span className="min-w-0 truncate">{line}</span>
      <Button size="xs" data-attr="latest-map-back" onClick={onBack}>
        Back to Latest
      </Button>
      {weatherOn && (
        <Button size="xs" data-attr="latest-map-clear" onClick={onClearWeather}>
          Clear
        </Button>
      )}
    </div>
  );
}
