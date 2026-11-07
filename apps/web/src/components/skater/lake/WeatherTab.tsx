import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { useQuery } from 'convex/react';

import { usePageNav } from './lakeNav';
import { TabStack } from './ReportsTab';
import { useForecast, usePastWeather } from './weather/useWeatherData';
import {
  AcrossTheLakeView,
  ForecastView,
  PastWeatherView,
  WeatherAtSelect,
} from './weather/WeatherViews';
import { selectedPlace, showWeatherAt, weatherPlaces } from './weather/weatherModel';

/**
 * **The Weather tab (boards 1.6, 1.7).** "Weather at" (only with two or more sample points), what
 * the ice has been through (the last ten days in sentences, thirty in the chart), across the lake
 * (a lake with bays), and what's coming. The order is an authority claim, not layout: an NWS alert
 * (above the tabs) outranks an observation, which outranks a forecast.
 *
 * Weather is context, never a verdict (D3): nothing here says what it means for the ice.
 */
export interface WeatherTabProps {
  /** The lake (the merge survivor's id). */
  waterBodyId: string;
  /** The bay in view (`?sub=`), when there is one. */
  subAreaId?: string;
}

export function WeatherTab({ waterBodyId, subAreaId }: WeatherTabProps) {
  const nav = usePageNav();
  const lakeId = waterBodyId as Id<'waterBodies'>;
  // The same subscription `LakePage` holds — the client dedupes it.
  const bays = useQuery(api.subAreas.listForBody, { waterBodyId: lakeId });
  const places = weatherPlaces(bays);
  const place = selectedPlace(places, subAreaId);
  const placeId = place.id ?? undefined;
  // Reads Tier B (no fetch); the server answers `null` for a lake with fewer than two bays.
  const spread = useQuery(
    api.weatherArchive.getSubAreaSpread,
    places.length >= 3 ? { waterBodyId: lakeId } : 'skip',
  );
  const past = usePastWeather(waterBodyId, placeId);
  const forecast = useForecast(waterBodyId, placeId);
  const loadingPast = past.state.loading && past.state.days.length === 0;

  return (
    <TabStack>
      {showWeatherAt(places) && (
        <WeatherAtSelect
          places={places}
          selected={place}
          onSelect={(id) => nav.push(nav.with({ sub: id }))}
        />
      )}
      <PastWeatherView
        loading={loadingPast}
        refreshing={past.state.loading && !loadingPast}
        headline={past.panel.headline}
        timeline={past.state.timeline}
        fetchProfileM={past.state.fetchProfileM}
        largeBody={past.state.largeBody}
        coarse={past.panel.coarse}
      />
      {spread && (
        <AcrossTheLakeView spread={spread} bayHref={(id) => nav.link(nav.with({ sub: id }))} />
      )}
      <ForecastView
        loading={forecast.state.loading}
        refreshing={forecast.state.loading && forecast.derived !== null}
        line={forecast.derived?.line ?? null}
        plan={forecast.derived?.plan ?? null}
      />
    </TabStack>
  );
}
