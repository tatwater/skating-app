/**
 * Turning a scrubber's width into notch positions, and a drag into a selection (N6e §C4).
 *
 * ## Why the whole season has to fit
 *
 * > **Founder, 2026-08-25:** *"the entire season's timeline has to fit within the visible bounds of
 * > the timeline box, since the user needs to see both ends in order to scrub with confidence."*
 *
 * Right, and it is the *scrubbing* that forces it rather than the looking. A scrolling track can be
 * read a section at a time; a track you drag across cannot, because the gesture has no meaning
 * without both ends of the range visible. A skater dragging into content that scrolls under their
 * thumb is operating a control whose extent they cannot see.
 *
 * So notches are placed by **fraction of the available width**, and a season with sixty passes packs
 * them tighter rather than growing the track. That is also honest about the sampling: a winter with
 * more passes *should* look denser.
 *
 * ## Snapping, and why nearest-by-position rather than nearest-landable
 *
 * A drag resolves to the notch nearest the thumb — **including a blocked one**. Skipping straight to
 * the nearest landable stop would make the thumb jump ahead of the finger and feel broken, and it
 * would hide the fact that a date exists and is unusable, which is the whole reason blocked stops are
 * drawn. The caller decides what to do on release; this only answers *"which notch is under this x"*.
 */

/** Where one notch sits, as a fraction of the track's width. */
export interface NotchPosition {
  index: number;
  /** 0 at the left edge, 1 at the right. */
  fraction: number;
}

/**
 * Spread `count` notches evenly across a track.
 *
 * ⚠ **Inset by half a step rather than running edge to edge.** A notch centred on x=0 is half
 * outside the box, and — worse for a drag — the first and last notches would each have half the
 * catchment of every other one, so the ends would feel harder to hit than the middle. Half-step
 * insets give every notch the same width of track.
 *
 * A single notch sits in the centre, because there is no range for it to be at one end of.
 */
export function notchPositions(count: number): NotchPosition[] {
  if (count <= 0) return [];
  if (count === 1) return [{ index: 0, fraction: 0.5 }];
  const step = 1 / count;
  return Array.from({ length: count }, (_, index) => ({
    index,
    fraction: step * (index + 0.5),
  }));
}

/**
 * Which notch a drag at `x` is over.
 *
 * Clamped rather than returning null past the ends: a finger that slides off the left of the track is
 * asking for the first frame, not for nothing. Returns `null` only when there is nothing to select.
 */
export function notchAtOffset(x: number, width: number, count: number): number | null {
  if (count <= 0 || width <= 0) return null;
  const index = Math.floor((x / width) * count);
  return Math.min(count - 1, Math.max(0, index));
}

/**
 * Whether a drag has crossed into a new notch — the signal a haptic tick fires on.
 *
 * Trivial, and a function because the alternative is every client re-deriving "did it change" from a
 * previous-value ref and one of them getting it wrong on the first frame, where `previous` is null
 * and a tick would fire before the finger has moved anywhere.
 */
export function crossedNotch(previous: number | null, next: number | null): boolean {
  return next !== null && previous !== null && next !== previous;
}
