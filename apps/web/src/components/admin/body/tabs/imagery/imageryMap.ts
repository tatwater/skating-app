import type { BodyMapScene, MapRaster } from '../../map/mapDescriptors';
import { type PassRow, parsePassAddress, passAddress, selectedPass } from './imageryModel';

/**
 * What the Imagery tab asks the frame's map to draw (board 5.4.6): the lit pass's picture as the
 * Aerial layer — a quiet raster under the outline, never brighter than it — and the Aerial layer on
 * while the tab is open. The frame paints the pass with the skater app's own imagery reveal.
 */
export type ImageryMapData = {
  rows: readonly PassRow[];
  band: string;
  /** The archive's season (`winter-2026-27`), for the picture's credit; `null` while unread. */
  season: string | null;
};

export function imageryMapScene(data: ImageryMapData, lit: string | null): BodyMapScene {
  const parsed = parsePassAddress(lit);
  // `useData` reads one band's passes; a pass lit in another band is never drawn from them (the
  // wrong picture under the right date is the one failure this layer can't have).
  if (parsed.band !== data.band) {
    return {
      items: [],
      lit: lit?.startsWith('pass:') ? lit : null,
      layers: { aerial: true },
    };
  }
  const row = data.rows[selectedPass(data.rows, parsed.granuleId)];
  const address = row === undefined ? null : passAddress(data.band, row.id);
  const rasters: MapRaster[] =
    row === undefined || address === null
      ? []
      : [
          {
            kind: 'raster',
            id: address,
            layer: 'aerial',
            granuleId: row.id,
            band: row.band,
            capturedAt: row.capturedAt,
            key: row.key,
            season: data.season,
          },
        ];
  return { items: rasters, lit: address, layers: { aerial: true } };
}
