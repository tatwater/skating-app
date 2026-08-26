import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faCircleNotch,
  faLayerGroup,
  faTriangleExclamation,
  faXmark,
} from '@fortawesome/sharp-light-svg-icons';
import type { ReactNode } from 'react';
import { cn } from '../lib/utils';
import { Button } from './ui/button';

/**
 * The map's one imagery control (N6e / D146, D81's surviving one-toggle rule).
 *
 * **Present only where a single lake is selected and the map is visible** — the founder's call, and
 * the reason there is no control on the browse map and no settings row anywhere. Imagery is content
 * scoped to a body, so its switch lives where the body does.
 *
 * ## The button *is* the panel
 *
 * > **Founder, 2026-08-25:** *"tapping/clicking 'Show imagery' [should] make the button grow/
 * > transition into the timeline scrubber container, with an X in the upper right to turn off
 * > imagery and collapse the timeline back into the button."*
 *
 * So the toggle sits where the scrubber sits — bottom-left, over the map — and opening imagery grows
 * that same box into the scrubber rather than lighting up a second surface somewhere else. It makes
 * the spatial claim the feature actually makes: this control and this timeline are one thing, and
 * the timeline is what "imagery on" *means*.
 *
 * There is no third state. The X turns imagery off **and** collapses, because a collapsed box next
 * to imagery still on the map would be a control whose label contradicts the screen.
 *
 * The capture date and the hazard toggle moved inside the grown box for the same reason they were
 * ever grouped with the toggle: they are questions that only exist once there is a photograph to
 * ask them about. Showing them beside an off switch would be controls for a decision nobody has.
 */
export function ImageryControl({
  visible,
  imageryOn,
  onToggleImagery,
  hazardsOn,
  onToggleHazards,
  heading,
  seasonLabel,
  loading,
  hasHazards,
  children,
}: {
  visible: boolean;
  imageryOn: boolean;
  onToggleImagery: (on: boolean) => void;
  hazardsOn: boolean;
  onToggleHazards: (on: boolean) => void;
  /**
   * *"Freeze-up timeline"* — or `null` where there is no timeline to head, which is an archive that
   * was never configured. The panel still exists there; it is a toggle for the aerial and nothing
   * more, and a heading over an empty box would promise a control that is not coming.
   */
  heading: string | null;
  /**
   * **What season is on this lake**, from whichever picture is actually drawn over it: the archive's
   * `winter 2025–26`, or the aerial's `summer 2023 · latest aerial available`. One slot, because a
   * reader looking at a photograph asks one question about it — see the note on the heading row.
   */
  seasonLabel: string | null;
  /** A fetch is in flight — a first load, or a sharper one on zoom-in. Fills the season slot. */
  loading: boolean;
  /** No hazards on this lake ⇒ no hazard toggle. A switch that governs nothing is noise. */
  hasHazards: boolean;
  /** The scrubber. Passed in, because the box it grows into is *its* container. */
  children?: ReactNode;
}) {
  if (!visible) return null;

  return (
    // ⚠ **Bottom-left, which is where the scrubber already was** — not the top-right corner this
    // control used to occupy. It keeps clear of MapLibre's `NavigationControl` (top-right) and of the
    // attribution ⓘ (bottom-right), which carries the ODbL obligation and must stay reachable.
    //
    // The width is the animated part: both ends are explicit lengths, because `auto` does not
    // transition and a box that snaps to size is not a box that grew.
    <div
      className={cn(
        'absolute bottom-4 left-4 z-10 overflow-hidden rounded-md bg-background/95 shadow-lg transition-[width] duration-300 ease-out',
        imageryOn ? 'w-[min(28rem,calc(100vw-2rem))]' : 'w-[10.5rem]',
      )}
    >
      <Collapse open={!imageryOn}>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="w-full"
          aria-expanded={imageryOn}
          onClick={() => onToggleImagery(true)}
        >
          <FontAwesomeIcon icon={faLayerGroup} aria-hidden className="mr-1.5 size-4" />
          Show imagery
        </Button>
      </Collapse>

      <Collapse open={imageryOn}>
        <div className="flex flex-col gap-2 p-3">
          {/*
           * ## One heading row: what this is, what season it is, and the way out
           *
           * > **Founder, 2026-08-26:** *"what if we combine that conditional top line / the close X
           * > with the line directly under it… when it's showing summer imagery it can say
           * > 'Freeze-up timeline … summer 2023 • latest aerial available … [X]', and when it's
           * > showing winter imagery 'Freeze-up timeline … winter 2025–26 … [X]'."*
           *
           * This was two rows: an aerial date above, the scrubber's own title and season below. They
           * were never two facts. **The right-hand slot answers one question — what season is on this
           * lake — and fills it from whichever picture is actually drawn over it**, which is why the
           * aerial had to learn to say `summer 2023` (see `formatAerialSeason`). Two rows made the
           * top one look like a caption for the picture below it, which is how a June date came to
           * sit over a photograph taken in December.
           *
           * The date is still content rather than furniture (D84/D147): NAIP flies mid-summer on a
           * 2–3 year cycle, and a skater reading green trees in January has to be told why. It is
           * just told once, in the place the question is asked, rather than twice in two grammars.
           *
           * ⚠ The heading is the *scrubber's* title, hoisted up here — the scrubber cannot own this
           * row, because the X on it has to exist even where the scrubber does not.
           */}
          <div className="flex items-start justify-between gap-2">
            {heading ? <h4 className="font-medium text-sm">{heading}</h4> : <span />}

            <div className="flex min-w-0 items-start gap-1">
              {loading ? (
                <p className="flex items-center gap-1.5 pt-0.5 text-muted-foreground text-xs">
                  <FontAwesomeIcon
                    icon={faCircleNotch}
                    aria-hidden
                    className="size-3 animate-spin"
                  />
                  Loading imagery…
                </p>
              ) : seasonLabel ? (
                // `text-right`, because on a narrow panel this is the part that wraps — and a season
                // that wraps away from the X reads as a stray line rather than as the heading's tail.
                <p className="pt-0.5 text-right text-muted-foreground text-xs">{seasonLabel}</p>
              ) : null}

              {/* It does the whole job: off *and* closed. `-my-1 -mr-1` pulls it into the padding so
                  the glyph optically sits in the corner rather than inset from it. */}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="-my-1 -mr-1 size-7 shrink-0"
                aria-label="Turn off imagery"
                onClick={() => onToggleImagery(false)}
              >
                <FontAwesomeIcon icon={faXmark} aria-hidden className="size-4" />
              </Button>
            </div>
          </div>

          {/* Announced, not only animated. The lake's own pulse is the ambient signal; this is the one
              a screen reader gets, which is why the status lives here and not just on the canvas. */}
          <p aria-live="polite" className="sr-only">
            {loading ? 'Loading aerial imagery' : ''}
          </p>

          {children}

          {hasHazards ? (
            <label className="flex cursor-pointer items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={hazardsOn}
                onChange={(event) => onToggleHazards(event.target.checked)}
                className="size-3.5 accent-[var(--destructive)]"
              />
              <FontAwesomeIcon
                icon={faTriangleExclamation}
                aria-hidden
                className="size-3.5 text-destructive"
              />
              Hazards
            </label>
          ) : null}
        </div>
      </Collapse>
    </div>
  );
}

/**
 * Height-animated in both directions, via `grid-template-rows: 0fr → 1fr`.
 *
 * The alternative is measuring the panel and animating a pixel height, which the scrubber makes
 * unworkable: its caption reflows as the thumb moves, so a measured height would be stale the moment
 * anyone used it. `0fr → 1fr` animates to whatever the content is *now*.
 *
 * ⚠ **`inert`, not just `opacity-0`.** A collapsed row is zero pixels tall but still in the document,
 * so without it Tab lands on a button nobody can see — and on the scrubber's roving tabindex, the
 * hidden half of the control would answer arrow keys.
 */
function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div
      inert={!open}
      className={cn(
        'grid transition-[grid-template-rows,opacity] duration-300 ease-out',
        open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
      )}
    >
      <div className="overflow-hidden">{children}</div>
    </div>
  );
}
