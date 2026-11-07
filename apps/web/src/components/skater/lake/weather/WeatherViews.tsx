import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCarSide, faClock } from '@fortawesome/sharp-light-svg-icons';
import {
  arrivalCaption,
  CONDITION_LABEL,
  conditionGlyph,
  type ForecastPlan,
  type ForecastPlanDay,
  type ForecastPlanHour,
  planHourLabel,
  revealPlaceholder,
  type SpreadPart,
  type SubAreaSpread,
  type TemperatureBand,
  type TimelineDayInput,
} from '@skating/core';
import { weatherChartPalette } from '@skating/design';
import {
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import { Section } from '@/components/kit/section-slug';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/kit/select';
import { Skeleton } from '@/components/kit/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/kit/tooltip';
import { cn } from '@/lib/utils';

import { GLYPH_ICON } from '../../../weatherGlyphs';
import { PastWeatherChart, useChartMode } from './PastWeatherChart';
import {
  dayShortName,
  dayTotals,
  hourAmount,
  hourWind,
  SENTENCE_DAYS,
  SENTENCE_DAYS_TIP,
  WEATHER_AT_TIP,
  type WeatherPlace,
} from './weatherModel';

/**
 * The Weather tab's views, props only (boards 1.6, 1.7) — the tab connects them. **Weather is
 * context, never a verdict** (D3): every sentence here is core's observation or forecast wording,
 * and nothing on the tab says what the weather means for the ice.
 */

type Container = { container?: HTMLElement | null | undefined };

const portal = (container: HTMLElement | null | undefined) =>
  container !== undefined && container !== null ? { container } : {};

/** A source line under a section ("Past weather: Open-Meteo"). */
function Source({ children }: { children: ReactNode }) {
  return <p className="m-0 text-assist text-fg3">{children}</p>;
}

/** A caveat, in the old panels' exact words. */
function Caveat({ children }: { children: ReactNode }) {
  return <p className="m-0 text-assist text-fg2 italic [text-wrap:pretty]">{children}</p>;
}

/** Observation lines: a small square bullet, then the sentence. */
export function BulletLines({ lines }: { lines: readonly ReactNode[] }) {
  return (
    <ul className="m-0 flex list-none flex-col gap-(--space-2) p-0">
      {lines.map((line, i) => (
        <li
          // biome-ignore lint/suspicious/noArrayIndexKey: lines are a fixed, ordered list per render.
          key={i}
          className="flex gap-(--space-2_5) text-row leading-list text-fg1 [text-wrap:pretty]"
        >
          <span aria-hidden="true" className="mt-[0.55em] size-[5px] shrink-0 bg-fg2" />
          <span className="min-w-0">{line}</span>
        </li>
      ))}
    </ul>
  );
}

// ── Weather at ────────────────────────────────────────────────────────────────────────────────

/**
 * "Weather at [Whole lake ▾]" — which sample point the tab reads. The tab renders it only when the
 * lake has two or more (`showWeatherAt`). Choosing a bay is a navigation (`?sub=`), the same one a
 * search hit makes, so the map frames it and the whole sidebar reads it.
 */
export function WeatherAtSelect({
  places,
  selected,
  onSelect,
  container,
}: {
  places: readonly WeatherPlace[];
  selected: WeatherPlace;
  onSelect: (id: string | null) => void;
} & Container) {
  const items = Object.fromEntries(places.map((p) => [p.id ?? 'lake', p.name]));
  return (
    <div data-slot="weather-at" className="flex items-center gap-(--space-3)">
      <span className="text-kick leading-none font-medium tracking-kick text-fg3 uppercase">
        Weather at
      </span>
      <Tooltip>
        <Select
          items={items}
          value={selected.id ?? 'lake'}
          onValueChange={(value) => onSelect(value === 'lake' || value == null ? null : value)}
        >
          <TooltipTrigger
            render={
              <SelectTrigger
                variant="boxed"
                aria-label="Which part of the lake the weather is for"
                data-attr="weather-at"
                className="h-btn-sm w-auto"
              />
            }
          >
            <SelectValue />
          </TooltipTrigger>
          <SelectContent {...portal(container)}>
            {places.map((p) => (
              <SelectItem key={p.id ?? 'lake'} value={p.id ?? 'lake'}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <TooltipContent {...portal(container)}>{WEATHER_AT_TIP}</TooltipContent>
      </Tooltip>
    </div>
  );
}

// ── What it's been through ────────────────────────────────────────────────────────────────────

const BAND_KEY: readonly { band: TemperatureBand; label: string }[] = [
  { band: 'deepCold', label: 'Below 20°' },
  { band: 'cold', label: '20–32°' },
  { band: 'thaw', label: '32–40°' },
  { band: 'warm', label: 'Above 40°' },
];

/** The temperature line's key: four bands, 32° the one hard break. */
function BandKey() {
  const ref = useRef<HTMLUListElement>(null);
  const palette = weatherChartPalette(useChartMode(ref));
  return (
    <ul
      ref={ref}
      aria-label="Temperature colors"
      className="m-0 flex list-none flex-wrap gap-x-(--space-3_5) gap-y-(--space-2) p-0"
    >
      {BAND_KEY.map(({ band, label }) => (
        <li
          key={band}
          className="flex items-center gap-(--space-1_5) text-kick leading-none font-medium tracking-label text-fg2 uppercase"
        >
          <span
            aria-hidden="true"
            className="h-[3px] w-(--space-3)"
            style={{ background: palette.temperature[band] }}
          />
          {label}
        </li>
      ))}
    </ul>
  );
}

export interface PastWeatherViewProps extends Container {
  /** Nothing held yet — a first open, or a new lake. */
  loading: boolean;
  /** A bay's reading is on its way: the previous one stays up, dimmed. */
  refreshing: boolean;
  headline: readonly string[];
  timeline: TimelineDayInput[];
  fetchProfileM?: number[] | undefined;
  largeBody: boolean;
  coarse: boolean;
}

export function PastWeatherView({
  loading,
  refreshing,
  headline,
  timeline,
  fetchProfileM,
  largeBody,
  coarse,
  container,
}: PastWeatherViewProps) {
  const title = 'What it’s been through';
  if (loading) {
    return (
      <Section title={title} level={2} aria-busy="true">
        <Skeleton className="h-[8.5rem] w-full" />
      </Section>
    );
  }
  const hasHourly = timeline.some((d) => (d.hours?.length ?? 0) > 0);
  if (headline.length === 0 && !hasHourly) return null;
  return (
    <Section
      title={title}
      level={2}
      data-slot="past-weather"
      aria-busy={refreshing || undefined}
      className={cn('transition-opacity duration-(--duration-fast)', refreshing && 'opacity-50')}
      end={
        <Tooltip>
          <TooltipTrigger
            variant="text"
            className="font-(family-name:--family-mono) text-assist text-fg2"
            data-attr="past-weather-window"
            render={<button type="button" />}
          >
            Last {SENTENCE_DAYS} days
          </TooltipTrigger>
          <TooltipContent {...portal(container)}>{SENTENCE_DAYS_TIP}</TooltipContent>
        </Tooltip>
      }
    >
      {headline.length > 0 && <BulletLines lines={headline} />}
      {hasHourly && (
        <>
          <PastWeatherChart days={timeline} fetchProfileM={fetchProfileM} />
          <BandKey />
        </>
      )}
      {largeBody && (
        // D151's grammar: say what WE measured, not what the lake did.
        <Caveat>
          This lake is large enough that weather differs across it — these readings are from one
          point near the middle.
        </Caveat>
      )}
      {coarse && <Caveat>Some days are from a wider area than usual.</Caveat>}
      <Source>Past weather: Open-Meteo</Source>
    </Section>
  );
}

// ── Across the lake ───────────────────────────────────────────────────────────────────────────

/** A part is prose or a place; either is unique within its line, so the content is the key. */
const partKey = (part: SpreadPart) => (typeof part === 'string' ? part : part.subAreaId);

/**
 * How a lake with bays describes itself: the spread across them, with the ends named (core's
 * `buildSubAreaSpread` wording). The named bays are links to `?sub=` — the same navigation the
 * select makes.
 */
export function AcrossTheLakeView({
  spread,
  bayHref,
}: {
  spread: SubAreaSpread;
  /** A bay's link: a real `href` and the router's click. */
  bayHref: (subAreaId: string) => {
    href: string;
    onClick: (event: ReactMouseEvent<HTMLAnchorElement>) => void;
  };
}) {
  const place = (part: SpreadPart) =>
    typeof part === 'string' ? (
      part
    ) : (
      <a
        {...bayHref(part.subAreaId)}
        className="text-fg underline decoration-fg3 underline-offset-[3px] outline-none hover:decoration-fg focus-visible:shadow-focus"
      >
        {part.name}
      </a>
    );
  const rankings = [spread.rankings?.coldestNights, spread.rankings?.leastSnow].filter(
    (r): r is NonNullable<typeof r> => !!r,
  );
  return (
    <Section
      title="Across the lake"
      level={2}
      data-slot="across-the-lake"
      end={
        <span className="font-(family-name:--family-mono) text-assist text-fg2">
          Last {spread.days} days
        </span>
      }
    >
      <p className="m-0 text-assist text-fg2">{spread.summary}</p>
      {!spread.similar && (
        <BulletLines
          lines={spread.lines.map((line) => (
            <span key={line.kind}>
              {line.parts.map((part) => (
                <span key={partKey(part)}>{place(part)}</span>
              ))}
            </span>
          ))}
        />
      )}
      {rankings.map((ranking) => (
        <p key={ranking.kind} className="m-0 text-assist text-fg2">
          <span className="text-fg1">{ranking.label}:</span>{' '}
          {ranking.bays.map((bay, i) => (
            <span key={bay.subAreaId}>
              {i > 0 ? ' · ' : null}
              {place(bay)} ({bay.value})
            </span>
          ))}
        </p>
      ))}
    </Section>
  );
}

// ── What's coming ─────────────────────────────────────────────────────────────────────────────

export interface ForecastViewProps extends Container {
  loading: boolean;
  refreshing: boolean;
  /** The 12-hour strip (core's `formatForecastStrip`), or `null`. */
  line: string | null;
  /** `null` when there is no forecast to show. */
  plan: ForecastPlan | null;
}

export function ForecastView({ loading, refreshing, line, plan, container }: ForecastViewProps) {
  const title = 'What’s coming';
  if (loading && plan === null) {
    return (
      <Section title={title} level={2} aria-busy="true">
        <Skeleton className="h-[5.5rem] w-full" />
      </Section>
    );
  }
  return (
    <Section
      title={title}
      level={2}
      data-slot="forecast"
      aria-busy={refreshing || undefined}
      className={cn('transition-opacity duration-(--duration-fast)', refreshing && 'opacity-50')}
    >
      {plan === null || plan.hours.length === 0 ? (
        <p className="m-0 text-row text-fg2">{revealPlaceholder('forecast')}</p>
      ) : (
        <>
          {line && (
            <p className="m-0 flex items-center gap-(--space-2_5) border border-solid border-line px-(--space-3) py-(--space-2_5) text-row text-fg1">
              <FontAwesomeIcon icon={faClock} aria-hidden="true" className="h-[0.95em] text-fg2" />
              {line}
            </p>
          )}
          <ForecastPlanner plan={plan} container={container} />
        </>
      )}
      <Source>Forecast: Open-Meteo</Source>
    </Section>
  );
}

/** `scrollTo` with a `scrollLeft` fallback — jsdom has no `Element.scrollTo`. */
function scrollRow(el: HTMLElement, left: number, smooth: boolean) {
  if (typeof el.scrollTo === 'function')
    el.scrollTo({ left, behavior: smooth ? 'smooth' : 'auto' });
  else el.scrollLeft = left;
}

/**
 * The hour cards and the day cards. Owns one piece of state — which day the hours are showing —
 * and keeps it true both ways: a day card scrolls the hours to that morning, and scrolling the
 * hours re-selects the day. Moved from `ForecastPanel`'s `ForecastPlanner`, re-skinned to the
 * board (the seven days fit the sidebar, so they no longer scroll).
 */
export function ForecastPlanner({ plan, container }: { plan: ForecastPlan } & Container) {
  const hoursRef = useRef<HTMLUListElement>(null);
  const cardRefs = useRef<(HTMLLIElement | null)[]>([]);
  const [selectedDate, setSelectedDate] = useState<string>(plan.days[0]?.localDate ?? '');
  // Suppresses the scroll listener while a programmatic scroll is in flight, so the day just
  // chosen isn't un-selected by the intermediate frames of its own animation.
  const settlingUntil = useRef(0);

  // A new plan (a bay switch, a refetch) opens at now again, which is index 0.
  useEffect(() => {
    setSelectedDate(plan.days[0]?.localDate ?? '');
    if (hoursRef.current) scrollRow(hoursRef.current, 0, false);
  }, [plan]);

  const scrollToDay = useCallback((day: ForecastPlanDay) => {
    setSelectedDate(day.localDate);
    const container = hoursRef.current;
    const card = cardRefs.current[day.firstHourIndex];
    if (!container || !card) return;
    settlingUntil.current = Date.now() + 700;
    scrollRow(container, card.offsetLeft - container.offsetLeft, true);
  }, []);

  const onHoursScroll = useCallback(() => {
    if (Date.now() < settlingUntil.current) return;
    const container = hoursRef.current;
    if (!container) return;
    const left = container.scrollLeft + container.offsetLeft;
    // The first card whose right edge is past the viewport's left edge is the one being read.
    const first = cardRefs.current.findIndex(
      (card) => card !== null && card.offsetLeft + card.offsetWidth > left + 1,
    );
    const hour = first >= 0 ? plan.hours[first] : undefined;
    if (hour && hour.localDate !== selectedDate) setSelectedDate(hour.localDate);
  }, [plan.hours, selectedDate]);

  const caption = arrivalCaption(plan);

  return (
    <div className="flex flex-col gap-(--space-3)">
      <ul
        ref={hoursRef}
        onScroll={onHoursScroll}
        aria-label="Hourly forecast"
        className="m-0 flex list-none gap-(--space-1_5) overflow-x-auto p-0 pb-(--space-1)"
      >
        {plan.hours.map((hour, i) => (
          <HourCard
            // The instant, not the local clock: a fall-back night has two 1 AMs with one `startMs`.
            key={hour.utcMs ?? `${hour.startMs}:${i}`}
            hour={hour}
            now={i === 0}
            dayLabel={
              i === 0 || plan.hours[i - 1]?.localDate !== hour.localDate
                ? (plan.days.find((d) => d.localDate === hour.localDate)?.label ?? '')
                : ''
            }
            ref={(el) => {
              cardRefs.current[i] = el;
            }}
          />
        ))}
      </ul>
      {caption && (
        <p className="m-0 flex items-center gap-(--space-2) text-assist text-fg2">
          <FontAwesomeIcon icon={faCarSide} aria-hidden="true" className="h-[0.95em]" />
          {caption}, if you left now
        </p>
      )}
      {/* A fieldset: a group of buttons of which one is pressed — "pick a day". */}
      <fieldset
        className="m-0 grid min-w-0 auto-cols-fr grid-flow-col gap-(--space-1) border-0 p-0"
        data-slot="forecast-days"
      >
        <legend className="sr-only">Daily forecast</legend>
        {plan.days.map((day) => (
          <DayCard
            key={day.localDate}
            day={day}
            selected={day.localDate === selectedDate}
            onSelect={() => scrollToDay(day)}
            container={container}
          />
        ))}
      </fieldset>
    </div>
  );
}

function Glyph({
  hour,
  label,
}: {
  hour: { glyph: ReturnType<typeof conditionGlyph> };
  label: string;
}) {
  return (
    <FontAwesomeIcon
      icon={GLYPH_ICON[hour.glyph]}
      role="img"
      aria-label={label}
      title={label}
      className="h-(--space-4) text-fg1"
    />
  );
}

function HourCard({
  hour,
  now,
  dayLabel,
  ref,
}: {
  hour: ForecastPlanHour;
  now: boolean;
  /** The day's name on the day's first card ("Today"), else empty — a fixed slot, so the row never jogs. */
  dayLabel: string;
  ref: (el: HTMLLIElement | null) => void;
}) {
  const label = CONDITION_LABEL[hour.condition];
  const amount = hourAmount(hour);
  return (
    <li
      ref={ref}
      aria-label={`${now ? 'Now' : planHourLabel(hour)}, ${label}, ${hour.temperatureF}°F, wind ${hour.windMph} mph${
        amount ? `, ${amount.text} ${amount.snow ? 'snow' : 'rain'}` : ''
      }${hour.arrival ? ', about when you would arrive' : ''}`}
      data-arrival={hour.arrival || undefined}
      className={cn(
        'flex w-16 shrink-0 flex-col items-center gap-(--space-1_5) border border-solid border-line py-(--space-2_5)',
        hour.arrival && 'border-line2 bg-raise',
      )}
    >
      <span className="h-[1em] text-kick leading-none font-semibold tracking-label text-fg3 uppercase">
        {dayLabel}
      </span>
      <span className="font-(family-name:--family-mono) text-mono-sm leading-none text-fg2">
        {now ? 'Now' : planHourLabel(hour)}
      </span>
      <Glyph hour={{ glyph: conditionGlyph(hour.condition, hour.isNight) }} label={label} />
      <span className="font-(family-name:--family-mono) text-row leading-none font-medium text-fg tabular-nums">
        {hour.temperatureF}°
      </span>
      <span
        className={cn(
          'h-[1em] font-(family-name:--family-mono) text-mono-sm leading-none tabular-nums',
          amount?.snow ? 'text-fg' : 'text-fg2',
        )}
      >
        {amount?.text ?? ''}
      </span>
      <span className="font-(family-name:--family-mono) text-mono-sm leading-none text-fg3 tabular-nums">
        {hourWind(hour)}
      </span>
    </li>
  );
}

function DayCard({
  day,
  selected,
  onSelect,
  container,
}: {
  day: ForecastPlanDay;
  selected: boolean;
  onSelect: () => void;
} & Container) {
  const label = CONDITION_LABEL[day.condition];
  const details = [
    label,
    ...dayTotals(day),
    ...(day.nightLowF !== null ? [`night low ${day.nightLowF}°`] : []),
    ...day.lines,
    ...(day.partial ? [day.label === 'Today' ? 'rest of today' : 'partial day'] : []),
  ];
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-pressed={selected}
            aria-label={`${day.label}, ${day.dateLabel}, high ${day.highF}°, low ${day.lowF}°, ${details.join(', ')}`}
            data-attr="forecast-day"
            onClick={onSelect}
            className={cn(
              'flex min-w-0 cursor-pointer flex-col items-center gap-(--space-1_5) rounded-control border border-solid border-line bg-transparent px-0 py-(--space-2_5) text-fg outline-none',
              'hover:border-line2 focus-visible:shadow-focus',
              selected && 'border-fg hover:border-fg',
            )}
          />
        }
      >
        <span className="text-kick leading-none font-semibold tracking-label text-fg2 uppercase">
          {dayShortName(day)}
        </span>
        <Glyph hour={{ glyph: conditionGlyph(day.condition, false) }} label={label} />
        <span className="flex flex-col items-center gap-[3px] font-(family-name:--family-mono) leading-none tabular-nums">
          <span className="text-assist font-medium text-fg">{day.highF}°</span>
          <span className="text-mono-sm text-fg3">{day.lowF}°</span>
        </span>
        <span className="h-[1em] font-(family-name:--family-mono) text-mono-sm leading-none text-fg2">
          {day.snowfallIn >= 0.1 ? `${day.snowfallIn}″` : ''}
        </span>
      </TooltipTrigger>
      <TooltipContent title={`${day.label} · ${day.dateLabel}`} {...portal(container)}>
        {details.join(' · ')}
      </TooltipContent>
    </Tooltip>
  );
}
