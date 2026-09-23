import { FontAwesomeIcon } from '@fortawesome/react-native-fontawesome';
import {
  conditionsFromWindowHour,
  hourAt,
  type SunTimes,
  type WindowHour,
  weatherCells,
  weatherRunSummary,
} from '@skating/core';
import { useState } from 'react';
import { ScrollView } from 'react-native';
import { Text, useTheme, XStack, YStack } from 'tamagui';
import { GLYPH_ICON } from '../weatherGlyphs';
import { SheetHint } from './SheetSection';
import type { SectionProps } from './sectionProps';
import { WeatherCorrection } from './WeatherCorrection';

/**
 * The weather the skate had, on the phone (A10-6, founder call 2026-09-23): one card per archived
 * hour the skate touched, in the drawer's hourly lockup — symbol, temperature, amount, wind — in a
 * row under the timeline, and a line for what the weather did first to last. *Correct it* opens
 * the same correction as before; a correction stores as the author's own reading.
 *
 * Nothing here is a safety claim (D3 / D150): what the weather did, never what the ice is.
 */
export function WeatherCards({
  hours,
  windowHours,
  endMs,
  timeZone,
  sun,
  report,
  dispatch,
}: {
  hours: WindowHour[] | null;
  windowHours: readonly WindowHour[];
  endMs: number | undefined;
  timeZone: string;
  sun: SunTimes | null;
} & Pick<SectionProps, 'report' | 'dispatch'>) {
  const theme = useTheme();
  const [correcting, setCorrecting] = useState(false);
  const cells = weatherCells(windowHours, timeZone, sun);
  const summary = weatherRunSummary(cells);
  const corrected = report.sheet.scalars.conditions;
  const at = hours && endMs !== undefined ? hourAt(hours, endMs) : null;
  if (endMs === undefined || hours === null || summary === null) return null;

  return (
    <YStack gap="$1.5">
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <XStack>
          {cells.map((cell, i) => (
            <YStack
              key={cell.startMs}
              width={58}
              alignItems="center"
              gap={2}
              paddingVertical={6}
              borderWidth={1}
              borderRightWidth={i === cells.length - 1 ? 1 : 0}
              borderColor="$border"
              accessibilityLabel={`${cell.label}, ${cell.conditionLabel}, ${cell.temperatureF} degrees${
                cell.windMph !== undefined
                  ? `, wind ${cell.windFrom ?? ''} ${cell.windMph} miles per hour`
                  : ''
              }${cell.amount ? `, ${cell.amount}` : ''}`}
            >
              <Text color="$foregroundMuted" fontSize={10}>
                {cell.label}
              </Text>
              <FontAwesomeIcon
                icon={GLYPH_ICON[cell.glyph]}
                color={theme.foreground?.val}
                size={15}
              />
              <Text color="$foreground" fontSize={14}>
                {cell.temperatureF}°
              </Text>
              <Text color="$foregroundMuted" fontSize={10} height={12}>
                {cell.amount ?? ''}
              </Text>
              <Text color="$foregroundMuted" fontSize={10}>
                {cell.windMph !== undefined ? `${cell.windFrom ?? ''} ${cell.windMph}` : ''}
              </Text>
            </YStack>
          ))}
        </XStack>
      </ScrollView>
      <XStack gap={8} flexWrap="wrap" alignItems="baseline">
        <Text color="$foreground" fontSize={12} fontWeight="600">
          {summary.temperature}
        </Text>
        {summary.wind ? (
          <Text color="$foreground" fontSize={12}>
            {summary.wind}
          </Text>
        ) : null}
        <Text color="$foreground" fontSize={12}>
          {summary.sky}
        </Text>
        {corrected !== undefined && corrected.source !== 'openmeteo' ? (
          <Text color="$foregroundMuted" fontSize={11}>
            · corrected
          </Text>
        ) : null}
        <XStack flex={1} />
        <Text
          color="$foregroundMuted"
          fontSize={11}
          onPress={() => setCorrecting((c) => !c)}
          accessibilityRole="button"
        >
          {correcting ? 'Close' : 'Correct it'}
        </Text>
      </XStack>
      {correcting ? (
        <WeatherCorrection
          initial={
            corrected ??
            (at ? { ...conditionsFromWindowHour(at), source: 'user' } : { source: 'user' })
          }
          onChange={(next) => dispatch({ type: 'setScalar', key: 'conditions', value: next })}
          onDone={() => setCorrecting(false)}
        />
      ) : null}
      {cells.length === 0 ? <SheetHint>No archived weather for these hours yet.</SheetHint> : null}
    </YStack>
  );
}
