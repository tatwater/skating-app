import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faLayerGroup,
  faLocationCrosshairs,
  faLock,
  faSatellite,
} from '@fortawesome/sharp-light-svg-icons';
import type { ReactNode } from 'react';
import { Button } from '@/components/kit/button';
import { MapZoom } from '@/components/kit/map-controls';
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/kit/popover';
import { SwitchRow } from '@/components/kit/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/kit/tooltip';
import { type MapLayerName, useAnalytics } from '@/lib/analytics';
import type { LegendBand } from '@/lib/depthBands';
import { cn } from '@/lib/utils';
import { type MapLayerToggles, useSkaterMapStore } from '@/stores/skaterMapStore';
import { DepthLegend } from './DepthLegend';
import type { DockControls } from './mapSpec';

/**
 * The map's controls (boards 1.1, 1.2, 3.16, 3.25): the zoom pair, the layers menu and locate down
 * the right edge; the imagery entry and the depth legend at the bottom left; and "Back to the
 * Northeast" centered at the foot once the region has left the screen. Which of them show is the
 * view's spec (`dock`); the layer switches are the viewer's own, in `useSkaterMapStore`.
 */

/** A square icon control on the map plate, with the one tooltip style. */
function DockIconButton({
  label,
  icon,
  onClick,
  pressed,
  busy,
}: {
  label: string;
  icon: typeof faLayerGroup;
  onClick?: () => void;
  pressed?: boolean;
  busy?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="outline"
            size="icon"
            aria-label={label}
            aria-pressed={pressed}
            aria-busy={busy || undefined}
            onClick={onClick}
            className="bg-map-plate text-fg1"
          />
        }
      >
        <FontAwesomeIcon icon={icon} />
      </TooltipTrigger>
      <TooltipContent side="left">{label}</TooltipContent>
    </Tooltip>
  );
}

/** One row of the layers menu: what it is, a line on what it draws, its switch at the end. */
interface LayerRowSpec {
  layer: keyof Omit<MapLayerToggles, 'imagery'>;
  title: string;
  line?: string;
}

/** The analytics name per switch. */
const LAYER_EVENT_NAME: Record<LayerRowSpec['layer'], MapLayerName> = {
  depth: 'depth',
  places: 'places',
  putIns: 'put_ins',
  tracks: 'tracks',
  favorites: 'favorites',
  labels: 'labels',
};

const LAKE_ROWS: readonly LayerRowSpec[] = [
  { layer: 'depth', title: 'Depth', line: 'Contours where a survey exists' },
  { layer: 'places', title: 'Bays and places', line: 'Names skaters steer by' },
  { layer: 'putIns', title: 'Put-ins and parking' },
  { layer: 'tracks', title: 'Tracks', line: 'Where reports this season skated' },
];

const EVERYWHERE_ROWS: readonly LayerRowSpec[] = [
  { layer: 'labels', title: 'Lake labels', line: 'Recent reports and open bounties' },
  { layer: 'favorites', title: 'Favorites', line: 'A star on lakes you follow' },
];

/** The row's two lines, set in row type rather than the switch row's caps. */
function RowText({ title, line }: { title: string; line?: string }) {
  return (
    <span className="flex flex-col gap-0.5 text-left">
      <span className="text-row leading-snug text-fg1">{title}</span>
      {line && <span className="text-assist leading-snug text-fg3">{line}</span>}
    </span>
  );
}

/** Layout for a described switch row: text first, the switch at the row's end (board 3.16). */
const ROW = cn(
  'w-full flex-row-reverse justify-between whitespace-normal',
  // A full-width row, not a bled label: its own padding, no negative margin pulling it into the kicker.
  'm-0! min-h-[46px] px-4! py-1.5! normal-case tracking-normal font-normal',
);

function GroupKicker({ children, ruled }: { children: ReactNode; ruled?: boolean }) {
  return (
    <div
      className={cn(
        'px-4 pt-3.5 pb-1 text-[0.625rem] leading-none font-medium tracking-kick text-fg3 uppercase',
        ruled && 'mt-1.5 border-t border-solid border-line',
      )}
    >
      {children}
    </div>
  );
}

/** The layers menu (board 3.16): a popover of switch rows to the left of its button. */
function MapLayersMenu({
  lakeName,
  contourCredit,
}: {
  lakeName: string | null;
  contourCredit: string | null;
}) {
  const layers = useSkaterMapStore((s) => s.layers);
  const toggleLayer = useSkaterMapStore((s) => s.toggleLayer);
  const { capture } = useAnalytics();

  const row = ({ layer, title, line }: LayerRowSpec) => (
    <SwitchRow
      key={layer}
      variant="bare"
      className={ROW}
      checked={layers[layer]}
      onCheckedChange={(on) => {
        toggleLayer(layer);
        capture('map_layer_toggled', { layer: LAYER_EVENT_NAME[layer], on });
      }}
      label={<RowText title={title} line={line} />}
    />
  );

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="Map layers"
                  className="bg-map-plate text-fg1 data-popup-open:bg-raise data-popup-open:text-fg"
                />
              }
            />
          }
        >
          <FontAwesomeIcon icon={faLayerGroup} />
        </TooltipTrigger>
        <TooltipContent side="left">Map layers</TooltipContent>
      </Tooltip>
      <PopoverContent side="left" align="start" sideOffset={8} className="w-[300px] pb-1">
        <PopoverHeader>
          <PopoverTitle>Map layers</PopoverTitle>
        </PopoverHeader>
        <GroupKicker>{lakeName ? `On ${lakeName}` : 'On an open lake'}</GroupKicker>
        {LAKE_ROWS.map(row)}
        <GroupKicker ruled>Everywhere</GroupKicker>
        {/* Hazards are always drawn: the row is locked on, never a switch anyone can turn off (D3). */}
        <SwitchRow
          variant="bare"
          className={ROW}
          checked
          readOnly
          aria-describedby="map-layers-hazards-locked"
          label={
            <span className="flex items-center gap-3">
              <RowText title="Hazards" line="Always shown" />
              <FontAwesomeIcon icon={faLock} className="size-3.5 text-fg3" />
              <span id="map-layers-hazards-locked" className="sr-only">
                Hazards can't be hidden.
              </span>
            </span>
          }
        />
        {EVERYWHERE_ROWS.map(row)}
        <p className="m-0 mt-1.5 border-t border-solid border-line px-4 pt-2.5 pb-2 text-assist leading-snug text-fg3">
          Basemap and water © OpenStreetMap contributors.
          {/* The tile's credit ends with its own period (`formatContourCredit`); ours closes the
            line, so the shared store string never prints "..". */}
          {contourCredit ? ` Contours: ${contourCredit.replace(/\.$/, '')}.` : ''}
        </p>
      </PopoverContent>
    </Popover>
  );
}

export interface MapDockControlsProps {
  controls: DockControls;
  onZoomIn: () => void;
  onZoomOut: () => void;
  atMaxZoom?: boolean;
  atMinZoom?: boolean;
  onLocate: () => void;
  locating?: boolean;
  /** Absent: the view has no imagery flow to open, so the button doesn't show. */
  onOpenImagery?: () => void;
  /** Whether the depth legend has anything to explain: contours are on screen. */
  depthShown: boolean;
  /**
   * The open lake's filled bands, as its tiles bound them. Given, the legend shows those bands at
   * their real depths; empty or absent, it shows the ramp the contour lines are colored by.
   */
  depthBands?: readonly LegendBand[];
  onReturnToRegion: () => void;
  lakeName: string | null;
  contourCredit: string | null;
}

function MapDockControls({
  controls,
  onZoomIn,
  onZoomOut,
  atMaxZoom = false,
  atMinZoom = false,
  onLocate,
  locating = false,
  onOpenImagery,
  depthShown,
  depthBands,
  onReturnToRegion,
  lakeName,
  contourCredit,
}: MapDockControlsProps) {
  const away = useSkaterMapStore((s) => s.awayFromRegion);
  const { capture } = useAnalytics();
  const imagery = controls.imagery && onOpenImagery !== undefined;
  const legend = controls.legend && depthShown;

  return (
    <>
      <div
        data-slot="map-dock"
        className="absolute top-4 right-4 z-(--z-map-control) flex flex-col items-end gap-2.5"
      >
        {controls.zoom && (
          <MapZoom
            onZoomIn={onZoomIn}
            onZoomOut={onZoomOut}
            atMax={atMaxZoom}
            atMin={atMinZoom}
            className="[&_button]:size-btn [&_button]:bg-map-plate"
          />
        )}
        {controls.layers && <MapLayersMenu lakeName={lakeName} contourCredit={contourCredit} />}
        {controls.locate && (
          <DockIconButton
            label="Your location"
            icon={faLocationCrosshairs}
            onClick={onLocate}
            busy={locating}
          />
        )}
      </div>
      {(imagery || legend) && (
        <div className="absolute bottom-[calc(var(--space-4)+var(--map-foot,0px))] left-4 z-(--z-map-control) flex flex-col items-start gap-3">
          {legend && <DepthLegend bands={depthBands} />}
          {imagery && (
            <Button
              variant="outline"
              size="sm"
              className="bg-map-plate text-fg1"
              onClick={() => {
                capture('imagery_opened', { band: 'tc' });
                onOpenImagery?.();
              }}
            >
              <FontAwesomeIcon icon={faSatellite} />
              Latest imagery
            </Button>
          )}
        </div>
      )}
      {/* Announced as it appears: the one control a lost skater needs to find (board 3.25). */}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none absolute inset-x-0 bottom-[calc(var(--space-7)+var(--map-foot,0px))] z-(--z-map-control) flex justify-center"
      >
        {away && (
          <Button
            variant="primary"
            className="pointer-events-auto shadow-plate"
            onClick={() => {
              capture('return_to_region_used');
              onReturnToRegion();
            }}
          >
            <FontAwesomeIcon icon={faLocationCrosshairs} />
            Back to the Northeast
          </Button>
        )}
      </div>
    </>
  );
}

export { MapDockControls, MapLayersMenu };
