import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faMap, faPen } from '@fortawesome/sharp-light-svg-icons';
import {
  asOfLabel,
  COLD_CHAIN_THRESHOLDS_F,
  cmToInches,
  DRIVE_TIME_BANDS,
  type DriveTimeBand,
  type FeedFilters,
  type IceType,
  inchesToCm,
  isColdChainThresholdF,
  roundTo,
  type SkateQuality,
  type SurfaceTag,
  thresholdLabel,
  withoutWeatherFilter,
} from '@skating/core';
import { type ReactNode, useId } from 'react';

import { activeFilterCount } from '@/lib/feedFilters';
import { cn } from '@/lib/utils';

import { Button } from '../../kit/button';
import { CheckboxGroup, CheckboxRow } from '../../kit/checkbox';
import { NumberField } from '../../kit/number-field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../kit/select';
import { ToggleGroup, ToggleGroupItem } from '../../kit/toggle-group';
import { patchFilters } from './latestModel';

/**
 * Latest's left column (boards 4.1–4.3, 4.12, 4.13): the saved filter row (D166) re-skinned on the
 * kit. Controlled — it renders the row it's given and hands back the next one; the page owns the
 * store, so the Explore map, which dims by the same store, never sees a second copy.
 *
 * Every filter is a floor ("at least"): a report that leaves a detail out still shows, and the
 * column says so at its foot. "Weather" describes a lake's run of cold nights, never the ice (D3) —
 * it's a filter name, not a recommendation.
 */

/** What the column knows about weather discovery (`weatherDiscovery.status`), or nothing yet. */
export interface WeatherAvailability {
  available: boolean;
  asOfDayMs: number | null;
}

export interface FilterColumnProps {
  filters: FeedFilters;
  onChange: (next: FeedFilters) => void;
  /** `undefined` while it loads; out of season the weather knobs disable and say why. */
  weather: WeatherAvailability | undefined;
  /** The search input (4.9), when the text-search flag is on. */
  search?: ReactNode;
  /** 4.4: the weather filter's matches on the region map. */
  onShowOnMap: () => void;
  /** "Change home" — Settings › Home and drive time. */
  homeLink: ReactNode;
}

const ANY = 'any';

const RECENCY: readonly { hours: number; label: string }[] = [
  { hours: 24, label: '24 h' },
  { hours: 48, label: '48 h' },
  { hours: 168, label: '7 d' },
];

const QUALITY: readonly { value: SkateQuality | typeof ANY; label: string }[] = [
  { value: ANY, label: 'Any' },
  { value: 'good', label: 'Good or better' },
  { value: 'great', label: 'Great' },
];

/** The ideal ice the boards offer (Phase 04's curated few, not the whole vocabulary). */
const IDEAL_ICE: readonly {
  value: IceType | SurfaceTag;
  kind: 'ice' | 'surface';
  label: string;
}[] = [
  { value: 'black_ice', kind: 'ice', label: 'Black ice' },
  { value: 'glass', kind: 'surface', label: 'Glass' },
  { value: 'smooth', kind: 'surface', label: 'Smooth' },
];

/** The night counts the weather knob offers — a short list, since the digest reads "at least". */
const NIGHTS = [1, 2, 3, 4, 5, 7, 10, 14] as const;

/** A newly picked weather filter starts at three nights. */
const DEFAULT_NIGHTS = 3;

export function FilterColumn({
  filters,
  onChange,
  weather,
  search,
  onShowOnMap,
  homeLink,
}: FilterColumnProps) {
  const count = activeFilterCount(filters);
  const noWeather = weather !== undefined && !weather.available;
  const set = <K extends keyof FeedFilters>(key: K, value: FeedFilters[K] | undefined) =>
    onChange(patchFilters(filters, key, value));

  const thickness =
    filters.thicknessFloorCm !== undefined
      ? roundTo(cmToInches(filters.thicknessFloorCm), 1)
      : null;
  const ideal = [...(filters.iceTypes ?? []), ...(filters.surfaceTags ?? [])];

  return (
    <div data-slot="latest-filters" className="flex flex-col gap-(--space-5_5)">
      {search}
      <div className="flex items-center">
        <h2 className="m-0 text-kick leading-none font-medium tracking-head text-fg3 uppercase">
          {count > 0 ? `Filters · ${count}` : 'Filters'}
        </h2>
        {count > 0 && (
          <Button
            size="xs"
            className="ml-auto"
            data-attr="latest-filters-clear"
            onClick={() => onChange({})}
          >
            Clear all
          </Button>
        )}
      </div>

      <Field label="Drive time">
        {(id) => (
          <>
            <Select
              value={filters.radiusMinutes !== undefined ? String(filters.radiusMinutes) : ANY}
              onValueChange={(value) =>
                set(
                  'radiusMinutes',
                  value !== null && value !== ANY ? (Number(value) as DriveTimeBand) : undefined,
                )
              }
            >
              <SelectTrigger id={id} variant="boxed" data-attr="latest-filter-drive-time">
                <SelectValue>
                  {driveLabel(
                    filters.radiusMinutes !== undefined ? String(filters.radiusMinutes) : ANY,
                  )}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Any distance</SelectItem>
                {DRIVE_TIME_BANDS.map((minutes) => (
                  <SelectItem key={minutes} value={String(minutes)}>
                    {driveLabel(String(minutes))}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex items-center gap-(--space-2) text-[0.75rem] text-fg2">
              <span>From your home</span>
              <span className="ml-auto">{homeLink}</span>
            </div>
          </>
        )}
      </Field>

      <Field label="Quality" group>
        {(id) => (
          <ToggleGroup
            aria-labelledby={id}
            className="flex w-full"
            value={filters.qualityFloor ?? ANY}
            onValueChange={(value) =>
              set('qualityFloor', value === ANY ? undefined : (value as SkateQuality))
            }
          >
            {QUALITY.map((option) => (
              <ToggleGroupItem
                key={option.value}
                value={option.value}
                className="flex-auto"
                data-attr="latest-filter-quality"
              >
                {option.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )}
      </Field>

      <Field label="Posted" group>
        {(id) => (
          <ToggleGroup
            aria-labelledby={id}
            className="flex w-full"
            value={filters.recencyHours !== undefined ? String(filters.recencyHours) : ANY}
            onValueChange={(value) =>
              set('recencyHours', value === ANY ? undefined : Number(value))
            }
          >
            <ToggleGroupItem value={ANY} className="flex-auto" data-attr="latest-filter-posted">
              Any time
            </ToggleGroupItem>
            {RECENCY.map((option) => (
              <ToggleGroupItem
                key={option.hours}
                value={String(option.hours)}
                className="flex-auto"
                data-attr="latest-filter-posted"
              >
                {option.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )}
      </Field>

      <NumberField
        label="Thickness at least"
        unit="in"
        min={0}
        max={60}
        step={0.5}
        placeholder="—"
        value={thickness}
        data-attr="latest-filter-thickness"
        // On commit (blur, Enter, a step key), not per keystroke: every change is a saved write.
        onValueCommitted={(inches) =>
          set(
            'thicknessFloorCm',
            inches !== null && Number.isFinite(inches) && inches > 0
              ? roundTo(inchesToCm(inches), 2)
              : undefined,
          )
        }
      />

      <Field label="Ideal ice" group>
        {(id) => (
          <CheckboxGroup
            aria-labelledby={id}
            value={ideal}
            onValueChange={(values: string[]) => {
              const ice = IDEAL_ICE.filter((o) => o.kind === 'ice' && values.includes(o.value));
              const surface = IDEAL_ICE.filter(
                (o) => o.kind === 'surface' && values.includes(o.value),
              );
              onChange(
                patchFilters(
                  patchFilters(
                    filters,
                    'iceTypes',
                    ice.length > 0 ? ice.map((o) => o.value as IceType) : undefined,
                  ),
                  'surfaceTags',
                  surface.length > 0 ? surface.map((o) => o.value as SurfaceTag) : undefined,
                ),
              );
            }}
            className="flex-row flex-wrap gap-x-(--space-4) gap-y-(--space-2)"
          >
            {IDEAL_ICE.map((option) => (
              <CheckboxRow
                key={option.value}
                name={option.value}
                value={option.value}
                label={option.label}
                data-attr="latest-filter-ice-type"
              />
            ))}
          </CheckboxGroup>
        )}
      </Field>

      <WeatherFields
        filters={filters}
        onChange={onChange}
        weather={weather}
        disabled={noWeather}
        onShowOnMap={onShowOnMap}
      />

      <CheckboxRow
        label="No snow cover"
        checked={filters.noSnow ?? false}
        onCheckedChange={(checked) => set('noSnow', checked ? true : undefined)}
        data-attr="latest-filter-no-snow"
      />

      <p className="m-0 text-[0.75rem] leading-body text-fg3 [text-wrap:pretty]">
        A report missing a detail still shows — filters only set a floor.
      </p>
    </div>
  );
}

function driveLabel(value: string): string {
  return value === ANY ? 'Any distance' : `Within ${value} minutes`;
}

/** A kicker over a control. `group` labels a set (a toggle row, checkboxes) by id. */
function Field({
  label,
  group = false,
  children,
}: {
  label: string;
  group?: boolean;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  const kicker = 'text-kick leading-none font-medium tracking-kick text-fg3 uppercase';
  return (
    <div className="flex flex-col gap-(--space-2)">
      {group ? (
        <span id={id} className={kicker}>
          {label}
        </span>
      ) : (
        <label htmlFor={id} className={kicker}>
          {label}
        </label>
      )}
      {children(id)}
    </div>
  );
}

/**
 * The weather knobs (D164–D166): "at least N nights below T, no snow since". Off, it's one select;
 * on, the knobs gather in a square box with the reading's date, the way to see the matches on the
 * map, and the line that says what a match is. With no digest this season (4.13) everything in it
 * disables and says why — the filter can still be turned off.
 */
function WeatherFields({
  filters,
  onChange,
  weather,
  disabled,
  onShowOnMap,
}: {
  filters: FeedFilters;
  onChange: (next: FeedFilters) => void;
  weather: WeatherAvailability | undefined;
  disabled: boolean;
  onShowOnMap: () => void;
}) {
  const id = useId();
  const on = filters.weather;
  const threshold = (
    <Select
      value={on !== undefined ? String(on.thresholdF) : ANY}
      disabled={disabled}
      onValueChange={(value) => {
        const thresholdF = Number(value);
        if (value === null || value === ANY || !isColdChainThresholdF(thresholdF)) {
          onChange(withoutWeatherFilter(filters));
          return;
        }
        onChange(
          patchFilters(filters, 'weather', { minNights: DEFAULT_NIGHTS, ...on, thresholdF }),
        );
      }}
    >
      <SelectTrigger id={`${id}-t`} variant="boxed" data-attr="latest-filter-weather">
        <SelectValue>{weatherLabel(on !== undefined ? String(on.thresholdF) : ANY)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ANY}>Any weather</SelectItem>
        {COLD_CHAIN_THRESHOLDS_F.map((t) => (
          <SelectItem key={t} value={String(t)}>
            {weatherLabel(String(t))}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
  const kicker = 'text-kick leading-none font-medium tracking-kick text-fg3 uppercase';

  if (on === undefined) {
    return (
      <div className="flex flex-col gap-(--space-2)">
        <label htmlFor={`${id}-t`} className={kicker}>
          Weather
        </label>
        {threshold}
        {disabled && (
          <p className="m-0 text-[0.75rem] text-fg3">No weather data yet this season.</p>
        )}
      </div>
    );
  }

  return (
    <fieldset
      data-slot="latest-weather"
      className="m-0 flex min-w-0 flex-col gap-(--space-3_5) border border-solid border-line2 p-(--space-3_5)"
    >
      <legend className="sr-only">Weather</legend>
      <div className="flex items-baseline">
        <span className={kicker}>Weather</span>
        {!disabled && weather?.asOfDayMs != null && (
          <span className="ml-auto font-(family-name:--family-mono) text-[0.71875rem] text-fg2">
            {capitalize(asOfLabel(weather.asOfDayMs))}
          </span>
        )}
      </div>
      <div className="flex flex-col gap-(--space-1_5)">
        <label htmlFor={`${id}-t`} className={kicker}>
          Nights below
        </label>
        {threshold}
      </div>
      <div className="flex flex-col gap-(--space-1_5)">
        <label htmlFor={`${id}-n`} className={kicker}>
          At least
        </label>
        <Select
          value={String(on.minNights)}
          disabled={disabled}
          onValueChange={(value) => {
            if (value === null) return;
            onChange(patchFilters(filters, 'weather', { ...on, minNights: Number(value) }));
          }}
        >
          <SelectTrigger id={`${id}-n`} variant="boxed" data-attr="latest-filter-weather-nights">
            <SelectValue>{nightsLabel(on.minNights)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {NIGHTS.map((n) => (
              <SelectItem key={n} value={String(n)}>
                {nightsLabel(n)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <CheckboxRow
        label="No snow since the first night"
        disabled={disabled}
        checked={on.noSnowSince ?? false}
        onCheckedChange={(checked) => {
          const { noSnowSince: _drop, ...rest } = on;
          onChange(
            patchFilters(filters, 'weather', checked ? { ...rest, noSnowSince: true } : rest),
          );
        }}
        data-attr="latest-filter-weather-no-snow"
      />
      {!disabled && (
        <CheckboxRow
          label="Only show reports"
          checked={filters.onlyReports ?? false}
          onCheckedChange={(checked) =>
            onChange(patchFilters(filters, 'onlyReports', checked ? true : undefined))
          }
          data-attr="latest-filter-only-reports"
        />
      )}
      {!disabled && (
        <Button size="sm" data-attr="latest-show-on-map" onClick={onShowOnMap}>
          <FontAwesomeIcon icon={faMap} aria-hidden="true" className="h-3" />
          Show on the map
        </Button>
      )}
      <p className={cn('m-0 text-[0.75rem] leading-body [text-wrap:pretty]', 'text-fg3')}>
        {disabled
          ? 'No weather data yet this season.'
          : 'Lakes whose weather matches join the feed as cards of their own. A match describes the weather, never the ice.'}
      </p>
    </fieldset>
  );
}

function weatherLabel(value: string): string {
  const t = Number(value);
  return value === ANY || !isColdChainThresholdF(t) ? 'Any weather' : `Below ${thresholdLabel(t)}`;
}

function nightsLabel(n: number): string {
  return `${n} ${n === 1 ? 'night' : 'nights'} in a row`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "Change home": the pencil and the words, as a small outlined action. */
export function ChangeHomeLabel() {
  return (
    <>
      <FontAwesomeIcon icon={faPen} aria-hidden="true" className="h-2.5" />
      Change home
    </>
  );
}
