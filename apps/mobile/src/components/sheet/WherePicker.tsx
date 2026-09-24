import {
  COMPASS_SECTORS,
  describeWhere,
  type Sector,
  WHERE_EXTENTS,
  type Where,
  type WhereExtent,
} from '@skating/core';
import { useState } from 'react';
import { Text, XStack, YStack } from 'tamagui';
import { LakeMap } from './LakeMap';
import { SheetChip } from './SheetChip';
import { SheetHint } from './SheetSection';
import type { SheetBody } from './useSheetBody';

/** The whole lake is spelled by absence (D193); the row offers the two qualifiers. */
const EXTENTS = WHERE_EXTENTS.filter((e): e is Exclude<WhereExtent, 'whole'> => e !== 'whole');
const EXTENT_LABELS: Record<Exclude<WhereExtent, 'whole'>, string> = {
  mostly: 'Mostly',
  patches: 'In patches',
};

const SECTOR_LABELS: Record<Sector, string> = {
  N: 'North end',
  NE: 'Northeast',
  E: 'East side',
  SE: 'Southeast',
  S: 'South end',
  SW: 'Southwest',
  W: 'West side',
  NW: 'Northwest',
  middle: 'Middle',
  near_shore: 'Near shore',
  head: 'Back of the bay',
  mouth: 'Mouth of the bay',
};

/** A coarse tap's radius (D193 / A05b): "about here", not a survey. */
const POINT_RADIUS_M = 75;

/**
 * The *where* affordance (A10 / D193) under a selected chip: how much of the lake, which bay, which
 * end, or a point tapped on the silhouette. Composes — "patches, north end of Malletts Bay" is an
 * extent, a bay and a sector at once. The chips choose; the lake shows.
 *
 * Nothing here is required: a chip with no `where` is the whole lake, spelled by absence (D193).
 */
export function WherePicker({
  where,
  body,
  onChange,
}: {
  where: Where | undefined;
  body: SheetBody | null;
  onChange: (where: Where | undefined) => void;
}) {
  const [placing, setPlacing] = useState(false);
  const set = (patch: Partial<Where>) => {
    const next: Where = { ...where, ...patch };
    for (const key of Object.keys(next) as (keyof Where)[]) {
      if (next[key] === undefined) delete next[key];
    }
    onChange(Object.keys(next).length === 0 ? undefined : next);
  };
  const bayNames = Object.fromEntries((body?.bays ?? []).map((b) => [b.id, b.name]));
  const inBay = where?.subAreaId !== undefined;
  const sectors: readonly Sector[] = inBay
    ? [...COMPASS_SECTORS, 'middle', 'near_shore', 'head', 'mouth']
    : [...COMPASS_SECTORS, 'middle', 'near_shore'];
  const words = where ? describeWhere(where, bayNames) : '';

  return (
    <YStack
      gap="$2.5"
      padding="$3"
      borderRadius="$4"
      backgroundColor="$surfaceMuted"
      accessibilityLabel="Where on the lake"
    >
      <XStack gap="$2" flexWrap="wrap">
        {EXTENTS.map((extent) => (
          <SheetChip
            key={extent}
            compact
            label={EXTENT_LABELS[extent]}
            tier={where?.extent === extent ? 'solid' : undefined}
            onPress={() => set({ extent: where?.extent === extent ? undefined : extent })}
          />
        ))}
      </XStack>
      {body && body.bays.length > 0 ? (
        <XStack gap="$2" flexWrap="wrap">
          {body.bays.map((bay) => (
            <SheetChip
              key={bay.id}
              compact
              label={bay.name}
              tier={where?.subAreaId === bay.id ? 'solid' : undefined}
              onPress={() =>
                set({
                  subAreaId: where?.subAreaId === bay.id ? undefined : bay.id,
                  // Head and mouth are the bay's words; they go when the bay does.
                  sector:
                    where?.subAreaId === bay.id &&
                    (where.sector === 'head' || where.sector === 'mouth')
                      ? undefined
                      : where?.sector,
                })
              }
            />
          ))}
        </XStack>
      ) : null}
      <XStack gap="$2" flexWrap="wrap">
        {sectors.map((sector) => (
          <SheetChip
            key={sector}
            compact
            label={SECTOR_LABELS[sector]}
            tier={where?.sector === sector ? 'solid' : undefined}
            onPress={() => set({ sector: where?.sector === sector ? undefined : sector })}
          />
        ))}
        <SheetChip
          compact
          label={where?.point ? 'Point placed' : 'A point'}
          tier={where?.point ? 'solid' : undefined}
          onPress={() => {
            if (where?.point) set({ point: undefined });
            else setPlacing((p) => !p);
          }}
        />
      </XStack>
      {body?.silhouette && (placing || where?.sector || where?.point) ? (
        <YStack gap="$1.5">
          <LakeMap
            data={body.silhouette}
            sector={where?.sector}
            point={
              where?.point
                ? { ...where.point.coord, radiusMeters: where.point.radiusMeters }
                : undefined
            }
            height={150}
            onTap={
              placing
                ? (coord) => {
                    set({ point: { coord, radiusMeters: POINT_RADIUS_M } });
                    setPlacing(false);
                  }
                : undefined
            }
          />
          {placing ? <SheetHint>Tap the water where you mean.</SheetHint> : null}
        </YStack>
      ) : null}
      {words ? (
        <Text color="$foreground" fontSize={12}>
          {words[0]?.toUpperCase()}
          {words.slice(1)}
        </Text>
      ) : null}
    </YStack>
  );
}
