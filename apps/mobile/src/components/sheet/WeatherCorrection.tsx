import {
  cToF,
  fToC,
  kphToMph,
  mphToKph,
  PRECIP_LABELS,
  PRECIP_TYPES,
  type ReportConditionsInput,
  roundTo,
  SKY_CONDITIONS,
  SKY_LABELS,
} from '@skating/core';
import { useState } from 'react';
import { Button, Text, XStack, YStack } from 'tamagui';
import { Input } from '../ThemedInputs';
import { SheetChip } from './SheetChip';

/**
 * The weather, corrected by the author (founder call, 2026-09-21): the archive's hour is the
 * starting point, the author changes what they saw, and the block stores as `source: 'user'` — a
 * person's observation over a model's, the rule the autofill has always kept.
 */
export function WeatherCorrection({
  initial,
  onChange,
  onDone,
}: {
  initial: ReportConditionsInput;
  onChange: (next: ReportConditionsInput) => void;
  onDone: () => void;
}) {
  const [tempF, setTempF] = useState(
    initial.airTempC === undefined ? '' : String(roundTo(cToF(initial.airTempC), 0)),
  );
  const [windMph, setWindMph] = useState(
    initial.windSpeedKph === undefined ? '' : String(roundTo(kphToMph(initial.windSpeedKph), 0)),
  );
  const [windDir, setWindDir] = useState(initial.windDir ?? '');
  const [sky, setSky] = useState(initial.sky);
  const [precip, setPrecip] = useState(initial.precip);

  const emit = (patch: {
    tempF?: string;
    windMph?: string;
    windDir?: string;
    sky?: ReportConditionsInput['sky'];
    precip?: ReportConditionsInput['precip'];
  }) => {
    const t = patch.tempF ?? tempF;
    const w = patch.windMph ?? windMph;
    const d = patch.windDir ?? windDir;
    const s = 'sky' in patch ? patch.sky : sky;
    const p = 'precip' in patch ? patch.precip : precip;
    const num = (v: string) =>
      v.trim() === '' || !Number.isFinite(Number(v)) ? undefined : Number(v);
    onChange({
      ...(num(t) !== undefined ? { airTempC: fToC(num(t) as number) } : {}),
      ...(num(w) !== undefined ? { windSpeedKph: mphToKph(num(w) as number) } : {}),
      ...(d.trim() ? { windDir: d.trim().toUpperCase() } : {}),
      ...(s !== undefined ? { sky: s } : {}),
      ...(p !== undefined ? { precip: p } : {}),
      source: 'user',
    });
  };

  return (
    <YStack gap="$2.5" padding="$3" borderRadius="$xs" backgroundColor="$surfaceMuted">
      <XStack gap="$2">
        <YStack flex={1} gap="$1">
          <Text color="$foregroundMuted" fontSize={11}>
            Air °F
          </Text>
          <Input
            keyboardType="decimal-pad"
            inputMode="decimal"
            value={tempF}
            onChangeText={(v) => {
              setTempF(v);
              emit({ tempF: v });
            }}
          />
        </YStack>
        <YStack flex={1} gap="$1">
          <Text color="$foregroundMuted" fontSize={11}>
            Wind mph
          </Text>
          <Input
            keyboardType="decimal-pad"
            inputMode="decimal"
            value={windMph}
            onChangeText={(v) => {
              setWindMph(v);
              emit({ windMph: v });
            }}
          />
        </YStack>
        <YStack flex={1} gap="$1">
          <Text color="$foregroundMuted" fontSize={11}>
            From
          </Text>
          <Input
            placeholder="NW"
            autoCapitalize="characters"
            value={windDir}
            onChangeText={(v) => {
              setWindDir(v);
              emit({ windDir: v });
            }}
          />
        </YStack>
      </XStack>
      <XStack gap={6} flexWrap="wrap">
        {SKY_CONDITIONS.map((s) => (
          <SheetChip
            key={s}
            compact
            label={SKY_LABELS[s]}
            tier={sky === s ? 'solid' : undefined}
            onPress={() => {
              const next = sky === s ? undefined : s;
              setSky(next);
              emit({ sky: next });
            }}
          />
        ))}
      </XStack>
      <XStack gap={6} flexWrap="wrap">
        {PRECIP_TYPES.map((p) => (
          <SheetChip
            key={p}
            compact
            label={PRECIP_LABELS[p]}
            tier={precip === p ? 'solid' : undefined}
            onPress={() => {
              const next = precip === p ? undefined : p;
              setPrecip(next);
              emit({ precip: next });
            }}
          />
        ))}
      </XStack>
      <Button size="$2" alignSelf="flex-start" onPress={onDone}>
        Done
      </Button>
    </YStack>
  );
}
