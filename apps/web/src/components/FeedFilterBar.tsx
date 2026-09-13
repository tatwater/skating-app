import {
  asOfLabel,
  COLD_CHAIN_THRESHOLDS_F,
  type ColdChainThresholdF,
  cmToInches,
  DRIVE_TIME_BANDS,
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
import { activeFilterCount } from '../lib/feedFilters';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group';

/**
 * The persisted newsfeed filter row (Phase 4, decision #3) — an **additive** narrow over the global
 * feed, defaulting to show-all. Controlled: it renders the current `FeedFilters` and calls `onChange`
 * with the next set; the feed page owns persistence (local-first + server sync). Encodes the
 * include-unknown intent by framing gates as "at least" floors — a report that omits the attribute
 * still passes (enforced server-side in `matchesFilters`).
 */

const OFF = 'off';
const ANY = 'any';

/** Curated ideal ice / surface types (decision #3 examples) — the common ones, not the full vocab. */
const IDEAL_ICE_TYPES: IceType[] = ['black_ice'];
const IDEAL_SURFACE_TAGS: SurfaceTag[] = ['glass', 'smooth'];
const ICE_LABELS: Record<string, string> = {
  black_ice: 'Black ice',
  glass: 'Glass',
  smooth: 'Smooth',
};

/** Recency floor options in hours (last 24h / 48h / 7d), plus off. */
const RECENCY_OPTIONS: { value: number; label: string }[] = [
  { value: 24, label: 'Last 24h' },
  { value: 48, label: 'Last 48h' },
  { value: 168, label: 'Last 7d' },
];

/** The night counts the weather knob offers — a short list, since the digest reads "at least". */
const NIGHT_OPTIONS = [1, 2, 3, 4, 5, 7, 10, 14] as const;

/** What the bar knows about discovery's readiness (`weatherDiscovery.status`), or nothing yet. */
export interface WeatherAvailability {
  available: boolean;
  asOfDayMs: number | null;
}

export function FeedFilterBar({
  filters,
  onChange,
  weather,
}: {
  filters: FeedFilters;
  onChange: (next: FeedFilters) => void;
  /**
   * Discovery's readiness. `undefined` while loading. Out of season the weather knobs render
   * disabled with a sentence rather than silently matching nothing (founder call 24).
   */
  weather?: WeatherAvailability | undefined;
}) {
  const count = activeFilterCount(filters);
  const weatherOff = weather !== undefined && !weather.available;

  /** Immutably set (or, when `value` is undefined, delete) one filter key. */
  function patch<K extends keyof FeedFilters>(key: K, value: FeedFilters[K] | undefined) {
    const next = { ...filters };
    if (value === undefined) delete next[key];
    else next[key] = value;
    onChange(next);
  }

  const thicknessInches =
    filters.thicknessFloorCm !== undefined ? roundTo(cmToInches(filters.thicknessFloorCm), 1) : '';

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-3">
      <div className="flex items-center justify-between">
        <h2 className="font-mono text-foreground-muted text-xs uppercase tracking-widest">
          Filters{count > 0 ? ` (${count})` : ''}
        </h2>
        {count > 0 ? (
          <Button variant="ghost" size="sm" onClick={() => onChange({})}>
            Clear all
          </Button>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-3">
        {/* Drive-time radius — the one hard filter (favorites are exempt server-side). */}
        <FilterField label="Drive time" htmlFor="filter-radius">
          <Select
            value={filters.radiusMinutes ? String(filters.radiusMinutes) : OFF}
            onValueChange={(v) =>
              patch(
                'radiusMinutes',
                v && v !== OFF ? (Number(v) as (typeof DRIVE_TIME_BANDS)[number]) : undefined,
              )
            }
          >
            <SelectTrigger id="filter-radius" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={OFF}>Any distance</SelectItem>
              {DRIVE_TIME_BANDS.map((m) => (
                <SelectItem key={m} value={String(m)}>{`Within ${m} min`}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FilterField>

        {/* Overall quality floor (include-unknown). */}
        <FilterField label="Quality" htmlFor="filter-quality">
          <Select
            value={filters.qualityFloor ?? ANY}
            onValueChange={(v) =>
              patch('qualityFloor', v && v !== ANY ? (v as SkateQuality) : undefined)
            }
          >
            <SelectTrigger id="filter-quality" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Any quality</SelectItem>
              <SelectItem value="good">Good or better</SelectItem>
              <SelectItem value="great">Great only</SelectItem>
            </SelectContent>
          </Select>
        </FilterField>

        {/* Recency floor. */}
        <FilterField label="Recency" htmlFor="filter-recency">
          <Select
            value={filters.recencyHours ? String(filters.recencyHours) : OFF}
            onValueChange={(v) => patch('recencyHours', v && v !== OFF ? Number(v) : undefined)}
          >
            <SelectTrigger id="filter-recency" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={OFF}>Any time</SelectItem>
              {RECENCY_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={String(o.value)}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FilterField>

        {/* Ice-thickness floor, entered in inches (D25) and stored in cm. */}
        <FilterField label="Min thickness (in)" htmlFor="filter-thickness">
          <Input
            id="filter-thickness"
            type="number"
            inputMode="decimal"
            min={0}
            step={0.5}
            className="h-9 w-24"
            value={thicknessInches}
            onChange={(e) => {
              const raw = e.target.value.trim();
              const inches = Number(raw);
              patch(
                'thicknessFloorCm',
                raw !== '' && Number.isFinite(inches) && inches >= 0
                  ? roundTo(inchesToCm(inches), 2)
                  : undefined,
              );
            }}
          />
        </FilterField>
      </div>

      {/* Weather-first discovery (N6h / D164–D166): "at least N nights below T, no snow since".
          The knobs describe a *lake*, not a report — matching lakes appear as their own cards in
          the feed and non-matches dim on the map. Disabled, with the reason, out of season. */}
      <fieldset
        className="flex flex-wrap items-end gap-3 rounded-md border border-border border-dashed p-2"
        disabled={weatherOff}
      >
        <legend className="px-1 text-foreground-muted text-xs">
          Weather{' '}
          {weatherOff
            ? '— no weather data yet this season'
            : weather?.asOfDayMs
              ? `(${asOfLabel(weather.asOfDayMs)})`
              : ''}
        </legend>
        <FilterField label="Nights below" htmlFor="filter-weather-threshold">
          <Select
            value={filters.weather ? String(filters.weather.thresholdF) : OFF}
            onValueChange={(v) => {
              const thresholdF = Number(v);
              if (!v || v === OFF || !isColdChainThresholdF(thresholdF)) {
                onChange(withoutWeatherFilter(filters));
                return;
              }
              patch('weather', { minNights: 3, ...filters.weather, thresholdF });
            }}
          >
            <SelectTrigger id="filter-weather-threshold" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={OFF}>Any weather</SelectItem>
              {COLD_CHAIN_THRESHOLDS_F.map((t: ColdChainThresholdF) => (
                <SelectItem key={t} value={String(t)}>{`Below ${thresholdLabel(t)}`}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FilterField>
        {filters.weather ? (
          <>
            <FilterField label="At least" htmlFor="filter-weather-nights">
              <Select
                value={String(filters.weather.minNights)}
                onValueChange={(v) => {
                  if (!filters.weather || !v) return;
                  patch('weather', { ...filters.weather, minNights: Number(v) });
                }}
              >
                <SelectTrigger id="filter-weather-nights" size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {NIGHT_OPTIONS.map((n) => (
                    <SelectItem
                      key={n}
                      value={String(n)}
                    >{`${n} night${n === 1 ? '' : 's'} in a row`}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FilterField>
            <div className="flex items-center gap-2 pb-2">
              <Checkbox
                id="filter-weather-nosnow"
                checked={filters.weather.noSnowSince ?? false}
                onCheckedChange={(v) => {
                  if (!filters.weather) return;
                  const { noSnowSince: _drop, ...rest } = filters.weather;
                  patch('weather', v === true ? { ...rest, noSnowSince: true } : rest);
                }}
              />
              <Label htmlFor="filter-weather-nosnow" className="text-foreground text-sm">
                No snow since the first night
              </Label>
            </div>
            <div className="flex items-center gap-2 pb-2">
              <Checkbox
                id="filter-only-reports"
                checked={filters.onlyReports ?? false}
                onCheckedChange={(v) => patch('onlyReports', v === true ? true : undefined)}
              />
              <Label htmlFor="filter-only-reports" className="text-foreground text-sm">
                Only show reports
              </Label>
            </div>
          </>
        ) : null}
      </fieldset>

      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <Checkbox
            id="filter-nosnow"
            checked={filters.noSnow ?? false}
            onCheckedChange={(v) => patch('noSnow', v === true ? true : undefined)}
          />
          <Label htmlFor="filter-nosnow" className="text-foreground text-sm">
            No snow cover
          </Label>
        </div>

        <ChipToggle
          label="Ideal ice"
          options={[...IDEAL_ICE_TYPES, ...IDEAL_SURFACE_TAGS]}
          selected={[...(filters.iceTypes ?? []), ...(filters.surfaceTags ?? [])]}
          onValueChange={(next) => {
            const ice = next.filter((v) => (IDEAL_ICE_TYPES as string[]).includes(v)) as IceType[];
            const surface = next.filter((v) =>
              (IDEAL_SURFACE_TAGS as string[]).includes(v),
            ) as SurfaceTag[];
            onChange({
              ...filters,
              ...(ice.length > 0 ? { iceTypes: ice } : { iceTypes: undefined }),
              ...(surface.length > 0 ? { surfaceTags: surface } : { surfaceTags: undefined }),
            });
          }}
        />
      </div>
    </div>
  );
}

/** A labelled filter control cell. */
function FilterField({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={htmlFor} className="text-foreground-muted text-xs">
        {label}
      </Label>
      {children}
    </div>
  );
}

/** A row of on/off chips for the ideal ice/surface types (multi-select). */
function ChipToggle({
  label,
  options,
  selected,
  onValueChange,
}: {
  label: string;
  options: string[];
  selected: string[];
  onValueChange: (next: string[]) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-foreground-muted text-xs">{label}</span>
      {/* Base UI (not Radix): `onValueChange` always yields an array; `multiple` is what actually
          lets several ideal-ice chips be selected at once (it defaults to false = single-select). */}
      <ToggleGroup
        multiple
        value={selected}
        onValueChange={(v) => onValueChange(v as string[])}
        className="flex-wrap justify-start"
        variant="outline"
        size="sm"
      >
        {options.map((value) => (
          <ToggleGroupItem key={value} value={value}>
            {ICE_LABELS[value] ?? value}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}
