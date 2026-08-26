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
 * ## There is a real thumb, and it is why the marks are hairlines
 *
 * A drawn handle that travels the track and locks onto each notch, rather than a mark that changes
 * color where the selection is. It is the difference between a control that reports a value and one
 * that is being *held* — and it frees the marks to become a 2 px scale with air between them, since
 * nothing has to be aimed at any more. What is still true is that the **whole track** takes the drag;
 * see the thumb's own note for why that is not a contradiction.
 *
 * ## Keyboard
 *
 * A roving-tabindex group rather than `role="slider"`. A slider's contract is a continuous value with
 * min/max/step, and half these positions cannot be landed on — arrow keys therefore move between
 * *landable* stops, which is the honest model and the one that does not lie to a screen reader.
 */

import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCircleNotch } from '@fortawesome/sharp-light-svg-icons';
import type { SeasonIndex } from '@skating/core';
import {
  type BodyTimeline,
  bandsIn,
  crossedNotch,
  formatSeasonLabel,
  frameSourceHint,
  frameSourceLabel,
  type IndexedFrame,
  nearestLandableStop,
  nearestLandableStopToDate,
  notchAtOffset,
  notchFraction,
  stopCaption,
  type TimelineStop,
} from '@skating/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group';

export function FreezeUpScrubber({
  timeline,
  index,
  band,
  onBandChange,
  selected,
  onSelect,
  loading,
  anchorAt = null,
  error = false,
  renderedCompanion = null,
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
  /**
   * Where the skater was, as a **date** — the capture time of whatever they last chose, which
   * survives a band switch that the stop list does not. Optional: an unanchored scrubber opens on
   * the most recent usable pass, which is where a lake opens.
   */
  anchorAt?: string | null;
  /** The archive is configured but unreadable — a fact about the archive, never about the lake. */
  error?: boolean;
  /**
   * The seam half actually on the map, which can outlive the stop that supplied it.
   *
   * Passed in rather than read off the stop because the holding happens where the frames are mounted
   * — and a caption naming a different frame from the one on screen is the D84 failure this whole
   * module is arranged to avoid.
   */
  renderedCompanion?: IndexedFrame | null;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const lastNotch = useRef<number | null>(null);
  const dragDirection = useRef<1 | -1 | 0>(0);
  // State rather than a ref: it governs whether the thumb animates, so a render has to see it.
  const [dragging, setDragging] = useState(false);
  const stops = useMemo(() => timeline?.stops ?? [], [timeline]);
  const bands = useMemo(() => (index ? bandsIn(index) : []), [index]);

  /**
   * ⚠ **An index the current stops do not have is *nothing chosen*, not a choice.**
   *
   * > **Founder, 2026-08-26:** *"when I click the 'Sentinel-1 radar (VH)' button the radar imagery
   * > shows up! But there's no initial thumb telling me which date it corresponds to […] until I
   * > start clicking & dragging on the timeline myself."*
   *
   * Switching bands swaps the stop list underneath the selection: a winter has ~30 optical passes and
   * ~9 radar ones, so an index chosen on true color is very often past the end of radar. The picture
   * was already protected against exactly this — `framesToRender` holds the last good frame through an
   * out-of-range index — but the *thumb and the caption* were not, so the control went blank and
   * stayed blank: `selected` was non-null, which is precisely the condition that made the effect below
   * decline to choose anything.
   *
   * Reading it as unselected fixes it in the render that discovers it, rather than depending on some
   * other component's effect to notice and reset. The stop list also shrinks on its own as manifests
   * sharpen coverage, so this is not only about bands.
   */
  const chosen = selected !== null && selected < stops.length ? selected : null;
  const thumbFraction = chosen === null ? null : notchFraction(chosen, stops.length);

  // Land somewhere real as soon as there is somewhere real to land. Opening on the most recent
  // usable frame rather than the first: a skater asking about a lake is asking about now, and the
  // season runs forward to the present.
  useEffect(() => {
    if (chosen !== null || stops.length === 0) return;
    // ⚠ **The anchor first, and it is a date rather than an index.** Switching bands swaps a ~30-pass
    // optical season for a ~9-pass radar one; carrying the number across means nothing, and landing
    // on "most recent" throws away the part of the winter the skater was reading. The date is what
    // they meant. `nearestLandableStopToDate` returns null when the anchor cannot be honoured, and
    // then this is an ordinary opening: the season runs forward to now, so now is where it starts.
    const anchored = anchorAt ? nearestLandableStopToDate(stops, anchorAt) : null;
    const landing = anchored ?? nearestLandableStop(stops, stops.length - 1);
    if (landing !== null) onSelect(landing);
  }, [chosen, stops, onSelect, anchorAt]);

  // Pointer-drag across the track, matching mobile. `setPointerCapture` is what makes a drag that
  // leaves the element keep working — without it the selection freezes the moment the cursor crosses
  // a notch's edge into the gap, which reads as the control sticking.
  const scrubTo = useCallback(
    (clientX: number) => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect) return;
      const notch = notchAtOffset(clientX - rect.left, rect.width, stops.length);
      if (notch === null) return;
      // Snap to the nearest notch including a blocked one — skipping ahead to the nearest landable
      // stop would outrun the cursor and hide that a date exists and is unusable.
      lastNotch.current = notch;
      onSelect(notch);
    },
    [stops.length, onSelect],
  );

  // ⚠ **Releasing on a clouded date slides to one with a picture**, in the direction the cursor was
  // travelling. Leaving the thumb parked on a blocked notch would leave the caption and the image
  // disagreeing at rest — and snapping *back* to the last good date would send the skater somewhere
  // they had already scrubbed past, which is counter to what the drag was for.
  const settle = useCallback(() => {
    setDragging(false);
    // ⚠ **Read before it is cleared.** Resetting the ref first and then passing it made every
    // release resolve with `direction: 0` — the tie-break this argument exists for never engaged,
    // and a drag that stalled between two usable dates could settle backwards. Mobile's `settle`
    // has always captured it first; this is the same shape.
    const direction = dragDirection.current;
    dragDirection.current = 0;
    if (chosen === null || stops[chosen]?.landable !== false) return;
    const landable = nearestLandableStop(stops, chosen, direction);
    if (landable !== null) onSelect(landable);
  }, [chosen, stops, onSelect]);

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

  if (loading) {
    return (
      <div className="flex items-center gap-1.5 text-muted-foreground text-sm">
        <FontAwesomeIcon icon={faCircleNotch} aria-hidden className="size-3.5 animate-spin" />
        Loading the freeze-up timeline…
      </div>
    );
  }

  // ⚠ **No timeline is not the same claim as no passes, and saying the second is a lie.**
  //
  // `timeline` is null whenever the season index has not arrived — an unconfigured archive, a fetch
  // that failed, a read still in flight — and none of those is knowledge about this lake. Rendering
  // "no satellite passes recorded" there tells a skater something false about Lake Champlain on the
  // strength of a missing environment variable.
  //
  // So: nothing at all until we have an index. Only once we do can an empty stop list mean what it
  // says, which for most of the corpus it genuinely will.
  if (!timeline) {
    // Configured and unreadable. Worth saying, because the alternative is an empty box that looks
    // like a rendering bug — but phrased strictly about the archive: a bad URL, a bucket without
    // CORS and a dropped network all land here, and none of them is news about this water.
    return error ? (
      <div className="text-muted-foreground text-sm">
        The freeze-up archive could not be reached.
      </div>
    ) : null;
  }

  if (stops.length === 0) {
    return (
      <div className="text-muted-foreground text-sm">
        {/* Not an error, and phrased so it does not read as one: most of the corpus sits under passes
            that never cut it, and a lake with no frames is an ordinary outcome. */}
        No satellite passes recorded over this lake this season.
      </div>
    );
  }

  const current = chosen !== null ? stops[chosen] : undefined;
  const caption = current ? stopCaption(current) : null;
  // ⚠ **Captions what is on the map, not what this stop declares.** A held companion outlives the
  // stop that supplied it (see `framesToRender`), so reading `current.companion` would leave half the
  // lake showing a date the caption never named.
  const shownCompanion = renderedCompanion ?? current?.companion?.frame ?? null;
  // ⚠ **Built from the companion's own frame and nothing else.** Spreading the primary stop in
  // carried the *primary's* `stats` across, so the companion's caveat would have reported the
  // primary's cloud and coverage figures over the companion's date — a measurement attributed to a
  // pass that did not make it. Only the date is read today; the trap is that nothing said so.
  const companionCaptionRaw = shownCompanion
    ? stopCaption({ frame: shownCompanion, landable: true, basis: 'unknown' })
    : null;
  // ⚠ Compared as **rendered labels**, not as instants. Two granules from one pass are seconds apart,
  // so an instant comparison called them different and rendered "Dec 12, 2025 + Dec 12, 2025" — which
  // is what a device showed on Quabbin. The question is whether a reader sees two dates, and that is
  // a question about the strings.
  const companionCaption =
    companionCaptionRaw && caption && companionCaptionRaw.date !== caption.date
      ? companionCaptionRaw
      : null;

  return (
    // ⚠ **No heading here.** The title and the season live one level up, in the panel's heading row,
    // sharing it with the close button — see `ImageryControl`. They had to move together: that row's
    // season slot is filled by the aerial when no frame is on this lake, and this component does not
    // know the aerial exists. Its accessible name still carries the season, because a screen reader
    // reaching the track has not necessarily read the heading.
    <div className="flex flex-col gap-2">
      {/* The track. `group` rather than `slider` — see the module note on why. */}
      {/* biome-ignore lint/a11y/useSemanticElements: a slider's contract is a continuous value, and half these positions cannot be landed on. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the keyboard path is the buttons inside, which is the accessible model — see the module note on why this is not a slider. */}
      <div
        ref={trackRef}
        role="group"
        aria-label={`Satellite passes over this lake, ${formatSeasonLabel(timeline.season)}`}
        // ⚠ No `overflow-x-auto`: the whole season fits, because a track you drag across has no
        // meaning without both ends visible. A dense winter packs tighter instead of scrolling.
        // The height is the thumb's, not the marks'. See the geometry note on the thumb: the handle
        // has to stand 4 px clear of the tallest mark at both ends, and 36 = 4 + 2 + 24 + 2 + 4.
        className="relative flex h-9 touch-none items-end pb-1.5"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          lastNotch.current = null;
          setDragging(true);
          scrubTo(event.clientX);
        }}
        onPointerMove={(event) => {
          if (event.buttons === 0) return;
          const rect = trackRef.current?.getBoundingClientRect();
          const next = rect
            ? notchAtOffset(event.clientX - rect.left, rect.width, stops.length)
            : null;
          if (crossedNotch(lastNotch.current, next)) {
            dragDirection.current = (next ?? 0) > (lastNotch.current ?? 0) ? 1 : -1;
            scrubTo(event.clientX);
          }
        }}
        onPointerUp={settle}
        onPointerCancel={settle}
      >
        {stops.map((stop, i) => (
          <StopMark
            key={`${stop.frame.granuleId}:${stop.frame.band}`}
            ref={(el) => {
              refs.current[i] = el;
            }}
            stop={stop}
            selected={i === chosen}
            onSelect={() => stop.landable && onSelect(i)}
            onMove={(direction) => move(i, direction)}
          />
        ))}

        {/*
         * The thumb — **the thing being dragged**, and the reason the marks below it got thinner.
         *
         * > **Founder, 2026-08-26:** *"I'd love for this to feel more physical, like the user is
         * > really dragging something. Then the notches themselves can become thinner, with more
         * > space in-between, because they're not touch targets, the thumb is."*
         *
         * ⚠ **And yet the whole track stays the drag surface**, which is the part that looks like a
         * contradiction and is not. A handle you must *hit* to use is a 12 px target on a control
         * that already packs sixty dates into a phone's width. The handle is what tells you the
         * control is grabbable; the track is what makes it forgiving. Pressing anywhere jumps the
         * thumb there and the drag continues from under the finger, so the two readings agree.
         *
         * `pointer-events-none` is what keeps that true — without it the handle swallows the
         * `pointerdown` that the track's `setPointerCapture` depends on, and a drag begun on the
         * thumb itself, the most natural gesture there is, would be the one that did not work.
         *
         * ## ⚠ Hollow, and that is a legibility requirement rather than a style
         *
         * > **Founder, 2026-08-26:** *"if you could see through it, then you could understand what
         * > the notch you're covering is (short & gray vs tall & blue) to know whether you're ON the
         * > date of the image you see vs in-between dates, without having to remember."*
         *
         * A solid handle hides the one mark whose state the skater most needs — the one it is
         * standing on. Everywhere else on the track a tall blue tick means *there is a picture here*
         * and a short grey one means *this date is clouded out*; under a filled thumb that reading
         * goes dark exactly where the answer matters, and the only recourse is to remember what was
         * there before the thumb arrived. So the fill comes out and the mark shows through the
         * window: full height means the frame on the map is this date, a stub at the bottom means the
         * thumb is passing over a date that has none.
         *
         * Which is also why the marks are **not** re-colored by selection. The tick inside the
         * window has to mean precisely what the same tick means anywhere else on the track, or the
         * comparison the window exists to allow is a comparison between two different encodings.
         */}
        {thumbFraction !== null ? (
          <div
            aria-hidden
            data-testid="scrubber-thumb"
            className={[
              // ⚠ **The geometry is the whole design, so it is arithmetic rather than taste.**
              //
              // Vertically the window has to *contain* the tallest mark with room to spare. An
              // outline that meets the tick's ends reads as cramped — the handle looks like it is
              // gripping the mark rather than standing over it — so there is an equal 4 px of clear
              // space at both ends:
              //
              //     track 36 = 4 gap + 2 border + 24 tick + 2 border + 4 gap
              //
              // which is why the thumb is the full height of the track (`bottom-0 h-9`) while the
              // marks sit 6 px up from its floor (`pb-1.5`, plus the mark's own 24).
              //
              // Horizontally the opposite pressure: every pixel of width is a pixel of a neighbour
              // obscured, and a dense winter is 6 px per notch. 12 less two 2 px walls still leaves
              // an 8 px window over a 2 px mark, which is four times what it has to clear.
              //
              // `ring-background` sits *outside* the outline, separating the handle from the marks
              // it is not standing on — without it a dense winter puts a neighbouring tick against
              // the outline and the two merge into one shape.
              'pointer-events-none absolute bottom-0 h-9 w-3 -translate-x-1/2 rounded-full border-2 border-primary shadow-sm ring-2 ring-background',
              // ⚠ Not while dragging. A 120 ms ease between notches reads as weight when the thumb
              // moves on its own — an arrow key, the slide off a blocked date on release — and as
              // *lag* when a finger is already ahead of it. Same animation, opposite meaning, so it
              // is only on when nothing is holding the control.
              dragging ? '' : 'transition-[left] duration-120 ease-out',
            ].join(' ')}
            style={{ left: `${thumbFraction * 100}%` }}
          />
        ) : null}
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
        </p>
      ) : null}

      {/* ⚠ **Always rendered, even when there is nothing to say.** The caveat's length varies with the
          cloud figure, so letting it wrap or vanish changes the panel's height — and the panel sits
          under a cursor that is mid-drag. A control that resizes out from under the finger operating
          it is the one thing a scrubber must never do. */}
      <p className="min-h-4 text-muted-foreground text-xs">{caption?.caveat ?? '\u00a0'}</p>
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

      {/* ⚠ **How to read the band, which the band's own name does not say.** `Sentinel-1 radar (VH)`
          is provenance; "dark is smooth ice — or open water" is the sentence that decides whether
          somebody drives two hours. Rendered whether or not the toggle is — a season with one band
          still leaves a reader looking at a picture they have not been told how to read — and absent
          entirely for a band we have nothing short and true to say about, rather than padded. */}
      {frameSourceHint(band) ? (
        <p className="text-muted-foreground text-xs">{frameSourceHint(band)}</p>
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

/**
 * One pass: a hairline tick, inside a button that is mostly empty space.
 *
 * ⚠ **The button did not get smaller when the mark did.** It still takes an equal share of the track
 * — the drawn tick is 2 px in the middle of it — because it carries the whole keyboard and
 * screen-reader model (roving tabindex, the reason a blocked date is blocked) and because a click has
 * to land where it looks like it landed. Shrinking the element to match the ink would leave a control
 * that only a mouse can drive and only precisely.
 *
 * So "the notches are not touch targets" is about what the eye is asked to aim at, not about what the
 * DOM will accept. The thumb is the affordance; these are the scale it moves along.
 */
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
        // `flex-1` rather than a fixed width: the season fits the box, so the marks divide it.
        'group flex h-6 min-w-0 flex-1 items-end justify-center',
        stop.landable ? '' : 'cursor-not-allowed',
      ].join(' ')}
    >
      <span
        className={[
          'w-0.5 rounded-full transition-colors',
          stop.landable
            ? // ⚠ **No selected state on the tick any more — the thumb is standing on it.** Coloring
              // it too would be the same fact drawn twice, and the half of it the handle covers would
              // read as the handle having a shadow.
              'h-full bg-primary/45 group-hover:bg-primary/80'
            : // Blocked: drawn, obviously inert, and not mistakable for a landable one. Short and
              // grey, which is the distinction doing real work now that neither one is colored by
              // selection — a skater has to be able to see, at a glance, which dates have a picture.
              'h-2.5 bg-muted-foreground/30',
        ].join(' ')}
      />
    </button>
  );
}
