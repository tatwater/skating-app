import {
  cmToInches,
  DRIVE_TIME_BANDS,
  type FeedFilters,
  type IceType,
  inchesToCm,
  roundTo,
  type SkateQuality,
  type SurfaceTag,
} from '@skating/core';
import { useState } from 'react';
import { Button, Input, Text, XStack, YStack } from 'tamagui';
import { activeFilterCount } from '../lib/feedFilters';

/**
 * The persisted newsfeed filter row (Phase 4, decision #3) — the mobile mirror of web's
 * `FeedFilterBar`. An **additive** narrow over the global feed, defaulting to show-all; collapsible so
 * it stays out of the way. Controlled: renders the current `FeedFilters`, calls `onChange` with the
 * next set; the feed screen owns persistence (local-first + server sync). Encodes include-unknown by
 * framing gates as "at least" floors (a report that omits the attribute still passes, server-side).
 */

const IDEAL_ICE_TYPES: IceType[] = ['black_ice'];
const IDEAL_SURFACE_TAGS: SurfaceTag[] = ['glass', 'smooth'];
const ICE_LABELS: Record<string, string> = {
  black_ice: 'Black ice',
  glass: 'Glass',
  smooth: 'Smooth',
};

export function FeedFilterBar({
  filters,
  onChange,
}: {
  filters: FeedFilters;
  onChange: (next: FeedFilters) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const count = activeFilterCount(filters);

  /** Immutably set (or, when `value` is undefined, delete) one filter key. */
  function patch<K extends keyof FeedFilters>(key: K, value: FeedFilters[K] | undefined) {
    const next = { ...filters };
    if (value === undefined) delete next[key];
    else next[key] = value;
    onChange(next);
  }

  const thicknessInches =
    filters.thicknessFloorCm !== undefined
      ? String(roundTo(cmToInches(filters.thicknessFloorCm), 1))
      : '';

  return (
    <YStack
      gap="$2"
      padding="$3"
      borderWidth={1}
      borderColor="$border"
      borderRadius="$4"
      backgroundColor="$surface"
    >
      <XStack justifyContent="space-between" alignItems="center">
        <Button chromeless size="$2" onPress={() => setExpanded((e) => !e)} paddingHorizontal="$1">
          <Text
            color="$foregroundMuted"
            fontSize={11}
            letterSpacing={1.5}
            textTransform="uppercase"
          >
            {`Filters${count > 0 ? ` (${count})` : ''} ${expanded ? '▾' : '▸'}`}
          </Text>
        </Button>
        {count > 0 ? (
          <Button chromeless size="$2" onPress={() => onChange({})}>
            <Text color="$primary" fontSize={13}>
              Clear all
            </Text>
          </Button>
        ) : null}
      </XStack>

      {expanded ? (
        <YStack gap="$3">
          <Segmented
            label="Drive time"
            options={[
              { value: undefined, label: 'Any' },
              ...DRIVE_TIME_BANDS.map((m) => ({ value: m, label: `${m}m` })),
            ]}
            selected={filters.radiusMinutes}
            onSelect={(v) => patch('radiusMinutes', v as FeedFilters['radiusMinutes'])}
          />
          <Segmented
            label="Quality"
            options={[
              { value: undefined, label: 'Any' },
              { value: 'good', label: 'Good+' },
              { value: 'great', label: 'Great' },
            ]}
            selected={filters.qualityFloor}
            onSelect={(v) => patch('qualityFloor', v as SkateQuality | undefined)}
          />
          <Segmented
            label="Recency"
            options={[
              { value: undefined, label: 'Any' },
              { value: 24, label: '24h' },
              { value: 48, label: '48h' },
              { value: 168, label: '7d' },
            ]}
            selected={filters.recencyHours}
            onSelect={(v) => patch('recencyHours', v as number | undefined)}
          />

          <XStack gap="$2" alignItems="center">
            <Text color="$foregroundMuted" fontSize={13} width={90}>
              Min ice (in)
            </Text>
            <Input
              flex={1}
              size="$3"
              keyboardType="decimal-pad"
              value={thicknessInches}
              onChangeText={(raw) => {
                const inches = Number(raw.trim());
                patch(
                  'thicknessFloorCm',
                  raw.trim() !== '' && Number.isFinite(inches) && inches >= 0
                    ? roundTo(inchesToCm(inches), 2)
                    : undefined,
                );
              }}
            />
          </XStack>

          <XStack gap="$2" alignItems="center" justifyContent="space-between">
            <Text color="$foreground" fontSize={14}>
              No snow cover
            </Text>
            <Chip
              label={filters.noSnow ? 'On' : 'Off'}
              active={filters.noSnow ?? false}
              onPress={() => patch('noSnow', filters.noSnow ? undefined : true)}
            />
          </XStack>

          <YStack gap="$1">
            <Text color="$foregroundMuted" fontSize={13}>
              Ideal ice
            </Text>
            <XStack gap="$2" flexWrap="wrap">
              {[...IDEAL_ICE_TYPES, ...IDEAL_SURFACE_TAGS].map((value) => {
                const isIce = (IDEAL_ICE_TYPES as string[]).includes(value);
                const key = isIce ? 'iceTypes' : 'surfaceTags';
                const current = (filters[key] ?? []) as string[];
                const active = current.includes(value);
                return (
                  <Chip
                    key={value}
                    label={ICE_LABELS[value] ?? value}
                    active={active}
                    onPress={() => {
                      const next = active
                        ? current.filter((v) => v !== value)
                        : [...current, value];
                      patch(key, (next.length > 0 ? next : undefined) as never);
                    }}
                  />
                );
              })}
            </XStack>
          </YStack>
        </YStack>
      ) : null}
    </YStack>
  );
}

/** A labelled segmented control: a row of chips where the selected value is filled. */
function Segmented<T>({
  label,
  options,
  selected,
  onSelect,
}: {
  label: string;
  options: { value: T; label: string }[];
  selected: T;
  onSelect: (value: T) => void;
}) {
  return (
    <YStack gap="$1">
      <Text color="$foregroundMuted" fontSize={13}>
        {label}
      </Text>
      <XStack gap="$2" flexWrap="wrap">
        {options.map((o) => (
          <Chip
            key={o.label}
            label={o.label}
            active={selected === o.value}
            onPress={() => onSelect(o.value)}
          />
        ))}
      </XStack>
    </YStack>
  );
}

/** A single on/off chip button. */
function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Button
      size="$2"
      backgroundColor={active ? '$primary' : undefined}
      color={active ? '$primaryForeground' : undefined}
      chromeless={!active}
      borderWidth={1}
      borderColor={active ? '$primary' : '$border'}
      onPress={onPress}
    >
      {label}
    </Button>
  );
}
