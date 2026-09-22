import DateTimePicker from '@react-native-community/datetimepicker';
import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import {
  conditionsFromWindowHour,
  describeWeatherHour,
  endTimeRow,
  formatSkateTime,
  hourAt,
  hoursInWindow,
  placeHours,
  precisionForChoice,
  resolveSkateWindow,
  sectionSummary,
  selectedValues,
  summarizeWeatherWindow,
  type WindowHour,
} from '@skating/core';
import { useAction } from 'convex/react';
import { useEffect, useMemo, useState } from 'react';
import { Platform } from 'react-native';
import { Button, Text, XStack, YStack } from 'tamagui';
import { Input } from '../ThemedInputs';
import { SheetChip } from './SheetChip';
import { SheetHint, SheetSection, SubLabel } from './SheetSection';
import type { SectionProps } from './sectionProps';
import { WeatherCorrection } from './WeatherCorrection';

/**
 * *When did you get off?* (A10 / D192): the minute the sheet was opened, pinned; half-hour steps
 * back; a date picker bounded by the week (D199). Preselected only in daylight at the body; after
 * dark the ladder starts at sunset and nothing is chosen. A track door has already stamped the
 * GPS end exactly, and the row then shows it as the one chip.
 *
 * Under the chosen time, **the weather the archive has for that hour** at the body (founder call,
 * 2026-09-21); with a start time or a duration, the whole run — a reason to give both. *Not what
 * you saw?* opens the correction, which stores as the author's own reading.
 */
export function EndTimeSection({ report, body, dispatch, gaps, timeZone }: SectionProps) {
  const sheet = report.sheet;
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

  return (
    <SheetSection
      label="When did you get off?"
      summary={sectionSummary(sheet, 'endTime', timeZone)}
      collapsed={sheet.collapsed.endTime}
      onToggle={() =>
        dispatch({ type: 'setCollapsed', section: 'endTime', collapsed: !sheet.collapsed.endTime })
      }
      gap={gaps.has('endTime')}
    >
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
          <XStack gap="$2" flexWrap="wrap">
            {row.chips.map((chip) => {
              const selected = chosen?.ms === chip.ms;
              return (
                <SheetChip
                  key={chip.ms}
                  label={
                    chip.pinned
                      ? `${new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(chip.ms)} · now`
                      : new Intl.DateTimeFormat('en-US', {
                          timeZone,
                          hour: 'numeric',
                          minute: '2-digit',
                        }).format(chip.ms)
                  }
                  tier={selected ? 'solid' : undefined}
                  onPress={() => choose(chip.ms)}
                />
              );
            })}
            <SheetChip
              label={
                chosen !== undefined && !row.chips.some((c) => c.ms === chosen.ms)
                  ? formatSkateTime(chosen.ms)
                  : 'Another time'
              }
              tier={
                chosen !== undefined && !row.chips.some((c) => c.ms === chosen.ms)
                  ? 'solid'
                  : undefined
              }
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
        <SkateWeather
          waterBodyId={body.waterBodyId}
          endMs={chosen.ms}
          startMs={sheet.scalars.skateStartTime}
          timeZone={timeZone}
          report={report}
          dispatch={dispatch}
        />
      ) : null}
    </SheetSection>
  );
}

/** *When did you get on?* — a start time or a duration; only the resolved start is stored. */
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

  if (gpsStart) {
    return (
      <Text color="$foregroundMuted" fontSize={12}>
        On the ice from {formatSkateTime(start)}, from your track.
      </Text>
    );
  }
  const minutes = start !== undefined && end ? Math.round((end.ms - start) / 60_000) : undefined;
  return (
    <YStack gap="$2">
      <SubLabel>When did you get on? (optional)</SubLabel>
      <XStack gap="$2" flexWrap="wrap">
        <SheetChip
          label="A start time"
          tier={mode === 'start' ? 'solid' : undefined}
          onPress={() => {
            if (mode === 'start') {
              setMode('none');
              dispatch({ type: 'setScalar', key: 'skateStartTime', value: undefined });
            } else {
              setMode('start');
              setPicker('date');
            }
          }}
        />
        <SheetChip
          label="How long"
          tier={mode === 'duration' ? 'solid' : undefined}
          onPress={() => {
            if (mode === 'duration') {
              setMode('none');
              dispatch({ type: 'setScalar', key: 'skateStartTime', value: undefined });
            } else setMode('duration');
          }}
        />
      </XStack>
      {mode === 'start' ? (
        <XStack gap="$2" alignItems="center">
          <Text color="$foreground" flex={1}>
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
      ) : minutes !== undefined && minutes > 0 ? (
        <SheetHint>About {minutes} minutes on the ice.</SheetHint>
      ) : null}
    </YStack>
  );
}

/**
 * The archive's weather for the skate (founder call, 2026-09-21): the hour at the end time, or the
 * whole window once a start is known. Read through the panel's action, which serves the hours the
 * drawer already fetched and fetches the rest once; nothing shows until the archive answers, and
 * nothing is guessed. Offline the action rejects and the line simply is not there.
 */
function SkateWeather({
  waterBodyId,
  endMs,
  startMs,
  timeZone,
  report,
  dispatch,
}: {
  waterBodyId: string;
  endMs: number;
  startMs: number | undefined;
  timeZone: string;
} & Pick<SectionProps, 'report' | 'dispatch'>) {
  const getDays = useAction(api.weatherArchive.getWeatherDaysForBody);
  const [hours, setHours] = useState<WindowHour[] | null>(null);
  const [correcting, setCorrecting] = useState(false);
  // Re-read when the day the end time falls on changes, not on every minute chip.
  const dayMs = 24 * 3600_000;
  const days = Math.min(92, Math.max(2, Math.ceil((Date.now() - endMs) / dayMs) + 2));

  useEffect(() => {
    let cancelled = false;
    getDays({ waterBodyId: waterBodyId as Id<'waterBodies'>, days })
      .then((res) => {
        if (cancelled || !res) return;
        setHours(placeHours(res.hours, timeZone));
      })
      .catch(() => {
        // No signal, or no archive for this cell yet: the line stays absent.
      });
    return () => {
      cancelled = true;
    };
  }, [getDays, waterBodyId, timeZone, days]);

  if (hours === null) return null;
  const window = hoursInWindow(hours, endMs, startMs);
  const at = hourAt(hours, endMs);
  const summary = startMs !== undefined ? summarizeWeatherWindow(window, timeZone) : null;
  const corrected = report.sheet.scalars.conditions;
  if (!at && !summary) return null;

  return (
    <YStack gap="$1.5" paddingTop="$1">
      <Text color="$foreground" fontSize={13}>
        {summary ? summary.sentence : at ? describeWeatherHour(at) : ''}
        {corrected !== undefined && corrected.source !== 'openmeteo' ? (
          <Text color="$foregroundMuted" fontSize={12}>
            {'  '}· corrected
          </Text>
        ) : null}
      </Text>
      {correcting ? (
        <WeatherCorrection
          initial={
            corrected ??
            (at ? { ...conditionsFromWindowHour(at), source: 'user' } : { source: 'user' })
          }
          onChange={(next) => dispatch({ type: 'setScalar', key: 'conditions', value: next })}
          onDone={() => setCorrecting(false)}
        />
      ) : (
        <XStack>
          <Text
            color="$primary"
            fontSize={12}
            onPress={() => setCorrecting(true)}
            accessibilityRole="button"
          >
            Not what you saw? Correct it
          </Text>
        </XStack>
      )}
    </YStack>
  );
}
