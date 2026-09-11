import type { IconDefinition } from '@fortawesome/fontawesome-svg-core';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faCarSide,
  faCloud,
  faCloudBolt,
  faCloudDrizzle,
  faCloudFog,
  faCloudMoon,
  faCloudRain,
  faCloudSleet,
  faCloudSnow,
  faCloudSun,
  faIcicles,
  faMoon,
  faSun,
} from '@fortawesome/sharp-light-svg-icons';
import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import {
  arrivalCaption,
  buildForecastPlan,
  CONDITION_LABEL,
  conditionGlyph,
  type ForecastGlyph,
  type ForecastPayload,
  type ForecastPlan,
  type ForecastPlanDay,
  type ForecastPlanHour,
  forecastPlanIsEmpty,
  formatForecastStrip,
  planHourLabel,
  revealPlaceholder,
  summarizeForecast,
} from '@skating/core';
import { useAction } from 'convex/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * The forward forecast on a lake drawer (N6c B5b, grown into the planner by N6h Workstream D).
 *
 * Three things, one fetch: the one-line strip that has been here since B5b (*"Next 12 hours: 22–31°F,
 * snow starting 8 PM"*), a row of hourly cards for the whole week that opens at *now*, and a row of
 * day cards underneath it whose tap scrolls the hours to that morning. The day card is the selector
 * D155 asked for; the hours are the run-up it insisted on drawing. Everything printable is computed
 * in `@skating/core` (`buildForecastPlan`) so the sentences on both clients are one implementation
 * with tests, and this file is layout.
 *
 * **It renders below the past-weather panel and below any NWS alert**, and the ordering is a claim
 * about authority rather than layout: an official warning outranks an observation, and an
 * observation outranks a prediction (D74 as a boundary on screen).
 *
 * Keyed on the **body** (or its bay), not on a report or hazard, because "will it be snowing when I
 * get there" is about the lake — and it is asked most on the lakes that have no reports at all.
 */
export function ForecastPanel({
  waterBodyId,
  subAreaId,
  pending = false,
  reveal = false,
}: {
  waterBodyId: Id<'waterBodies'>;
  /** The bay this forecast is about (N6h / open question 5) — the same one `PastWeatherPanel` reads. */
  subAreaId?: string | undefined;
  /** True while the caller has not resolved the bay yet; holds rather than fetching twice. */
  pending?: boolean;
  /** N6c-2's reveal flag — states the absence instead of hiding the panel. */
  reveal?: boolean;
}) {
  const getForecast = useAction(api.weather.getForecastForBody);
  // `forBody` and `loading` exist for one reason: a forecast is a claim about a *place*, and this
  // panel's place can change under it. Across a *bay* switch the previous bay's forecast stays up —
  // dimmed and marked busy, so it is visibly held rather than silently attributed to the newly
  // named bay — because blanking it moved the drawer's content out from under the reader's scroll
  // position. Across a *lake* switch it is dropped, since a stale forecast there would describe
  // another lake under this one's name.
  const [state, setState] = useState<{
    payload: ForecastPayload | null;
    forBody: string | null;
    loading: boolean;
  }>({ payload: null, forBody: null, loading: true });

  useEffect(() => {
    let cancelled = false;
    setState((s) =>
      s.forBody === waterBodyId
        ? { ...s, loading: true }
        : { payload: null, forBody: waterBodyId, loading: true },
    );
    if (pending) return;
    getForecast({
      waterBodyId,
      ...(subAreaId ? { subAreaId: subAreaId as Id<'waterBodySubAreas'> } : {}),
    })
      .then((p) => {
        if (!cancelled) setState({ payload: p, forBody: waterBodyId, loading: false });
      })
      .catch(() => {
        // Fail open and silently: a missing forecast is not an error a skater can act on, and the
        // next drawer-open retries because nothing was cached.
        if (!cancelled) setState({ payload: null, forBody: waterBodyId, loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [getForecast, waterBodyId, subAreaId, pending]);

  // `now` on the lake's clock. Both derivations below compare against the hours' local-shifted
  // timestamps, so the client's own clock is shifted the same way — never the reverse.
  const derived = useMemo(() => {
    const payload = state.payload;
    if (!payload) return null;
    const nowLocalMs = Date.now() + payload.utcOffsetMs;
    return {
      line: formatForecastStrip(summarizeForecast(payload.hours, nowLocalMs)),
      plan: buildForecastPlan(payload.hours, nowLocalMs, {
        arrivalBandMinutes: payload.arrivalBandMinutes,
      }),
    };
  }, [state.payload]);

  const empty = !derived || forecastPlanIsEmpty(derived.plan);
  if (empty && !reveal) return null;

  return (
    <div
      className={`flex flex-col gap-2 transition-opacity ${state.loading ? 'opacity-50' : ''}`}
      aria-busy={state.loading}
    >
      <h3 className="font-mono text-foreground-muted text-xs uppercase tracking-widest">
        What's coming
      </h3>
      {empty || !derived ? (
        <p className="text-foreground-muted text-sm italic">{revealPlaceholder('forecast')}</p>
      ) : (
        <>
          {derived.line ? <p className="text-foreground text-sm">{derived.line}</p> : null}
          <ForecastPlanner plan={derived.plan} />
        </>
      )}
      <p className="text-foreground-muted text-xs">Forecast: Open-Meteo</p>
    </div>
  );
}

/** The symbol vocabulary, resolved to the Sharp Light set (the same family every drawer icon uses). */
const GLYPH_ICON: Record<ForecastGlyph, IconDefinition> = {
  sun: faSun,
  moon: faMoon,
  'cloud-sun': faCloudSun,
  'cloud-moon': faCloudMoon,
  cloud: faCloud,
  fog: faCloudFog,
  drizzle: faCloudDrizzle,
  rain: faCloudRain,
  // Icicles, not a hail cloud: freezing rain is the one condition a skater must not mistake for
  // ordinary rain, and the glyph should look like nothing else on the row.
  'freezing-rain': faIcicles,
  sleet: faCloudSleet,
  snow: faCloudSnow,
  thunder: faCloudBolt,
};

function ConditionIcon({
  glyph,
  label,
  size = 'text-base',
}: {
  glyph: ForecastGlyph;
  label: string;
  size?: string;
}) {
  return (
    <FontAwesomeIcon
      icon={GLYPH_ICON[glyph]}
      className={`${size} text-foreground`}
      title={label}
      aria-label={label}
      role="img"
    />
  );
}

/** `scrollTo` with a `scrollLeft` fallback — jsdom has no `Element.scrollTo`, and neither did Safari 13. */
function scrollRow(el: HTMLElement, left: number, smooth: boolean) {
  if (typeof el.scrollTo === 'function')
    el.scrollTo({ left, behavior: smooth ? 'smooth' : 'auto' });
  else el.scrollLeft = left;
}

/**
 * The two rows. Owns one piece of state — which day the hour row is showing — and keeps it true in
 * both directions: a day-card click scrolls the hours, and scrolling the hours re-selects the day.
 */
export function ForecastPlanner({ plan }: { plan: ForecastPlan }) {
  const hoursRef = useRef<HTMLUListElement>(null);
  const cardRefs = useRef<(HTMLLIElement | null)[]>([]);
  const daysRef = useRef<HTMLFieldSetElement>(null);
  const dayRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [selectedDate, setSelectedDate] = useState<string>(plan.days[0]?.localDate ?? '');
  // Suppresses the scroll listener while a programmatic scroll is in flight, so the day the reader
  // just tapped is not un-selected by the intermediate frames of its own animation.
  const settlingUntil = useRef(0);

  // A new plan (a bay switch, a refetch an hour later) opens at now again, which is index 0.
  useEffect(() => {
    setSelectedDate(plan.days[0]?.localDate ?? '');
    if (hoursRef.current) scrollRow(hoursRef.current, 0, false);
  }, [plan]);

  // When the *hour row* drives the selection the pressed day card may be off the end of its row;
  // bring it in — **horizontally, and only horizontally.** `scrollIntoView` would also scroll the
  // drawer vertically to the card, which on mount (the Today card sits below the past-weather
  // panel) moved the reader's content out from under them. A tap selects a visible card and is a
  // no-op here; so is the first render, where the selected card is the first one.
  useEffect(() => {
    const container = daysRef.current;
    const card = dayRefs.current[plan.days.findIndex((d) => d.localDate === selectedDate)];
    if (!container || !card) return;
    const left = card.offsetLeft - container.offsetLeft;
    const right = left + card.offsetWidth;
    const viewLeft = container.scrollLeft;
    const viewRight = viewLeft + container.clientWidth;
    if (left < viewLeft) scrollRow(container, left, true);
    else if (right > viewRight) scrollRow(container, right - container.clientWidth, true);
  }, [plan.days, selectedDate]);

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
    // The first card whose right edge is past the left edge of the viewport is the one being read.
    const first = cardRefs.current.findIndex(
      (card) => card !== null && card.offsetLeft + card.offsetWidth > left + 1,
    );
    const hour = first >= 0 ? plan.hours[first] : undefined;
    if (hour && hour.localDate !== selectedDate) setSelectedDate(hour.localDate);
  }, [plan.hours, selectedDate]);

  const caption = arrivalCaption(plan);

  return (
    <div className="flex flex-col gap-3">
      <ul
        ref={hoursRef}
        onScroll={onHoursScroll}
        className="flex gap-1 overflow-x-auto pb-1"
        aria-label="Hourly forecast"
      >
        {plan.hours.map((hour, i) => (
          <HourCard
            key={hour.startMs}
            hour={hour}
            firstOfDay={i === 0 || plan.hours[i - 1]?.localDate !== hour.localDate}
            dayLabel={plan.days.find((d) => d.localDate === hour.localDate)?.dateLabel ?? ''}
            ref={(el) => {
              cardRefs.current[i] = el;
            }}
          />
        ))}
      </ul>
      {caption ? (
        <p className="flex items-center gap-1 text-foreground-muted text-xs">
          <FontAwesomeIcon icon={faCarSide} className="text-[10px]" aria-hidden />
          {caption}, if you left now
        </p>
      ) : null}
      {/* A fieldset because it is a group of buttons of which one is pressed — the closest native
          semantics to "pick a day", and what gives assistive tech the group's name. `min-w-0`
          matters: a fieldset defaults to `min-inline-size: min-content`, so without it the row
          grows to its seven cards and overflows the sidebar instead of scrolling. */}
      <fieldset ref={daysRef} className="flex min-w-0 gap-2 overflow-x-auto pb-1">
        <legend className="sr-only">Daily forecast</legend>
        {plan.days.map((day, i) => (
          <DayCard
            key={day.localDate}
            day={day}
            selected={day.localDate === selectedDate}
            onSelect={() => scrollToDay(day)}
            ref={(el) => {
              dayRefs.current[i] = el;
            }}
          />
        ))}
      </fieldset>
    </div>
  );
}

function HourCard({
  hour,
  firstOfDay,
  dayLabel,
  ref,
}: {
  hour: ForecastPlanHour;
  firstOfDay: boolean;
  dayLabel: string;
  ref: (el: HTMLLIElement | null) => void;
}) {
  const label = CONDITION_LABEL[hour.condition];
  // One amount per card, snow first: an hour with both is a snow hour to a skater (the same tie rule
  // `summarizeForecast` uses). Nothing when neither clears a tenth of an inch / a hundredth.
  const amount =
    hour.snowfallIn >= 0.1 ? `${hour.snowfallIn}″` : hour.rainIn >= 0.01 ? `${hour.rainIn}″` : null;
  return (
    <li
      ref={ref}
      aria-label={`${planHourLabel(hour)}, ${label}, ${hour.temperatureF}°F, wind ${hour.windMph} mph${
        amount ? `, ${amount} ${hour.snowfallIn >= 0.1 ? 'snow' : 'rain'}` : ''
      }${hour.arrival ? ', about when you would arrive' : ''}`}
      className={`flex w-12 shrink-0 flex-col items-center gap-1 rounded-md border py-1.5 ${
        hour.arrival ? 'border-border-strong bg-background-subtle' : 'border-transparent'
      }${firstOfDay ? ' ml-1' : ''}`}
    >
      {/* The day label sits in a fixed slot on every card so the row does not jog at midnight;
          only the first card of a day fills it. */}
      <span className="h-3 font-mono text-[10px] text-foreground-muted uppercase leading-3">
        {firstOfDay ? dayLabel : ''}
      </span>
      <span className="text-[10px] text-foreground-muted tabular-nums">{planHourLabel(hour)}</span>
      <ConditionIcon glyph={conditionGlyph(hour.condition, hour.isNight)} label={label} />
      <span className="text-foreground text-sm tabular-nums">{hour.temperatureF}°</span>
      <span className="h-3 text-[10px] text-foreground-muted tabular-nums leading-3">
        {amount ?? ''}
      </span>
      <span className="text-[10px] text-foreground-muted tabular-nums">{hour.windMph} mph</span>
    </li>
  );
}

function DayCard({
  day,
  selected,
  onSelect,
  ref,
}: {
  day: ForecastPlanDay;
  selected: boolean;
  onSelect: () => void;
  ref: (el: HTMLButtonElement | null) => void;
}) {
  const label = CONDITION_LABEL[day.condition];
  const totals: string[] = [];
  if (day.snowfallIn >= 0.1) totals.push(`${day.snowfallIn}″ snow`);
  if (day.rainIn >= 0.01) totals.push(`${day.rainIn}″ rain`);
  totals.push(`wind ${day.maxWindMph} mph`);
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      ref={ref}
      className={`flex w-40 shrink-0 flex-col gap-1 rounded-md border p-2 text-left transition-colors ${
        selected
          ? 'border-border-strong bg-background-subtle'
          : 'border-border hover:border-border-strong'
      }`}
    >
      <div className="flex items-baseline justify-between">
        <span className="text-foreground text-sm">{day.label}</span>
        <span className="font-mono text-[10px] text-foreground-muted uppercase">
          {day.dateLabel}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <ConditionIcon glyph={conditionGlyph(day.condition, false)} label={label} size="text-xl" />
        <div className="flex flex-col">
          <span className="text-foreground text-sm tabular-nums">
            {day.highF}° <span className="text-foreground-muted">/ {day.lowF}°</span>
          </span>
          {day.nightLowF !== null ? (
            <span className="text-[10px] text-foreground-muted tabular-nums">
              night low {day.nightLowF}°
            </span>
          ) : null}
        </div>
      </div>
      <span className="text-[10px] text-foreground-muted">{label}</span>
      <span className="text-[10px] text-foreground-muted tabular-nums">{totals.join(' · ')}</span>
      {day.lines.length > 0 ? (
        <ul className="flex flex-col gap-0.5 border-border border-t pt-1">
          {day.lines.map((line) => (
            <li key={line} className="text-foreground text-xs">
              {line}
            </li>
          ))}
        </ul>
      ) : null}
      {day.partial ? (
        <span className="text-[10px] text-foreground-muted italic">
          {day.label === 'Today' ? 'rest of today' : 'partial day'}
        </span>
      ) : null}
    </button>
  );
}
