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
import { type ComponentProps, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckboxRow } from '@/components/kit/checkbox';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/kit/tooltip';
import { Input } from '@/components/ui/input';
import { useConsoleMode } from './ConsoleMode';
import { SheetChip } from './SheetChip';
import { QuestionBlock, SheetHint, SheetPanel, SubLabel } from './SheetPanel';
import type { SectionProps } from './sectionProps';

/** How many known launches the chip row names before the rest are "on the map" only. */
const NAMED_PUT_INS = 4;

/**
 * *Access* (A10 §7 / D197, D198): the put-in and the lot, then what the skater found there.
 *
 * The picker is the lake itself — the instrument in the center column, put into **put-in mode**
 * while the question block here is open (A10-6 / D206): the known launches light up on the
 * silhouette, a click on a dot chooses it, and *Somewhere else* takes a click on the shore as a
 * coarse point (the report's `point`, with no `putInId`), which is also how a launch the corpus
 * lacks gets proposed: every such point is a candidate for the moderator. The nearest launches are
 * chips beside it, so a keyboard answers the same question.
 *
 * Every chip that names a pin — a launch, a lot, the shore spot — lights it on the instrument while
 * it is hovered or focused (`PinChip`): the pin bracketed and named, the rest stepped back. Lots are
 * often all just "Parking", and the map is the only place one reads as different from the next.
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
  const [asking, setAsking] = useState(false);
  const [placing, setPlacing] = useState(false);
  const { setMode, instrument } = useConsoleMode();
  // A folded section's chips stay mounted (its effects are the sheet's), but point at nothing.
  const pointable = instrument && !sheet.collapsed.access;

  const from = point ?? body?.frame?.origin;
  const nearest = useMemo(
    () => (body && from ? putInsByDistance(body.putIns, from) : (body?.putIns ?? [])),
    [body, from],
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

  // The instrument takes the click while the question is open: a launch chooses it, the shore is
  // *somewhere else*. The handlers close over this render's sheet, so they ride a ref the mode
  // reads through; the mode itself is armed once, when the question opens, and disarmed with it.
  const handlers = useRef({ choosePutIn, chooseLot, dispatch });
  handlers.current = { choosePutIn, chooseLot, dispatch };
  useEffect(() => {
    // A phone has no instrument to take the click (row 9): the chips answer alone.
    if (!asking || !instrument) return;
    setMode({
      kind: 'putIn',
      onPickPin: (id, kind) =>
        kind === 'putIn' ? handlers.current.choosePutIn(id) : handlers.current.chooseLot(id),
      onPickShore: (coord) => {
        handlers.current.dispatch({ type: 'setScalar', key: 'putInId', value: undefined });
        handlers.current.dispatch({ type: 'setScalar', key: 'point', value: coord });
        setPlacing(false);
      },
      onExit: () => setAsking(false),
    });
    return () => setMode(null);
  }, [asking, instrument, setMode]);
  // Without the map, a launch past the first few has nowhere else to be chosen: name them all.
  const named = instrument ? nearest.slice(0, NAMED_PUT_INS) : nearest;
  // *Somewhere else* is a click on the shore. Without the map it can't be placed — only a spot
  // already placed (on a wider screen) is shown, so it can still be taken back.
  const elsewhereSet = putInId === undefined && point !== undefined;

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
      {asking ? (
        <QuestionBlock title="Where did you get on?" onDone={() => setAsking(false)}>
          <div className="flex flex-wrap gap-1.5">
            {named.map((p) => (
              <PinChip
                key={p.id}
                pinId={p.id}
                pointable={pointable}
                compact
                label={p.name}
                {...(putInId === p.id ? { tier: 'solid' as const } : {})}
                onClick={() => choosePutIn(putInId === p.id ? undefined : p.id)}
              />
            ))}
            {instrument || elsewhereSet ? (
              <PinChip
                pinId={elsewhereSet ? 'point' : null}
                pointable={pointable}
                compact
                label={
                  elsewhereSet
                    ? 'Somewhere else · set'
                    : placing
                      ? 'Click the shore…'
                      : 'Somewhere else'
                }
                {...(elsewhereSet || placing ? { tier: 'solid' as const } : {})}
                onClick={() => {
                  if (elsewhereSet) {
                    dispatch({ type: 'setScalar', key: 'point', value: undefined });
                    setPlacing(false);
                  } else setPlacing((p) => !p);
                }}
              />
            ) : null}
          </div>
          {instrument ? null : (
            <SheetHint>
              A spot on the shore that isn’t a launch is placed on the map, on a wider screen.
            </SheetHint>
          )}
        </QuestionBlock>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          <SubLabel>Where did you get on?</SubLabel>
          <SheetChip
            compact
            label={chosenName ?? (instrument ? 'Choose on the lake' : 'Choose a launch')}
            {...(chosenName !== undefined ? { tier: 'solid' as const } : {})}
            onClick={() => setAsking(true)}
          />
        </div>
      )}
      {body && body.parking.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <SubLabel>Where did you park?</SubLabel>
          <div className="flex flex-wrap gap-1.5">
            {body.parking.map((lot) => (
              <PinChip
                key={lot.id}
                pinId={lot.id}
                pointable={pointable}
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
        {/* The chips file alerts when a Post creates (D197, the flush's step 7, with the new Report
          as provenance); an edit has no such step, so offering them here would take a plank the
          author clicked and quietly file nothing. The alerts already filed stand on their own. */}
        <SubLabel
          {...(editing
            ? {
                tip: 'Conditions at the launch are filed when a report posts; an edit leaves what was filed as it is.',
              }
            : {})}
        >
          What did you find there?
        </SubLabel>
        {editing ? null : target ? (
          <>
            <div className="flex flex-wrap gap-1.5">
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

      {/* A checkbox, not a chip: a filled chip reads as primary and an empty one as secondary, never
        as on and off (founder, 2026-11-07). What it does is the tip on the whole row. */}
      <Tooltip>
        <TooltipTrigger render={<div data-slot="show-put-in" className="flex w-fit" />}>
          <CheckboxRow
            label={
              <span className="w-fit border-0 border-b border-dotted border-fg3 pb-px leading-[1.1]">
                {SHOW_PUT_IN_LABEL}
              </span>
            }
            checked={sheet.scalars.showPutIn !== false}
            onCheckedChange={(checked) =>
              dispatch({ type: 'setScalar', key: 'showPutIn', value: checked })
            }
            data-attr="sheet-show-put-in"
          />
        </TooltipTrigger>
        <TooltipContent>{SHOW_PUT_IN_EXPLAINER}</TooltipContent>
      </Tooltip>
    </SheetPanel>
  );
}

/**
 * A chip naming a pin on the instrument (`pinId`, or `null` when it names none yet). While it is
 * hovered or focused the instrument lights that pin; it lets go when the pointer or focus leaves,
 * when it stops being `pointable` (the section folds, the window narrows to a phone, which has no
 * instrument to light), and when it unmounts (its question closes) — and it only ever clears its
 * own pin, never one a neighbor has since taken.
 */
function PinChip({
  pinId,
  pointable,
  ...chip
}: Omit<ComponentProps<typeof SheetChip>, 'onPoint'> & {
  pinId: string | null;
  pointable: boolean;
}) {
  const { setHighlightPinId } = useConsoleMode();
  const release = useCallback(() => {
    if (pinId !== null) setHighlightPinId((cur) => (cur === pinId ? null : cur));
  }, [pinId, setHighlightPinId]);
  useEffect(() => {
    if (!pointable) release();
    return release;
  }, [pointable, release]);
  return (
    <SheetChip
      {...chip}
      {...(pointable && pinId !== null
        ? { onPoint: (on: boolean) => (on ? setHighlightPinId(pinId) : release()) }
        : {})}
    />
  );
}
