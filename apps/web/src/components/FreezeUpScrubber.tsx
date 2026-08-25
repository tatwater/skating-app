/**
 * The freeze-up scrubber (N6e §C4) — discrete stops, because that is what the archive is.
 *
 * ## Why this is a stepper and not a slider
 *
 * A continuous track implies continuous observation. The archive is **2–4 usable optical frames a
 * month** over a Northeast winter, so a smooth control would let a skater drag through ground truth
 * that does not exist and read the interpolation as data. One mark per real pass says the true thing
 * about the sampling before anyone reads a single date.
 *
 * ## Blocked stops stay drawn, and that is the whole design
 *
 * > **Founder, 2026-08-23:** *"it might be weird to go to one lake and be able to slide the slider to
 * > one date, then pop to a different lake and not have that same date marked/available without any
 * > explanation."*
 *
 * Frames this lake was never under are **absent** — a pass over Moosehead is not a date Champlain was
 * ever going to have, and drawing it would suggest something was withheld. Frames that *did* cover
 * the lake but were clouded out or clipped stay visible, disabled, and captioned with the reason. So
 * every mark is about this lake, and every unavailable one explains itself.
 *
 * The thumb refuses to rest on a blocked mark — {@link nearestLandableStop} slides it past — because
 * landing somewhere that renders nothing is the failure the marks exist to prevent.
 *
 * ## Keyboard
 *
 * A roving-tabindex group rather than `role="slider"`. A slider's contract is a continuous value with
 * min/max/step, and half these positions cannot be landed on — arrow keys therefore move between
 * *landable* stops, which is the honest model and the one that does not lie to a screen reader.
 */

import type { SeasonIndex } from '@skating/core';
import {
  type BodyTimeline,
  bandsIn,
  frameSourceLabel,
  nearestLandableStop,
  stopCaption,
  type TimelineStop,
} from '@skating/core';
import { Loader2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group';

/** Turn a season label into something a person says. `winter-2025-26` → `winter 2025–26`. */
function seasonLabel(season: string): string {
  const match = /^winter-(\d{4})-(\d{2})$/.exec(season);
  return match ? `winter ${match[1]}–${match[2]}` : season;
}

export function FreezeUpScrubber({
  timeline,
  index,
  band,
  onBandChange,
  selected,
  onSelect,
  loading,
}: {
  timeline: BodyTimeline | null;
  /** The season index, for the bands it actually published — never a hardcoded list. */
  index: SeasonIndex | null;
  band: string;
  onBandChange: (band: string) => void;
  /** Index into `timeline.stops`, or `null` for "nothing chosen yet". */
  selected: number | null;
  onSelect: (index: number) => void;
  loading: boolean;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const stops = useMemo(() => timeline?.stops ?? [], [timeline]);
  const bands = useMemo(() => (index ? bandsIn(index) : []), [index]);

  // Land somewhere real as soon as there is somewhere real to land. Opening on the most recent
  // usable frame rather than the first: a skater asking about a lake is asking about now, and the
  // season runs forward to the present.
  useEffect(() => {
    if (selected !== null || stops.length === 0) return;
    const last = nearestLandableStop(stops, stops.length - 1);
    if (last !== null) onSelect(last);
  }, [selected, stops, onSelect]);

  const move = useCallback(
    (from: number, direction: 1 | -1) => {
      for (let i = from + direction; i >= 0 && i < stops.length; i += direction) {
        if (stops[i]?.landable) {
          onSelect(i);
          refs.current[i]?.focus();
          return;
        }
      }
    },
    [stops, onSelect],
  );

  if (!timeline || stops.length === 0) {
    return (
      <div className="text-muted-foreground text-sm">
        {loading ? (
          <span className="flex items-center gap-1.5">
            <Loader2 aria-hidden className="size-3.5 animate-spin" />
            Loading the freeze-up timeline…
          </span>
        ) : (
          // Not an error, and phrased so it does not read as one: most of the corpus sits under
          // passes that never cut it, and a lake with no frames is an ordinary outcome.
          <span>No satellite passes recorded over this lake{timeline ? ' this season' : ''}.</span>
        )}
      </div>
    );
  }

  const current = selected !== null ? stops[selected] : undefined;
  const caption = current ? stopCaption(current) : null;
  const companionCaption =
    current?.companion && current.companion.frame.capturedAt !== current.frame.capturedAt
      ? stopCaption({ ...current, frame: current.companion.frame })
      : null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <h4 className="font-medium text-sm">Freeze-up timeline</h4>
        <span className="text-muted-foreground text-xs">{seasonLabel(timeline.season)}</span>
      </div>

      {/* The track. `group` rather than `slider` — see the module note on why. */}
      {/* biome-ignore lint/a11y/useSemanticElements: a slider's contract is a continuous value, and half these positions cannot be landed on. */}
      <div
        role="group"
        aria-label={`Satellite passes over this lake, ${seasonLabel(timeline.season)}`}
        className="flex items-end gap-px overflow-x-auto pb-1"
      >
        {stops.map((stop, i) => (
          <StopMark
            key={`${stop.frame.granuleId}:${stop.frame.band}`}
            ref={(el) => {
              refs.current[i] = el;
            }}
            stop={stop}
            selected={i === selected}
            onSelect={() => stop.landable && onSelect(i)}
            onMove={(direction) => move(i, direction)}
          />
        ))}
      </div>

      {/* The date is content, not furniture (D84/C4) — so it renders as text under the track, at the
          same weight as anything else a skater reads, and it changes with the thumb. */}
      {caption ? (
        <p aria-live="polite" className="text-sm">
          <span className="font-medium">{caption.date}</span>
          {/* ⚠ A seam's second date is named at the same weight as the first, never as a footnote.
              Both halves are on screen; presenting one date would put a single day's label over
              ground observed twice — the inference the seam exists to prevent. */}
          {companionCaption ? (
            <span className="font-medium"> + {companionCaption.date}</span>
          ) : null}
          <span className="text-muted-foreground"> · {caption.source}</span>
          {caption.caveat ? (
            <span className="text-muted-foreground"> · {caption.caveat}</span>
          ) : null}
        </p>
      ) : null}
      {companionCaption ? (
        <p className="text-muted-foreground text-xs">
          Two passes, joined — this lake sits across a granule edge, so each half was photographed
          on its own date.
        </p>
      ) : null}

      {bands.length > 1 ? (
        // Base UI (not Radix): `value` is always an array and single-select is the default. An empty
        // array is a deselect, which is ignored here — some band is always showing, and a scrubber
        // with no band selected would render a picture nobody asked for.
        <ToggleGroup
          value={[band]}
          onValueChange={(next) => {
            const chosen = (next as string[])[0];
            if (chosen) onBandChange(chosen);
          }}
          aria-label="Which measurement to show"
          className="self-start"
          variant="outline"
          size="sm"
        >
          {bands.map((option) => (
            <ToggleGroupItem key={option} value={option} className="text-xs">
              {frameSourceLabel(option)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      ) : null}

      {/* How much of this is a guess. Only shown when it is some of it — a count of zero is noise, and
          a reader who never sees this line should not have to learn what it would have meant. */}
      {timeline.coverageInferred + timeline.coverageUnknown > 0 ? (
        <p className="text-muted-foreground text-xs">
          {timeline.coverageInferred + timeline.coverageUnknown} of {stops.length} passes not yet
          confirmed against this lake.
        </p>
      ) : null}
    </div>
  );
}

/** One pass. A button rather than a tick, because a landable one is genuinely activatable. */
function StopMark({
  ref,
  stop,
  selected,
  onSelect,
  onMove,
}: {
  ref: (el: HTMLButtonElement | null) => void;
  stop: TimelineStop;
  selected: boolean;
  onSelect: () => void;
  onMove: (direction: 1 | -1) => void;
}) {
  const caption = stopCaption(stop);
  // The accessible name carries the reason, so a screen-reader user gets the same explanation the
  // sighted one gets from a disabled-looking mark — the point of drawing blocked stops at all.
  const label = [caption.date, caption.source, caption.caveat].filter(Boolean).join(' — ');

  return (
    <button
      ref={ref}
      type="button"
      // Roving tabindex: one stop in the track is reachable by Tab, the rest by arrow keys.
      tabIndex={selected ? 0 : -1}
      aria-current={selected ? 'true' : undefined}
      aria-disabled={!stop.landable}
      title={label}
      aria-label={label}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'ArrowRight') {
          event.preventDefault();
          onMove(1);
        } else if (event.key === 'ArrowLeft') {
          event.preventDefault();
          onMove(-1);
        }
      }}
      className={[
        'h-6 w-2 shrink-0 rounded-sm transition-colors',
        stop.landable
          ? selected
            ? 'bg-primary'
            : 'bg-primary/40 hover:bg-primary/70'
          : // Blocked: drawn, obviously inert, and not mistakable for a landable one.
            'h-3 cursor-not-allowed bg-muted-foreground/25',
      ].join(' ')}
    />
  );
}
