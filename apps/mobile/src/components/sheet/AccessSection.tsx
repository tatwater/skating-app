import {
  ACCESS_CONDITION_REASONS,
  ACCESS_REASON_LABELS,
  type AccessConditionReason,
  putInsByDistance,
  SHOW_PUT_IN_EXPLAINER,
  SHOW_PUT_IN_LABEL,
  sectionSummary,
  selectedValues,
} from '@skating/core';
import * as Location from 'expo-location';
import { useMemo, useState } from 'react';
import { Text, XStack, YStack } from 'tamagui';
import { Input } from '../ThemedInputs';
import { LakeMap, type LakeMapPin } from './LakeMap';
import { SheetChip } from './SheetChip';
import { SheetHint, SheetSection, SubLabel } from './SheetSection';
import type { SectionProps } from './sectionProps';

/** How many known launches the chip row names before the rest are "on the map" only. */
const NAMED_PUT_INS = 4;

/**
 * *Access* (A10 §7 / D197, D198): the put-in and the lot, then what the skater found there.
 *
 * The picker is the lake itself — the known launches drawn on the silhouette with their names,
 * the nearest few as chips too — and a tap on a dot chooses it. *Somewhere else* takes a tap on
 * the water as a coarse point (the report's `point`, with no `putInId`), which is also how a
 * launch the corpus lacks gets proposed: every such point is a candidate for the moderator
 * (`putIns.listForBody` already clusters them). *Use my location* is the offline path. A track
 * door snaps its start to a launch inside `PUT_IN_SNAP_METERS` before the sheet opens.
 *
 * Then the conditions — a plank, a muddy launch, an icy lot — as chips against the chosen put-in
 * or lot, riding A06d's decaying, corroborated alerts with this Report as provenance (D197), and a
 * one-line note. Never blockers: the chips here say what to bring, not that the launch is closed.
 */
export function AccessSection({ report, body, dispatch, gaps, timeZone }: SectionProps) {
  const sheet = report.sheet;
  const { putInId, parkingAreaId, point } = sheet.scalars;
  const [placing, setPlacing] = useState(false);
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const from = point ?? body?.frame?.origin;
  const nearest = useMemo(
    () => (body && from ? putInsByDistance(body.putIns, from) : (body?.putIns ?? [])),
    [body, from],
  );
  const pins: LakeMapPin[] = useMemo(
    () => [
      ...(body?.putIns ?? []).map((p) => ({
        id: p.id,
        ...p.coord,
        label: p.name,
        kind: 'putIn' as const,
      })),
      ...(body?.parking ?? []).map((p) => ({
        id: p.id,
        ...p.coord,
        label: p.name,
        kind: 'parking' as const,
      })),
    ],
    [body],
  );
  const choosePutIn = (id: string | undefined) => {
    dispatch({ type: 'setScalar', key: 'putInId', value: id });
    if (id !== undefined) {
      const coord = body?.putIns.find((p) => p.id === id)?.coord;
      dispatch({ type: 'setScalar', key: 'point', value: coord });
      setPlacing(false);
    }
  };
  const chooseLot = (id: string | undefined) =>
    dispatch({ type: 'setScalar', key: 'parkingAreaId', value: id });

  const locateMe = async () => {
    setError(null);
    setLocating(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setError('Location permission is needed to set the put-in from where you are.');
        return;
      }
      const pos = await Location.getCurrentPositionAsync({});
      dispatch({ type: 'setScalar', key: 'putInId', value: undefined });
      dispatch({
        type: 'setScalar',
        key: 'point',
        value: { lat: pos.coords.latitude, lng: pos.coords.longitude },
      });
    } catch {
      setError("Couldn't get your current location.");
    } finally {
      setLocating(false);
    }
  };

  const conditions = selectedValues(sheet, 'accessConditions');
  const target = putInId !== undefined || parkingAreaId !== undefined;
  const chosenName =
    putInId !== undefined
      ? body?.putIns.find((p) => p.id === putInId)?.name
      : point !== undefined
        ? 'Somewhere else'
        : undefined;

  return (
    <SheetSection
      label="Access"
      summary={sectionSummary(sheet, 'access', timeZone)}
      collapsed={sheet.collapsed.access}
      onToggle={() =>
        dispatch({ type: 'setCollapsed', section: 'access', collapsed: !sheet.collapsed.access })
      }
      gap={gaps.has('access')}
    >
      <SubLabel>Where did you get on?</SubLabel>
      <XStack gap="$2" flexWrap="wrap">
        {nearest.slice(0, NAMED_PUT_INS).map((p) => (
          <SheetChip
            key={p.id}
            label={p.name}
            tier={putInId === p.id ? 'solid' : undefined}
            onPress={() => choosePutIn(putInId === p.id ? undefined : p.id)}
          />
        ))}
        <SheetChip
          label={
            putInId === undefined && point !== undefined ? 'Somewhere else · set' : 'Somewhere else'
          }
          tier={putInId === undefined && point !== undefined ? 'solid' : undefined}
          onPress={() => {
            if (putInId === undefined && point !== undefined) {
              dispatch({ type: 'setScalar', key: 'point', value: undefined });
              setPlacing(false);
            } else setPlacing((p) => !p);
          }}
        />
        <SheetChip
          label={locating ? 'Locating…' : 'Use my location'}
          onPress={() => void locateMe()}
        />
      </XStack>
      {body?.silhouette ? (
        <YStack gap="$1.5">
          <LakeMap
            data={body.silhouette}
            pins={pins}
            chosenPinId={putInId ?? parkingAreaId}
            point={putInId === undefined && point ? point : undefined}
            onTapPin={(pin) => (pin.kind === 'putIn' ? choosePutIn(pin.id) : chooseLot(pin.id))}
            onTap={
              placing
                ? (coord) => {
                    dispatch({ type: 'setScalar', key: 'putInId', value: undefined });
                    dispatch({ type: 'setScalar', key: 'point', value: coord });
                    setPlacing(false);
                  }
                : undefined
            }
          />
          <SheetHint>
            {placing
              ? 'Tap the shore where you got on.'
              : chosenName
                ? `Put-in: ${chosenName}.`
                : 'Tap a launch on the lake, or choose one above.'}
          </SheetHint>
        </YStack>
      ) : null}
      {error ? (
        <Text color="$danger" fontSize={12}>
          {error}
        </Text>
      ) : null}
      {body && body.parking.length > 0 ? (
        <YStack gap="$1.5">
          <SubLabel>Parked at</SubLabel>
          <XStack gap="$2" flexWrap="wrap">
            {body.parking.map((lot) => (
              <SheetChip
                key={lot.id}
                compact
                label={lot.name}
                tier={parkingAreaId === lot.id ? 'solid' : undefined}
                onPress={() => chooseLot(parkingAreaId === lot.id ? undefined : lot.id)}
              />
            ))}
          </XStack>
        </YStack>
      ) : null}

      <YStack gap="$1.5">
        <SubLabel>At the launch</SubLabel>
        {target ? (
          <>
            <XStack gap="$2" flexWrap="wrap">
              {ACCESS_CONDITION_REASONS.map((reason) => {
                const selected = conditions.includes(reason);
                return (
                  <SheetChip
                    key={reason}
                    label={ACCESS_REASON_LABELS[reason]}
                    tier={selected ? 'solid' : undefined}
                    onPress={() =>
                      dispatch(
                        selected
                          ? { type: 'deselect', field: 'accessConditions', key: reason }
                          : {
                              type: 'select',
                              field: 'accessConditions',
                              key: reason,
                              value: reason as AccessConditionReason,
                            },
                      )
                    }
                  />
                );
              })}
            </XStack>
            {conditions.length > 0 ? (
              <Input
                placeholder="One line for the next skater — where the plank is, where to park"
                value={sheet.scalars.accessNote ?? ''}
                onChangeText={(text) =>
                  dispatch({ type: 'setScalar', key: 'accessNote', value: text })
                }
                maxLength={160}
              />
            ) : null}
          </>
        ) : (
          <SheetHint>Pick your put-in or lot to say what you found there.</SheetHint>
        )}
      </YStack>

      <YStack gap="$1">
        <XStack>
          <SheetChip
            label={SHOW_PUT_IN_LABEL}
            tier={sheet.scalars.showPutIn !== false ? 'solid' : undefined}
            onPress={() =>
              dispatch({
                type: 'setScalar',
                key: 'showPutIn',
                value: sheet.scalars.showPutIn === false,
              })
            }
          />
        </XStack>
        <SheetHint>{SHOW_PUT_IN_EXPLAINER}</SheetHint>
      </YStack>
    </SheetSection>
  );
}
