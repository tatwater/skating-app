import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faMinus, faPlus } from '@fortawesome/sharp-regular-svg-icons';
import * as tokens from '@skating/design/tokens';
import {
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { cn } from '@/lib/utils';

import { Button } from './button';
import { ButtonGroup } from './button-group';
import { Kbd } from './kbd';
import { Plate } from './plate';

/**
 * The kit's map controls: the chrome that docks on a map pane. Custom — pure DOM and SVG, no map
 * library: a pane positions these over whatever draws the map (MapLibre in the app, a still in a
 * story), and feeds them numbers (the zoom's meters per pixel, a hovered mark's point).
 *
 * - **`MapPane`** — the positioned, clipped frame the pieces dock in.
 * - **`MapLayerRack`** — the layer menu (`.layers`): a column of kit `SwitchRow`s on their plates,
 *   top left, a hair apart. It drops below the mode bar when one is up. **Collapsed** it keeps the
 *   switches only; a row's name and key come back while it's hovered or focused.
 * - **`MapModeBar`** — a transient mode (bay, measure, compare) as an ice band across the top: the
 *   mode's name as an ice kicker, what to do next, the step, and Esc's cap to leave. Ice because it
 *   is a transient mode — the one place ice marks chrome on a map.
 * - **`MapDock`** — the bottom-right corner, `space-14` (56 px on the console) up from the pane's
 *   foot, so the longitude labels run the map's full width under it: the scale bar, then the zoom
 *   pair, bottom-aligned, `space-3` apart.
 * - **`MapZoom`** — the zoom pair: two small kit icon buttons joined by a kit `ButtonGroup` (one
 *   shared hairline, so it is 2 × `btn-sm` − 1 px tall), on the map plate. No tooltips: the boards
 *   draw none, and the glyphs say it.
 * - **`MapScaleBar`** — on the map, never in the foot's key: the longest round distance that fits,
 *   in the app's units (stored metric, shown imperial: 1, 2 or 5 × 10ⁿ feet to 500 ft, then miles
 *   from a tenth), as a hairline bracket with its mono label over it. The label's words are the
 *   caller's formatter (`format`) — the console's one distance formatter, never a second here.
 * - **`MapHoverPlate`** — the one hover plate a board shows (the map plate ground, a `line2` edge,
 *   the kicker title, ~6 px, the words). It takes a single point, so a pane can't show two. It sits
 *   up and right of its point, and **flips only where it would overflow its pane**: to the point's
 *   left past the right edge, below it past the top — where it fits, it never moves.
 */

// ── Pane ─────────────────────────────────────────────────────────────────────────────────────

/** The map's frame: everything docks to its edges. */
function MapPane({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="map-pane"
      className={cn('relative isolate overflow-hidden bg-bg', className)}
      {...props}
    />
  );
}

// ── Layer rack ───────────────────────────────────────────────────────────────────────────────

type MapLayerRackProps = ComponentProps<'div'> & {
  /** Toggles only; a row's name and key show while it is hovered or focused. */
  collapsed?: boolean;
};

/**
 * The column of layer rows. Its children are kit `SwitchRow`s (plate variant). Each row is its own
 * tab stop — a set of checkboxes, not a menu — and its key is the pane's to bind.
 */
function MapLayerRack({
  collapsed = false,
  className,
  style,
  'aria-label': label = 'Map layers',
  ...props
}: MapLayerRackProps) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset is for form fields; these act on the map at once
    <div
      role="group"
      aria-label={label}
      data-slot="map-layer-rack"
      data-collapsed={collapsed ? '' : undefined}
      className={cn(
        'absolute left-(--space-5) z-(--z-map-control) flex flex-col',
        // The rows sit 3 px apart (the boards' `.layers` gap), so each plate reads on its own.
        'gap-[0.1875rem]',
        // Under the mode bar when one is up: its top, its height and the gap the boards leave.
        'top-(--space-5) in-[[data-slot=map-pane]:has([data-slot=map-mode-bar])]:top-(--rack-under-mode)',
        collapsed
          ? [
              'w-max',
              // Collapsed: the switch alone, an even pad; the name stays for a reader.
              '*:data-[slot=switch-row]:gap-0 *:data-[slot=switch-row]:px-[0.6em]',
              '**:data-[slot=switch-label]:sr-only',
              '**:data-[slot=kbd]:hidden',
              // Hovered or focused, the row says what it is again.
              '*:data-[slot=switch-row]:lit:gap-[0.8em]',
              '[&>[data-slot=switch-row]:hover>[data-slot=switch-label]]:not-sr-only',
              '[&>[data-slot=switch-row]:focus-visible>[data-slot=switch-label]]:not-sr-only',
              '[&>[data-slot=switch-row]:hover>[data-slot=kbd]]:inline-flex',
              '[&>[data-slot=switch-row]:focus-visible>[data-slot=kbd]]:inline-flex',
            ]
          : 'w-[8rem]',
        className,
      )}
      style={{ ...RACK_UNDER_MODE, ...style }}
      {...props}
    />
  );
}

/** The mode bar's top + its height + the 16 px the boards leave under it (60 px on the console). */
const MODE_TOP = 'var(--space-3_5)';
const MODE_HEIGHT = '1.875rem';
const RACK_UNDER_MODE = {
  '--rack-under-mode': `calc(${MODE_TOP} + ${MODE_HEIGHT} + var(--space-4))`,
} as CSSProperties;

// ── Mode bar ─────────────────────────────────────────────────────────────────────────────────

type MapModeBarProps = Omit<ComponentProps<'div'>, 'children'> & {
  /** The mode's name ("Measure", "Compare", "Bay mode") — a mode, never a verdict. */
  mode: ReactNode;
  /** What to do next ("Click the second shore point"). */
  children?: ReactNode;
  /** Where the task stands ("Step 2 of 4"). */
  step?: ReactNode;
  /** Leaves the mode. The Esc cap becomes a button; the pane binds Escape to the same call. */
  onExit?: () => void;
  /** The exit button's name. */
  exitLabel?: string;
};

function MapModeBar({
  mode,
  children,
  step,
  onExit,
  exitLabel = 'Leave the mode',
  className,
  style,
  ...props
}: MapModeBarProps) {
  return (
    <div
      role="status"
      data-slot="map-mode-bar"
      className={cn(
        'absolute inset-x-(--space-5) z-(--z-plate) flex items-center gap-(--space-3_5) px-(--space-3)',
        'border-(length:--stroke-hair) border-solid border-acc bg-plate',
        // The mock's 3 px wash ring and 22 px glow (drawing values, px) — as the go bar wears them.
        'shadow-[0_0_0_3px_var(--acc-wash),0_0_22px_var(--acc-glow)]',
        'font-(family-name:--family-sans) leading-none whitespace-nowrap',
        className,
      )}
      style={{ top: MODE_TOP, height: MODE_HEIGHT, ...style }}
      {...props}
    >
      <span
        data-slot="map-mode-bar-mode"
        className="text-kick leading-none font-semibold tracking-kick text-acc uppercase"
      >
        {mode}
      </span>
      {children != null && (
        <span
          data-slot="map-mode-bar-line"
          className="min-w-0 truncate text-row leading-none text-fg"
        >
          {children}
        </span>
      )}
      <span className="ms-auto flex items-center gap-(--space-2_5)">
        {step != null && (
          <span
            data-slot="map-mode-bar-step"
            className="font-(family-name:--family-mono) text-kick leading-none tracking-micro text-fg3 uppercase"
          >
            {step}
          </span>
        )}
        {onExit === undefined ? (
          <Kbd aria-label="Escape leaves the mode">Esc</Kbd>
        ) : (
          <button
            type="button"
            data-slot="map-mode-bar-exit"
            aria-label={exitLabel}
            aria-keyshortcuts="Escape"
            onClick={onExit}
            className="hit inline-flex cursor-pointer rounded-key outline-none focus-visible:shadow-focus"
          >
            <Kbd aria-hidden>Esc</Kbd>
          </button>
        )}
      </span>
    </div>
  );
}

// ── Dock, zoom and scale ─────────────────────────────────────────────────────────────────────

/** The bottom-right corner, 56 px up on the console: the scale, then the zoom pair. */
function MapDock({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="map-dock"
      className={cn(
        'absolute right-(--space-2_5) bottom-(--space-14) z-(--z-map-control)',
        'flex items-end gap-(--space-3)',
        className,
      )}
      {...props}
    />
  );
}

type MapZoomProps = Omit<ComponentProps<'div'>, 'children'> & {
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  /** At the map's closest zoom: the in button rests disabled. */
  atMax?: boolean;
  /** At the map's widest zoom. */
  atMin?: boolean;
};

/** One member: a small outlined icon button on the map plate. */
const ZOOM_BUTTON = 'bg-map-plate text-fg1 [&_svg]:h-[0.5625rem]';

function MapZoom({
  onZoomIn,
  onZoomOut,
  atMax = false,
  atMin = false,
  'aria-label': label = 'Zoom',
  ...props
}: MapZoomProps) {
  return (
    // The group keeps its own `data-slot` (its roving focus finds its members by it).
    <ButtonGroup orientation="vertical" aria-label={label} data-map-zoom="" {...props}>
      <Button
        size="icon-sm"
        aria-label="Zoom in"
        className={ZOOM_BUTTON}
        onClick={onZoomIn}
        disabled={atMax}
      >
        <FontAwesomeIcon icon={faPlus} />
      </Button>
      <Button
        size="icon-sm"
        aria-label="Zoom out"
        className={ZOOM_BUTTON}
        onClick={onZoomOut}
        disabled={atMin}
      >
        <FontAwesomeIcon icon={faMinus} />
      </Button>
    </ButtonGroup>
  );
}

/** Earth's equatorial circumference, meters — the Web Mercator constant. */
const EARTH_CIRCUMFERENCE_M = 40_075_016.686;

/**
 * Meters per CSS pixel at a latitude and zoom, for a map drawn in `tileSize` px tiles (MapLibre
 * draws 512). The pane passes its map's numbers through this to the scale bar.
 */
function metersPerPixel(latitude: number, zoom: number, tileSize = 512): number {
  return (EARTH_CIRCUMFERENCE_M * Math.cos((latitude * Math.PI) / 180)) / (tileSize * 2 ** zoom);
}

const FOOT_M = 0.3048;
const MILE_M = 1609.344;
/** A tenth of a mile: from here the bar reads miles, below it feet. */
const TENTH_MILE_M = 0.1 * MILE_M;

type ScaleStop = {
  /** The round distance the bar spans, in meters (as stored). */
  meters: number;
  /** Its length on screen. */
  px: number;
  /** The unit it is a round number of: feet under a tenth of a mile, miles from there. */
  unit: 'ft' | 'mi';
};

/** The longest of 1, 2 or 5 × 10ⁿ `unit`s that is at most `fits` of them (n ≥ the floor's). */
function roundDown(fits: number, floor: number): number {
  const decade = 10 ** Math.floor(Math.log10(Math.max(fits, floor)));
  const lead = Math.max(fits, floor) / decade;
  return (lead >= 5 ? 5 : lead >= 2 ? 2 : 1) * decade;
}

/**
 * The longest round distance whose bar fits in `maxPx`, and its length — in the app's units (D25:
 * stored metric, shown imperial): 1, 2 or 5 × 10ⁿ feet up to 500 ft, then 0.1, 0.2, 0.5, 1, 2, 5 …
 * miles. Below a foot it stops at 1 ft (a pane that close has no use for a scale).
 */
function scaleStop(mpp: number, maxPx: number): ScaleStop {
  const fits = maxPx * mpp;
  if (fits < TENTH_MILE_M) {
    const feet = Math.min(500, roundDown(fits / FOOT_M, 1));
    const meters = feet * FOOT_M;
    return { meters, px: meters / mpp, unit: 'ft' };
  }
  const miles = roundDown(fits / MILE_M, 0.1);
  const meters = miles * MILE_M;
  return { meters, px: meters / mpp, unit: 'mi' };
}

type MapScaleBarProps = Omit<ComponentProps<'div'>, 'children'> & {
  /** Meters per CSS pixel at the map's center (`metersPerPixel(lat, zoom)`). */
  metersPerPixel: number;
  /**
   * The distance's words ("0.5 mi", "200 ft"): the caller's one distance formatter, so the bar and
   * every other distance on the page read alike. Set in the bar's caps.
   */
  format: (meters: number) => string;
  /** The longest the bar may run, in px (map pixels, so a drawing value). */
  maxWidth?: number;
};

/** A label in words for a reader: "0.5 mi" → "0.5 miles", "200 ft" → "200 feet". */
const spoken = (label: string) => label.replace(/ mi$/, ' miles').replace(/ ft$/, ' feet');

function MapScaleBar({
  metersPerPixel: mpp,
  format,
  maxWidth = 96,
  className,
  ...props
}: MapScaleBarProps) {
  const stop = scaleStop(mpp, maxWidth);
  const label = format(stop.meters);
  const hair = tokens.border.hair.value;
  const w = stop.px;
  return (
    <div
      role="img"
      aria-label={`Scale: ${spoken(label)}`}
      data-slot="map-scale"
      className={cn(
        'pointer-events-none flex flex-col items-end gap-(--space-1)',
        'font-(family-name:--family-mono) text-kick leading-none font-medium tracking-rail text-fg2 uppercase',
        className,
      )}
      {...props}
    >
      <span data-slot="map-scale-label">{label}</span>
      {/* A bracket: the two ticks and the run, on the half pixel so the hairline stays crisp. */}
      <svg
        aria-hidden="true"
        data-slot="map-scale-bar"
        width={w + hair}
        height={6}
        viewBox={`0 0 ${w + hair} 6`}
        className="block overflow-visible"
      >
        <path
          d={`M${hair / 2} 0 V${6 - hair / 2} H${w + hair / 2} V0`}
          fill="none"
          stroke="var(--fg2)"
          strokeWidth={hair}
        />
      </svg>
    </div>
  );
}

// ── Hover plate ──────────────────────────────────────────────────────────────────────────────

type MapHoverPlateProps = Omit<ComponentProps<'div'>, 'title'> & {
  /** The hovered mark's point in the pane, px from its top left; `null` shows no plate. */
  at: { x: number; y: number } | null;
  /** The kicker line ("Island · OSM"). */
  title?: ReactNode;
  /** A last line under the name, quieter ("Windy and Copernicus open here"). */
  caption?: ReactNode;
  /** How far up and right of the point the plate's corner sits, px (clear of the mark). */
  offset?: number;
};

/**
 * Which way a plate must flip to stay inside its pane: `x` past the right edge (and there is more
 * room on the left), `y` past the top. Pure, from the plate's size, its point and the pane's size.
 */
function plateFlip(
  at: { x: number; y: number },
  plate: { width: number; height: number },
  pane: { width: number; height: number },
  offset: number,
): { x: boolean; y: boolean } {
  // Half a pixel of slack: a plate a rounding error over its edge doesn't overflow.
  const overRight = at.x + offset + plate.width > pane.width + 0.5;
  const roomLeft = at.x - offset - plate.width;
  const roomRight = pane.width - (at.x + offset + plate.width);
  return {
    x: pane.width > 0 && overRight && roomLeft > roomRight,
    y: pane.height > 0 && at.y - offset - plate.height < -0.5,
  };
}

/** The one hover plate on a board. The pane hands it the hovered mark's point. */
function MapHoverPlate({
  at,
  title,
  caption,
  offset = 12,
  className,
  style,
  children,
  ...props
}: MapHoverPlateProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [flip, setFlip] = useState({ x: false, y: false });
  const x = at?.x ?? 0;
  const y = at?.y ?? 0;
  // Measured unflipped each time the point moves, then flipped if it overflows — before paint.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measured when the point or the words change.
  useLayoutEffect(() => {
    const el = ref.current;
    const pane = el?.offsetParent as HTMLElement | null | undefined;
    if (!el || !pane) return;
    const next = plateFlip(
      { x, y },
      { width: el.offsetWidth, height: el.offsetHeight },
      { width: pane.clientWidth, height: pane.clientHeight },
      offset,
    );
    setFlip((prev) => (prev.x === next.x && prev.y === next.y ? prev : next));
  }, [x, y, offset, title, caption, children]);
  if (at === null) return null;
  return (
    <div
      ref={ref}
      data-slot="map-hover-plate"
      data-flip-x={flip.x ? '' : undefined}
      data-flip-y={flip.y ? '' : undefined}
      className={cn(
        'pointer-events-none absolute z-(--z-plate) flex w-max max-w-[20rem] flex-col gap-(--space-1_5)',
        'px-(--space-2_5) py-(--space-2)',
        !flip.y && '-translate-y-full',
        flip.x && '-translate-x-full',
        'rounded-container border border-solid border-line2 bg-map-plate shadow-plate',
        className,
      )}
      style={{
        left: flip.x ? at.x - offset : at.x + offset,
        top: flip.y ? at.y + offset : at.y - offset,
        ...style,
      }}
      {...props}
    >
      {title != null && (
        <span
          data-slot="map-hover-plate-title"
          className="text-kick leading-none font-medium tracking-head text-fg2 uppercase"
        >
          {title}
        </span>
      )}
      <span
        data-slot="map-hover-plate-body"
        className="text-row leading-none font-medium whitespace-nowrap text-fg"
      >
        {children}
      </span>
      {caption != null && (
        <span
          data-slot="map-hover-plate-caption"
          className="text-assist leading-none whitespace-nowrap text-fg3"
        >
          {caption}
        </span>
      )}
    </div>
  );
}

/**
 * **The legend plate**: a map's legend — what each line on the map is, one
 * row each: a 22 px stroke drawn exactly as the map draws that line (its ink, width and dash), and
 * its name in spaced caps (B01's Inbox boards 2.3 and 2.5, the boards' `.plate .lg`). It sits in a
 * corner of the map on the map plate's ground, so the map shows through it as through the hover
 * plate and the zoom pair.
 *
 * Where `kit/map-key` lists the *marks* along a map's foot, this names its *lines*, in the map's
 * corner: a map that draws three outlines a reader must tell apart (ours, a candidate, a skate).
 */

type MapLegendItem = {
  /** The line's name, written capitalized ("Catalog outline · not ours yet"); set in caps. */
  label: ReactNode;
  /** The stroke's ink, as a CSS color — a token (`var(--fg1)`). */
  ink: string;
  /** Its width, px. */
  width: number;
  /** Its dash, px (`[4, 3]`); solid without one. */
  dash?: readonly number[] | null;
};

type MapLegendProps = Omit<ComponentProps<'div'>, 'children'> & {
  items: readonly MapLegendItem[];
};

function MapLegend({ items, className, ...props }: MapLegendProps) {
  if (items.length === 0) return null;
  return (
    <Plate
      variant="plate"
      data-map-legend=""
      className={cn('w-max max-w-full gap-(--space-1_5) bg-map-plate', className)}
      {...props}
    >
      <ul
        aria-label="Map legend"
        // biome-ignore lint/a11y/noRedundantRoles: `list-none` strips the implied list role in Safari/VoiceOver.
        role="list"
        className="m-0 flex list-none flex-col gap-(--space-1_5) p-0"
      >
        {items.map((item, i) => (
          <li
            // A legend's order is its lines' order, and never changes under it.
            // biome-ignore lint/suspicious/noArrayIndexKey: positional, fixed
            key={i}
            data-slot="map-legend-item"
            className={cn(
              'inline-flex min-w-0 items-center gap-(--space-2)',
              'text-kick leading-none font-medium tracking-head text-fg2 uppercase',
            )}
          >
            <svg
              aria-hidden="true"
              data-slot="map-legend-swatch"
              width={22}
              height={8}
              viewBox="0 0 22 8"
              className="block shrink-0"
            >
              <path
                d="M1 4 H21"
                fill="none"
                stroke={item.ink}
                strokeWidth={item.width}
                strokeDasharray={item.dash ? item.dash.join(' ') : undefined}
              />
            </svg>
            <span className="min-w-0 truncate">{item.label}</span>
          </li>
        ))}
      </ul>
    </Plate>
  );
}

export {
  MapDock,
  MapHoverPlate,
  type MapHoverPlateProps,
  MapLayerRack,
  type MapLayerRackProps,
  MapLegend,
  type MapLegendItem,
  type MapLegendProps,
  MapModeBar,
  type MapModeBarProps,
  MapPane,
  MapScaleBar,
  type MapScaleBarProps,
  MapZoom,
  type MapZoomProps,
  metersPerPixel,
  plateFlip,
  type ScaleStop,
  scaleStop,
};
