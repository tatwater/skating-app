import type { IconDefinition } from '@fortawesome/fontawesome-svg-core';
import { FontAwesomeIcon } from '@fortawesome/react-native-fontawesome';
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
import { type NativeScrollEvent, type NativeSyntheticEvent, ScrollView } from 'react-native';
import { Paragraph, Text, useTheme, XStack, YStack } from 'tamagui';
import { Section } from './detailUi';

/**
 * The forward forecast on a lake sheet — the mobile half of the web `ForecastPanel` (N6c B5b, the
 * seven-day planner since N6h Workstream D).
 *
 * Same one fetch, same three things: the strip line, the hourly cards that open at *now*, and the
 * day cards whose tap scrolls the hours to that morning. Every sentence and number comes from
 * `@skating/core`'s `buildForecastPlan`, so what a reader sees here and on the web is one
 * implementation; this file is layout in Tamagui plus two `ScrollView`s.
 *
 * D3 holds at the copy: it names weather and a clock, never the ice.
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
  // Held across a bay switch (dimmed, busy), dropped across a lake switch — the rule
  // `PastWeatherPanel` follows and the web panel documents.
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
        if (!cancelled) setState({ payload: null, forBody: waterBodyId, loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [getForecast, waterBodyId, subAreaId, pending]);

  const derived = useMemo(() => {
    const payload = state.payload;
    if (!payload) return null;
    // The client's clock shifted onto the hours' local clock — never the reverse.
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
    <YStack opacity={state.loading ? 0.5 : 1} accessibilityState={{ busy: state.loading }}>
      <Section label="What's coming">
        {empty || !derived ? (
          <Paragraph color="$foregroundMuted" fontSize={14} fontStyle="italic">
            {revealPlaceholder('forecast')}
          </Paragraph>
        ) : (
          <>
            {derived.line ? (
              <Paragraph color="$foreground" fontSize={14}>
                {derived.line}
              </Paragraph>
            ) : null}
            <ForecastPlanner plan={derived.plan} />
          </>
        )}
        <Text color="$foregroundMuted" fontSize={11}>
          Forecast: Open-Meteo
        </Text>
      </Section>
    </YStack>
  );
}

/** The symbol vocabulary, resolved to the same Sharp Light set the web panel uses. */
const GLYPH_ICON: Record<ForecastGlyph, IconDefinition> = {
  sun: faSun,
  moon: faMoon,
  'cloud-sun': faCloudSun,
  'cloud-moon': faCloudMoon,
  cloud: faCloud,
  fog: faCloudFog,
  drizzle: faCloudDrizzle,
  rain: faCloudRain,
  // Icicles, not a hail cloud — freezing rain must look like nothing else on the row.
  'freezing-rain': faIcicles,
  sleet: faCloudSleet,
  snow: faCloudSnow,
  thunder: faCloudBolt,
};

/** Hour-card geometry, in px. The row scrolls by these, so they are constants rather than measured. */
const HOUR_CARD_WIDTH = 52;
const HOUR_CARD_GAP = 4;
const DAY_CARD_WIDTH = 168;
const DAY_CARD_GAP = 8;

/**
 * The two rows. One piece of state — the day the hour row is showing — kept true both ways: a tap
 * on a day card scrolls the hours, and scrolling the hours re-selects the day.
 */
export function ForecastPlanner({ plan }: { plan: ForecastPlan }) {
  const theme = useTheme();
  // `FontAwesomeIcon` draws SVG and knows nothing of theme tokens, so the tint is resolved once.
  const ink = theme.foreground?.val ?? undefined;
  const inkMuted = theme.foregroundMuted?.val ?? undefined;
  const hoursRef = useRef<ScrollView>(null);
  const daysRef = useRef<ScrollView>(null);
  const [selectedDate, setSelectedDate] = useState<string>(plan.days[0]?.localDate ?? '');
  const settlingUntil = useRef(0);
  // The date a tap selected, so the follow effect below can tell a tapped card (already on screen —
  // leave the row where the finger is) from one the hour row selected (maybe off the end — bring
  // it in). The hour-row path clears it, so a tap on the already-pressed card cannot leave it stale.
  const tappedDate = useRef<string | null>(null);

  // When the hour row drives the selection, the day row follows so the pressed card is on screen.
  // The day cards are fixed-width, so the offset is arithmetic rather than a measured layout.
  useEffect(() => {
    if (tappedDate.current === selectedDate) return;
    const i = plan.days.findIndex((d) => d.localDate === selectedDate);
    if (i < 0) return;
    daysRef.current?.scrollTo({
      x: Math.max(0, i * (DAY_CARD_WIDTH + DAY_CARD_GAP) - 16),
      animated: true,
    });
  }, [plan.days, selectedDate]);

  useEffect(() => {
    setSelectedDate(plan.days[0]?.localDate ?? '');
    hoursRef.current?.scrollTo({ x: 0, animated: false });
  }, [plan]);

  const scrollToDay = useCallback((day: ForecastPlanDay) => {
    tappedDate.current = day.localDate;
    setSelectedDate(day.localDate);
    settlingUntil.current = Date.now() + 700;
    hoursRef.current?.scrollTo({
      x: day.firstHourIndex * (HOUR_CARD_WIDTH + HOUR_CARD_GAP),
      animated: true,
    });
  }, []);

  const onHoursScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (Date.now() < settlingUntil.current) return;
      const x = e.nativeEvent.contentOffset.x;
      const first = Math.max(
        0,
        Math.floor((x + HOUR_CARD_WIDTH / 2) / (HOUR_CARD_WIDTH + HOUR_CARD_GAP)),
      );
      const hour = plan.hours[Math.min(first, plan.hours.length - 1)];
      if (hour && hour.localDate !== selectedDate) {
        tappedDate.current = null;
        setSelectedDate(hour.localDate);
      }
    },
    [plan.hours, selectedDate],
  );

  const caption = arrivalCaption(plan);

  return (
    <YStack gap="$3" marginTop="$2">
      <ScrollView
        ref={hoursRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        onScroll={onHoursScroll}
        scrollEventThrottle={64}
        accessibilityLabel="Hourly forecast"
      >
        <XStack gap={HOUR_CARD_GAP}>
          {plan.hours.map((hour, i) => (
            <HourCard
              // The instant, not the local clock: a fall-back night has two 1 AMs with one `startMs`.
              key={hour.utcMs ?? `${hour.startMs}:${i}`}
              hour={hour}
              firstOfDay={i === 0 || plan.hours[i - 1]?.localDate !== hour.localDate}
              dayLabel={plan.days.find((d) => d.localDate === hour.localDate)?.dateLabel ?? ''}
              ink={ink}
            />
          ))}
        </XStack>
      </ScrollView>
      {caption ? (
        <XStack gap="$1.5" alignItems="center">
          <FontAwesomeIcon icon={faCarSide} color={inkMuted} size={11} />
          <Text color="$foregroundMuted" fontSize={11}>
            {caption}, if you left now
          </Text>
        </XStack>
      ) : null}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        accessibilityLabel="Daily forecast"
      >
        <XStack gap="$2">
          {plan.days.map((day) => (
            <DayCard
              key={day.localDate}
              day={day}
              selected={day.localDate === selectedDate}
              onSelect={() => scrollToDay(day)}
              ink={ink}
            />
          ))}
        </XStack>
      </ScrollView>
    </YStack>
  );
}

function HourCard({
  hour,
  firstOfDay,
  dayLabel,
  ink,
}: {
  hour: ForecastPlanHour;
  firstOfDay: boolean;
  dayLabel: string;
  ink: string | undefined;
}) {
  const label = CONDITION_LABEL[hour.condition];
  // One amount per card, snow first — the tie rule `summarizeForecast` uses.
  const amount =
    hour.snowfallIn >= 0.1 ? `${hour.snowfallIn}″` : hour.rainIn >= 0.01 ? `${hour.rainIn}″` : '';
  return (
    <YStack
      width={HOUR_CARD_WIDTH}
      alignItems="center"
      gap="$1"
      paddingVertical="$1.5"
      borderRadius="$3"
      borderWidth={1}
      borderColor={hour.arrival ? '$borderStrong' : 'transparent'}
      backgroundColor={hour.arrival ? '$surfaceMuted' : 'transparent'}
      accessibilityLabel={`${planHourLabel(hour)}, ${label}, ${hour.temperatureF} degrees, wind ${hour.windMph} miles per hour${
        amount ? `, ${amount} ${hour.snowfallIn >= 0.1 ? 'snow' : 'rain'}` : ''
      }${hour.arrival ? ', about when you would arrive' : ''}`}
    >
      {/* A fixed slot on every card so the row does not jog at midnight. */}
      <Text color="$foregroundMuted" fontSize={9} height={12} textTransform="uppercase">
        {firstOfDay ? dayLabel : ''}
      </Text>
      <Text color="$foregroundMuted" fontSize={10}>
        {planHourLabel(hour)}
      </Text>
      <FontAwesomeIcon
        icon={GLYPH_ICON[conditionGlyph(hour.condition, hour.isNight)]}
        color={ink}
        size={16}
      />
      <Text color="$foreground" fontSize={14}>
        {hour.temperatureF}°
      </Text>
      <Text color="$foregroundMuted" fontSize={10} height={12}>
        {amount}
      </Text>
      <Text color="$foregroundMuted" fontSize={10}>
        {hour.windMph} mph
      </Text>
    </YStack>
  );
}

function DayCard({
  day,
  selected,
  onSelect,
  ink,
}: {
  day: ForecastPlanDay;
  selected: boolean;
  onSelect: () => void;
  ink: string | undefined;
}) {
  const label = CONDITION_LABEL[day.condition];
  const totals: string[] = [];
  if (day.snowfallIn >= 0.1) totals.push(`${day.snowfallIn}″ snow`);
  if (day.rainIn >= 0.01) totals.push(`${day.rainIn}″ rain`);
  totals.push(`wind ${day.maxWindMph} mph`);
  return (
    <YStack
      width={DAY_CARD_WIDTH}
      gap="$1"
      padding="$2"
      borderRadius="$3"
      borderWidth={1}
      borderColor={selected ? '$borderStrong' : '$border'}
      backgroundColor={selected ? '$surfaceMuted' : 'transparent'}
      onPress={onSelect}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={`${day.label}, ${day.dateLabel}: ${label}, high ${day.highF}, low ${day.lowF}`}
      pressStyle={{ opacity: 0.7 }}
    >
      <XStack justifyContent="space-between" alignItems="baseline">
        <Text color="$foreground" fontSize={14}>
          {day.label}
        </Text>
        <Text color="$foregroundMuted" fontSize={10} textTransform="uppercase">
          {day.dateLabel}
        </Text>
      </XStack>
      <XStack gap="$2" alignItems="center">
        <FontAwesomeIcon
          icon={GLYPH_ICON[conditionGlyph(day.condition, false)]}
          color={ink}
          size={22}
        />
        <YStack>
          <Text color="$foreground" fontSize={14}>
            {day.highF}°{' '}
            <Text color="$foregroundMuted" fontSize={14}>
              / {day.lowF}°
            </Text>
          </Text>
          {day.nightLowF !== null ? (
            <Text color="$foregroundMuted" fontSize={10}>
              night low {day.nightLowF}°
            </Text>
          ) : null}
        </YStack>
      </XStack>
      <Text color="$foregroundMuted" fontSize={10}>
        {label}
      </Text>
      <Text color="$foregroundMuted" fontSize={10}>
        {totals.join(' · ')}
      </Text>
      {day.lines.length > 0 ? (
        <YStack gap="$0.5" borderTopWidth={1} borderTopColor="$border" paddingTop="$1">
          {day.lines.map((line) => (
            <Text key={line} color="$foreground" fontSize={12}>
              {line}
            </Text>
          ))}
        </YStack>
      ) : null}
      {day.partial ? (
        <Text color="$foregroundMuted" fontSize={10} fontStyle="italic">
          {day.label === 'Today' ? 'rest of today' : 'partial day'}
        </Text>
      ) : null}
    </YStack>
  );
}
