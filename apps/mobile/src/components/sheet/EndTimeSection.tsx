import DateTimePicker from '@react-native-community/datetimepicker';
import {
  endTimeRow,
  formatSkateTime,
  precisionForChoice,
  reportEndMs,
  reportsInTimeOrder,
  resolveSkateWindow,
  sectionSummary,
  selectedValues,
  timelineModel,
} from '@skating/core';
import { useEffect, useMemo, useState } from 'react';
import { Platform } from 'react-native';
import { Button, Text, XStack, YStack } from 'tamagui';
import { useSheet } from '../../lib/sheetStore';
import { Input } from '../ThemedInputs';
import { SheetChip } from './SheetChip';
import { SheetHint, SheetSection, SubLabel } from './SheetSection';
import type { SectionProps } from './sectionProps';
import { Timeline } from './Timeline';
import { useSkateWeather, useSkateWindowHours } from './useSkateWeather';
import { WeatherCards } from './WeatherCards';

/**
 * *When* (A10 / D192, re-composed A10-6): the day as a **timeline** first — sunrise and sunset,
 * the start and end, now, the Post's other lakes as spans, D192's half-hour ladder as tappable
 * ticks — then the three rows: **End** (required; the minute the sheet was opened, pinned; the
 * half-hours back; a date picker bounded by the week, D199), **Started** and **How long**
 * (optional; only the resolved start is stored). Under them, the weather the archive has for the
 * hours you were out, as cards (founder call 2026-09-23).
 *
 * Preselected only in daylight at the body; after dark the ladder starts at sunset and nothing is
 * chosen. A track door has already stamped the GPS end exactly, and the row then shows it as the
 * one chip.
 */
export function EndTimeSection({ report, body, dispatch, gaps, timeZone }: SectionProps) {
  const sheet = report.sheet;
  const post = useSheet();
  const [chosen] = selectedValues(sheet, 'endTime');
  // Read once, at mount: the ladder must not tick under the finger.
  const [now] = useState(() => Date.now());
  const row = useMemo(
    () =>
      endTimeRow({
        openedAtMs: sheet.openedAtMs,
        nowMs: now,
        timeZone,
        sun: body?.sunAt(sheet.openedAtMs) ?? null,
      }),
    [sheet.openedAtMs, timeZone, body, now],
  );
  const gps = chosen?.precision === 'gps';
  const [pickerMode, setPickerMode] = useState<'date' | 'time' | null>(null);
  const endMs = chosen?.ms;
  const startMs = sheet.scalars.skateStartTime;

  // Preselect the pinned minute in daylight, once, for a sheet that has nothing chosen yet. The
  // sheet's doing, not the author's: `defaulted` (so an extraction may step it down, D191) and
  // quiet (so an untouched sheet is not dirty the moment it opens).
  useEffect(() => {
    if (chosen !== undefined || sheet.fields.endTime.touched) return;
    const pre = row.preselected !== undefined ? row.chips[row.preselected] : undefined;
    if (!pre) return;
    dispatch(
      {
        type: 'select',
        field: 'endTime',
        key: 'pinned',
        value: { ms: pre.ms, precision: pre.precision },
        defaulted: true,
      },
      { quiet: true },
    );
  }, [chosen, dispatch, row, sheet.fields.endTime.touched]);

  const choose = (ms: number) =>
    dispatch({
      type: 'select',
      field: 'endTime',
      key: 'chosen',
      value: { ms, precision: precisionForChoice(row, ms) },
    });
  const clockFormat = useMemo(
    () => new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }),
    [timeZone],
  );

  const hours = useSkateWeather(body?.waterBodyId, endMs, timeZone);
  const windowHours = useSkateWindowHours(hours, endMs, startMs);
  const model = useMemo(() => {
    // The other Reports of the Post, numbered as their tabs are (time order).
    const others = (post ? reportsInTimeOrder(post) : []).flatMap((r, i) => {
      const e = r.id === report.id ? undefined : reportEndMs(r);
      if (e === undefined) return [];
      return [
        {
          id: r.id,
          label: `${i + 1} · ${(r.bodyName ?? 'lake').toUpperCase()}`,
          ...(r.sheet.scalars.skateStartTime !== undefined
            ? { startMs: r.sheet.scalars.skateStartTime }
            : {}),
          endMs: e,
        },
      ];
    });
    return timelineModel({
      timeZone,
      nowMs: now,
      ...(endMs !== undefined ? { endMs } : {}),
      ...(startMs !== undefined ? { startMs } : {}),
      sun: body?.sunAt(endMs ?? now) ?? null,
      others,
      ladder:
        gps || row.reason === 'expired'
          ? []
          : row.chips.map((c) => ({ ms: c.ms, pinned: c.pinned })),
    });
  }, [post, report.id, timeZone, now, endMs, startMs, body, gps, row]);
  const offLadder = chosen !== undefined && !row.chips.some((c) => c.ms === chosen.ms);

  return (
    <SheetSection
      label="When"
      summary={sectionSummary(sheet, 'endTime', timeZone)}
      collapsed={sheet.collapsed.endTime}
      onToggle={() =>
        dispatch({ type: 'setCollapsed', section: 'endTime', collapsed: !sheet.collapsed.endTime })
      }
      gap={gaps.has('endTime')}
    >
      <Timeline model={model} onChooseEnd={gps ? undefined : choose} />
      <SubLabel>End</SubLabel>
      {gps ? (
        <Text color="$foreground" fontSize={14}>
          {formatSkateTime(chosen.ms)}
          <Text color="$foregroundMuted" fontSize={12}>
            {'  '}from your track
          </Text>
        </Text>
      ) : row.reason === 'expired' ? (
        <SheetHint>
          This sheet was opened more than a week ago. Reports post up to a week after you got off
          the ice — start a new one.
        </SheetHint>
      ) : (
        <YStack gap="$2">
          <XStack gap={6} flexWrap="wrap">
            {row.chips.map((chip) => (
              <SheetChip
                key={chip.ms}
                compact
                label={
                  chip.pinned ? `${clockFormat.format(chip.ms)} · now` : clockFormat.format(chip.ms)
                }
                tier={chosen?.ms === chip.ms ? 'solid' : undefined}
                onPress={() => choose(chip.ms)}
              />
            ))}
            <SheetChip
              compact
              label={offLadder ? formatSkateTime(chosen.ms) : 'Another time'}
              tier={offLadder ? 'solid' : undefined}
              onPress={() => setPickerMode('date')}
            />
          </XStack>
          {row.reason === 'after_dark' && chosen === undefined ? (
            <SheetHint>It's after dark — when did you come off?</SheetHint>
          ) : null}
          {pickerMode ? (
            <DateTimePicker
              value={new Date(chosen?.ms ?? row.pickerMaxMs)}
              mode={Platform.OS === 'ios' ? 'datetime' : pickerMode}
              minimumDate={new Date(row.pickerMinMs)}
              maximumDate={new Date(row.pickerMaxMs)}
              onChange={(event, date) => {
                if (event.type === 'dismissed' || !date) {
                  setPickerMode(null);
                  return;
                }
                choose(date.getTime());
                if (Platform.OS === 'ios') return;
                setPickerMode(pickerMode === 'date' ? 'time' : null);
              }}
            />
          ) : null}
        </YStack>
      )}
      <StartWindow report={report} dispatch={dispatch} />
      {chosen !== undefined && body ? (
        <WeatherCards
          hours={hours}
          windowHours={windowHours}
          endMs={endMs}
          timeZone={timeZone}
          sun={body.sunAt(endMs ?? now)}
          report={report}
          dispatch={dispatch}
        />
      ) : null}
    </SheetSection>
  );
}

/** *Started* and *How long* — a start time or a duration; only the resolved start is stored. */
function StartWindow({ report, dispatch }: Pick<SectionProps, 'report' | 'dispatch'>) {
  const sheet = report.sheet;
  const [end] = selectedValues(sheet, 'endTime');
  const start = sheet.scalars.skateStartTime;
  const [mode, setMode] = useState<'none' | 'start' | 'duration'>(
    start !== undefined ? 'start' : 'none',
  );
  const [durationStr, setDurationStr] = useState('');
  const [picker, setPicker] = useState<'date' | 'time' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const gpsStart = end?.precision === 'gps' && start !== undefined;

  const resolve = (input: { start?: number; durationMinutes?: number }) => {
    if (end === undefined) return;
    const result = resolveSkateWindow({ end: end.ms, ...input });
    if (result.ok) {
      setError(null);
      dispatch({ type: 'setScalar', key: 'skateStartTime', value: result.skateStartTime });
    } else setError(result.error);
  };
  const clear = () => {
    setMode('none');
    dispatch({ type: 'setScalar', key: 'skateStartTime', value: undefined });
  };
  const minutes = start !== undefined && end ? Math.round((end.ms - start) / 60_000) : undefined;
  const duration =
    minutes !== undefined && minutes > 0
      ? `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`
      : undefined;

  if (gpsStart) {
    return (
      <>
        <SubLabel>Started</SubLabel>
        <Text color="$foreground" fontSize={14}>
          {formatSkateTime(start)}
          <Text color="$foregroundMuted" fontSize={12}>
            {'  '}from your track · {duration ?? ''} on the ice
          </Text>
        </Text>
      </>
    );
  }
  return (
    <YStack gap="$2">
      <SubLabel>Started · how long</SubLabel>
      <XStack gap={6} flexWrap="wrap">
        <SheetChip
          compact
          label={start !== undefined ? formatSkateTime(start) : 'A start time'}
          tier={start !== undefined ? 'solid' : undefined}
          onPress={() => {
            if (mode === 'start') clear();
            else {
              setMode('start');
              setPicker('date');
            }
          }}
        />
        <SheetChip
          compact
          label={duration ?? 'How long'}
          tier={duration !== undefined ? 'solid' : undefined}
          onPress={() => (mode === 'duration' ? clear() : setMode('duration'))}
        />
      </XStack>
      {mode === 'start' ? (
        <XStack gap="$2" alignItems="center">
          <Text color="$foreground" flex={1} fontSize={13}>
            {start !== undefined ? formatSkateTime(start) : 'Not set'}
          </Text>
          <Button size="$2" onPress={() => setPicker('date')}>
            {start !== undefined ? 'Change' : 'Set'}
          </Button>
        </XStack>
      ) : null}
      {mode === 'start' && picker && end ? (
        <DateTimePicker
          value={new Date(start ?? end.ms)}
          mode={Platform.OS === 'ios' ? 'datetime' : picker}
          maximumDate={new Date(end.ms)}
          onChange={(event, date) => {
            if (event.type === 'dismissed' || !date) {
              setPicker(null);
              return;
            }
            resolve({ start: date.getTime() });
            if (Platform.OS === 'ios') return;
            setPicker(picker === 'date' ? 'time' : null);
          }}
        />
      ) : null}
      {mode === 'duration' ? (
        <Input
          keyboardType="number-pad"
          inputMode="numeric"
          placeholder="minutes, e.g. 90"
          value={durationStr}
          onChangeText={(text) => {
            setDurationStr(text);
            if (text.trim() === '') {
              dispatch({ type: 'setScalar', key: 'skateStartTime', value: undefined });
              return;
            }
            resolve({ durationMinutes: Number(text) });
          }}
        />
      ) : null}
      {error ? (
        <Text color="$danger" fontSize={12}>
          {error}
        </Text>
      ) : mode !== 'none' && !end ? (
        <SheetHint>Say when you got off first — a start time is read back from it.</SheetHint>
      ) : null}
    </YStack>
  );
}
