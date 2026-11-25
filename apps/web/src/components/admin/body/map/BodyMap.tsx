import { type ReactNode, useMemo, useState } from 'react';
import { type BBoxLike, fitCamera, stillSurface } from '@/lib/mapSurface';
import { useMapToolClaim } from '../frame/mapTool';
import { useAerialSwitch } from './aerialSwitch';
import { BodyMapPane, type BodyMapPaneProps } from './BodyMapPane';
import { BodyMapStill } from './BodyMapStill';
import { type BodyMapMode, bodyMapPalette } from './bodyMapPalette';
import { drawScene, layerSwitches, rackRows } from './bodyScene';
import { type AerialLoad, aerialCredit, useStillAerialLoad } from './consoleAerial';
import type { BodyMapLayer, BodyMapScene } from './mapDescriptors';
import { FIT_PADDING, useBodyMapCanvas } from './useBodyMapCanvas';
import { useMapToolEngine } from './useMapToolEngine';

/**
 * The console map, whole: a scene in, the map drawn. `BodyMap` is the app's (a live MapLibre
 * canvas); `BodyMapStillView` is a story's (the same chrome over an SVG still of the same scene,
 * at a fixed size). The rack's switches start from the open tab's layers and the operator's own
 * switches last until the tab or the body changes (`resetKey`) — all but the summer aerial's, the
 * rack's last row, which is the viewer's own and kept across tabs, bodies and visits
 * (`aerialSwitch`).
 */

type Common = {
  /** The body's bounds: what the camera frames and may not wander far from. */
  bbox: BBoxLike;
  scene: BodyMapScene;
  /** A new key (the body and its open tab) puts the rack back to the scene's own layers. */
  resetKey: string;
  /** What the open tab mounts at the map's foot (its dock). */
  foot?: ReactNode;
  className?: string;
};

const NO_SWITCHES: Partial<Record<BodyMapLayer, boolean>> = {};

/**
 * The rack's switches. **A tab change restores that tab's defaults**: the operator's own switches
 * belong to the key they were made under, and are cleared — not parked — when the key changes, so
 * Bays turned off in Shape comes back on after a visit to Names. (The deliberate rememberings are
 * elsewhere and say so: the map's camera through a theme switch, the list's scroll per list.)
 */
function useRack(scene: BodyMapScene, resetKey: string) {
  const [operator, setOperator] = useState<{
    key: string;
    on: Partial<Record<BodyMapLayer, boolean>>;
  }>({ key: resetKey, on: {} });
  // A new key drops the switches made under the old one, during the render that sees it.
  if (operator.key !== resetKey) setOperator({ key: resetKey, on: {} });
  const own = operator.key === resetKey ? operator.on : NO_SWITCHES;
  const switches = useMemo(() => layerSwitches(scene.layers, own), [scene.layers, own]);
  const drawn = useMemo(() => drawScene(scene, switches), [scene, switches]);
  return {
    drawn,
    rack: rackRows(scene.items, switches),
    onLayerChange: (layer: BodyMapLayer, on: boolean) =>
      setOperator({ key: resetKey, on: { ...own, [layer]: on } }),
  };
}

export function BodyMap({
  bbox,
  scene,
  resetKey,
  mode,
  foot,
  className,
}: Common & { mode: BodyMapMode }) {
  const { drawn, rack, onLayerChange } = useRack(scene, resetKey);
  const [aerial, setAerial] = useAerialSwitch();
  const canvas = useBodyMapCanvas({ bbox, mode, drawn, aerial });
  // The tool a tab claimed (B01-6): its engine on this map, its mode bar over it.
  const tool = useMapToolClaim();
  const palette = useMemo(() => bodyMapPalette(mode), [mode]);
  useMapToolEngine(canvas.liveMap, tool, palette);
  return (
    <BodyMapPane
      tool={
        tool === null
          ? null
          : {
              mode: tool.mode,
              ...(tool.line !== undefined ? { line: tool.line } : {}),
              ...(tool.step !== undefined ? { step: tool.step } : {}),
              onExit: tool.onExit,
            }
      }
      className={className}
      surface={canvas.surface}
      ground={canvas.ground}
      drawn={drawn}
      rack={rack}
      onLayerChange={onLayerChange}
      aerial={{ on: aerial, onChange: setAerial }}
      credit={canvas.aerialCredit}
      aerialLoad={canvas.aerialLoad}
      onZoomIn={canvas.zoomIn}
      onZoomOut={canvas.zoomOut}
      atMinZoom={canvas.atMinZoom}
      atMaxZoom={canvas.atMaxZoom}
      foot={foot}
    />
  );
}

/** The same map over a still, at a fixed size: what a story and a test render. */
export function BodyMapStillView({
  bbox,
  scene,
  resetKey,
  width,
  height,
  hoverId,
  foot,
  aerial: aerialAtFirst = false,
  aerialCapturedAt = null,
  aerialLoad,
  tool = null,
  className,
}: Common & {
  width: number;
  height: number;
  hoverId?: string | null;
  /** The summer aerial's switch as the story opens (a still keeps its own, never the viewer's). */
  aerial?: boolean;
  /** When the story's photograph was flown, for its credit. */
  aerialCapturedAt?: number | null;
  /** Where the story's photograph stands: in, unless said. */
  aerialLoad?: AerialLoad;
  /** A tool held on the still (the app's comes from the tab's claim): its mode bar over the map. */
  tool?: BodyMapPaneProps['tool'];
}) {
  const { drawn, rack, onLayerChange } = useRack(scene, resetKey);
  const load = useStillAerialLoad(aerialLoad);
  const [aerial, setAerial] = useState(aerialAtFirst);
  const [zoomStep, setZoomStep] = useState(0);
  const surface = useMemo(() => {
    const camera = fitCamera(bbox, width, height, FIT_PADDING);
    return stillSurface(width, height, { ...camera, zoom: camera.zoom + zoomStep });
  }, [bbox, width, height, zoomStep]);
  return (
    <BodyMapPane
      tool={tool}
      className={className}
      surface={surface}
      ground={<BodyMapStill surface={surface} drawn={drawn} aerial={aerial} />}
      drawn={drawn}
      rack={rack}
      onLayerChange={onLayerChange}
      aerial={{ on: aerial, onChange: setAerial }}
      credit={aerial ? aerialCredit(aerialCapturedAt) : null}
      aerialLoad={load}
      onZoomIn={() => setZoomStep((z) => z + 1)}
      onZoomOut={() => setZoomStep((z) => z - 1)}
      atMinZoom={zoomStep <= -1}
      hoverId={hoverId ?? null}
      foot={foot}
    />
  );
}
