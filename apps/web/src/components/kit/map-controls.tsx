import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faMinus, faPlus } from '@fortawesome/sharp-regular-svg-icons';
import * as tokens from '@skating/design/tokens';
import type { ComponentProps, CSSProperties, ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { Button } from './button';
import { ButtonGroup } from './button-group';
import { Kbd } from './kbd';

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
 * - **`MapScaleBar`** — on the map, never in the foot's key: the longest round distance (1, 2 or 5
 *   × 10ⁿ meters) that fits, as a hairline bracket with its mono label over it.
 * - **`MapHoverPlate`** — the one hover plate a board shows (the map plate ground, a `line2` edge,
 *   the kicker title, ~6 px, the words). It takes a single point, so a pane can't show two.
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

type ScaleStop = {
  /** The round distance the bar spans. */
  meters: number;
  /** Its length on screen. */
  px: number;
  /** As the bar labels it ("500 M", "2 KM"). */
  label: string;
};

/**
 * The longest round distance — 1, 2 or 5 × 10ⁿ meters — whose bar fits in `maxPx`, and its
 * length. Below a meter it stops at 1 m (a pane that close has no use for a scale).
 */
function scaleStop(mpp: number, maxPx: number): ScaleStop {
  const fits = maxPx * mpp;
  const decade = 10 ** Math.floor(Math.log10(Math.max(fits, 1)));
  const lead = fits / decade;
  const step = lead >= 5 ? 5 : lead >= 2 ? 2 : 1;
  const meters = Math.max(step * decade, 1);
  const label = meters >= 1000 ? `${meters / 1000} KM` : `${meters} M`;
  return { meters, px: meters / mpp, label };
}

type MapScaleBarProps = Omit<ComponentProps<'div'>, 'children'> & {
  /** Meters per CSS pixel at the map's center (`metersPerPixel(lat, zoom)`). */
  metersPerPixel: number;
  /** The longest the bar may run, in px (map pixels, so a drawing value). */
  maxWidth?: number;
};

function MapScaleBar({
  metersPerPixel: mpp,
  maxWidth = 96,
  className,
  ...props
}: MapScaleBarProps) {
  const stop = scaleStop(mpp, maxWidth);
  const hair = tokens.border.hair.value;
  const w = stop.px;
  return (
    <div
      role="img"
      aria-label={`Scale: ${stop.label.replace(' KM', ' kilometers').replace(' M', ' meters')}`}
      data-slot="map-scale"
      className={cn(
        'pointer-events-none flex flex-col items-end gap-(--space-1)',
        'font-(family-name:--family-mono) text-kick leading-none font-medium tracking-rail text-fg2',
        className,
      )}
      {...props}
    >
      <span data-slot="map-scale-label">{stop.label}</span>
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
  /** How far up and right of the point the plate's corner sits, px (clear of the mark). */
  offset?: number;
};

/** The one hover plate on a board. The pane hands it the hovered mark's point. */
function MapHoverPlate({
  at,
  title,
  offset = 12,
  className,
  style,
  children,
  ...props
}: MapHoverPlateProps) {
  if (at === null) return null;
  return (
    <div
      data-slot="map-hover-plate"
      className={cn(
        'pointer-events-none absolute z-(--z-plate) flex w-max max-w-[20rem] flex-col gap-(--space-1_5)',
        'px-(--space-2_5) py-(--space-2) -translate-y-full',
        'rounded-container border border-solid border-line2 bg-map-plate shadow-plate',
        className,
      )}
      style={{ left: at.x + offset, top: at.y - offset, ...style }}
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
    </div>
  );
}

export {
  MapDock,
  MapHoverPlate,
  type MapHoverPlateProps,
  MapLayerRack,
  type MapLayerRackProps,
  MapModeBar,
  type MapModeBarProps,
  MapPane,
  MapScaleBar,
  type MapScaleBarProps,
  MapZoom,
  type MapZoomProps,
  metersPerPixel,
  type ScaleStop,
  scaleStop,
};
