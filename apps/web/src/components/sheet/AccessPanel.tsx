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
import { useMemo, useState } from 'react';
import { Input } from '../ui/input';
import { LakeMap, type LakeMapPin } from './LakeMap';
import { SheetChip } from './SheetChip';
import { SheetHint, SheetPanel, SubLabel } from './SheetPanel';
import type { SectionProps } from './sectionProps';

/** How many known launches the chip row names before the rest are "on the map" only. */
const NAMED_PUT_INS = 4;

/**
 * *Access* (A10 §7 / D197, D198): the put-in and the lot, then what the skater found there.
 *
 * The picker is the lake itself — the known launches drawn on the silhouette with their names, the
 * nearest few as chips too — and a click on a dot chooses it. *Somewhere else* takes a click on the
 * water as a coarse point (the report's `point`, with no `putInId`), which is also how a launch the
 * corpus lacks gets proposed: every such point is a candidate for the moderator.
 *
 * Then the conditions — a plank, a muddy launch, an icy lot — as chips against the chosen put-in or
 * lot, riding A06d's decaying, corroborated alerts with this Report as provenance (D197), and a
 * one-line note. Never blockers: the chips here say what to bring, not that the launch is closed.
 *
 * *Use my location* is not here and should not be: this is a desk, and a browser's fix would place
 * the put-in wherever the author is sitting. The lake is the picker on web.
 */
export function AccessPanel({ report, body, dispatch, gaps, editing, timeZone }: SectionProps) {
  const sheet = report.sheet;
  const { putInId, parkingAreaId, point } = sheet.scalars;
  const [placing, setPlacing] = useState(false);

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
    if (id === undefined) {
      // Un-choosing the launch un-places the pin with it: the point *was* the launch's coordinate,
      // and left behind it would read as *Somewhere else · set* and post as a nameless proposal for
      // a launch the corpus already has.
      const chosen = body?.putIns.find((p) => p.id === putInId)?.coord;
      const atLaunch =
        point !== undefined &&
        chosen !== undefined &&
        point.lat === chosen.lat &&
        point.lng === chosen.lng;
      dispatch({ type: 'setScalar', key: 'putInId', value: undefined });
      if (atLaunch) dispatch({ type: 'setScalar', key: 'point', value: undefined });
      return;
    }
    dispatch({ type: 'setScalar', key: 'putInId', value: id });
    dispatch({
      type: 'setScalar',
      key: 'point',
      value: body?.putIns.find((p) => p.id === id)?.coord,
    });
    setPlacing(false);
  };
  const chooseLot = (id: string | undefined) =>
    dispatch({ type: 'setScalar', key: 'parkingAreaId', value: id });

  const conditions = selectedValues(sheet, 'accessConditions');
  const target = putInId !== undefined || parkingAreaId !== undefined;
  const chosenName =
    putInId !== undefined
      ? body?.putIns.find((p) => p.id === putInId)?.name
      : point !== undefined
        ? 'Somewhere else'
        : undefined;

  return (
    <SheetPanel
      label="Access"
      summary={sectionSummary(sheet, 'access', timeZone)}
      collapsed={sheet.collapsed.access}
      onToggle={() =>
        dispatch({ type: 'setCollapsed', section: 'access', collapsed: !sheet.collapsed.access })
      }
      gap={gaps.has('access')}
    >
      <SubLabel>Where did you get on?</SubLabel>
      <div className="flex flex-wrap gap-2">
        {nearest.slice(0, NAMED_PUT_INS).map((p) => (
          <SheetChip
            key={p.id}
            label={p.name}
            {...(putInId === p.id ? { tier: 'solid' as const } : {})}
            onClick={() => choosePutIn(putInId === p.id ? undefined : p.id)}
          />
        ))}
        <SheetChip
          label={
            putInId === undefined && point !== undefined ? 'Somewhere else · set' : 'Somewhere else'
          }
          {...(putInId === undefined && point !== undefined ? { tier: 'solid' as const } : {})}
          onClick={() => {
            if (putInId === undefined && point !== undefined) {
              dispatch({ type: 'setScalar', key: 'point', value: undefined });
              setPlacing(false);
            } else setPlacing((p) => !p);
          }}
        />
      </div>
      {body?.silhouette ? (
        <div className="flex flex-col gap-1.5">
          <LakeMap
            data={body.silhouette}
            pins={pins}
            {...((putInId ?? parkingAreaId) ? { chosenPinId: putInId ?? parkingAreaId } : {})}
            {...(putInId === undefined && point ? { point } : {})}
            height={260}
            label="The lake. Click a launch, or anywhere on the water."
            onPickPin={(pin) => (pin.kind === 'putIn' ? choosePutIn(pin.id) : chooseLot(pin.id))}
            {...(placing
              ? {
                  onPick: (coord: { lat: number; lng: number }) => {
                    dispatch({ type: 'setScalar', key: 'putInId', value: undefined });
                    dispatch({ type: 'setScalar', key: 'point', value: coord });
                    setPlacing(false);
                  },
                }
              : {})}
          />
          <SheetHint>
            {placing
              ? 'Click the shore where you got on.'
              : chosenName
                ? `Put-in: ${chosenName}.`
                : 'Click a launch on the lake, or choose one above.'}
          </SheetHint>
        </div>
      ) : null}
      {body && body.parking.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <SubLabel>Parked at</SubLabel>
          <div className="flex flex-wrap gap-2">
            {body.parking.map((lot) => (
              <SheetChip
                key={lot.id}
                compact
                label={lot.name}
                {...(parkingAreaId === lot.id ? { tier: 'solid' as const } : {})}
                onClick={() => chooseLot(parkingAreaId === lot.id ? undefined : lot.id)}
              />
            ))}
          </div>
        </div>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <SubLabel>At the launch</SubLabel>
        {editing ? (
          // The chips file alerts when a Post creates (D197, the flush's step 7, with the new Report
          // as provenance); an edit has no such step, so offering them here would take a plank the
          // author clicked and quietly file nothing. The alerts already filed stand on their own.
          <SheetHint>
            Conditions at the launch are filed when a report posts; this edit leaves what was filed
            as it is.
          </SheetHint>
        ) : target ? (
          <>
            <div className="flex flex-wrap gap-2">
              {ACCESS_CONDITION_REASONS.map((reason) => {
                const selected = conditions.includes(reason);
                return (
                  <SheetChip
                    key={reason}
                    label={ACCESS_REASON_LABELS[reason]}
                    {...(selected ? { tier: 'solid' as const } : {})}
                    onClick={() =>
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
            </div>
            {conditions.length > 0 ? (
              <Input
                placeholder="One line for the next skater — where the plank is, where to park"
                aria-label="A line about what you found at the launch"
                value={sheet.scalars.accessNote ?? ''}
                maxLength={160}
                onChange={(e) =>
                  dispatch({ type: 'setScalar', key: 'accessNote', value: e.target.value })
                }
              />
            ) : null}
          </>
        ) : (
          <SheetHint>Pick your put-in or lot to say what you found there.</SheetHint>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex">
          <SheetChip
            label={SHOW_PUT_IN_LABEL}
            {...(sheet.scalars.showPutIn !== false ? { tier: 'solid' as const } : {})}
            onClick={() =>
              dispatch({
                type: 'setScalar',
                key: 'showPutIn',
                value: sheet.scalars.showPutIn === false,
              })
            }
          />
        </div>
        <SheetHint>{SHOW_PUT_IN_EXPLAINER}</SheetHint>
      </div>
    </SheetPanel>
  );
}
