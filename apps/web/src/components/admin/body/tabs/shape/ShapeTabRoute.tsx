import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { Link, useNavigate } from '@tanstack/react-router';

import { isFailed, loaded, mapLoadable, read, useConsoleReads } from '../../frame/consoleReads';
import type { BodyTabProps, BodyTabRegistration } from '../../frame/tabRegistry';
import { useNeighbors } from '../../frame/touching';
import { ShapeTabView } from './ShapeTab';
import { shapeBays, shapeMapScene, shapeMerge, shapeOutline } from './shapeModel';

/**
 * The Shape tab, wired: the body (`waterBodies.get`), its bays (`subAreas.listForBody`, with when
 * each was made) and how each was made (`bodyConsole.bayProvenance`), and the bodies that touch it
 * (`bodyConsole.consoleExtras`, each read by id) — the frame reads the same, so the client shares
 * each subscription. Adding a bay hands off to the old editor, which has the chord, freehand and
 * paste tools, until the console's bay mode lands (map modes wait, the founder's Review 12 call).
 */
export function ShapeTabRoute({ bodyId, lit = null, onLitChange }: BodyTabProps) {
  const waterBodyId = bodyId as Id<'waterBodies'>;
  const r = useConsoleReads({
    body: read(api.waterBodies.get, { waterBodyId }),
    subAreas: read(api.subAreas.listForBody, { waterBodyId }),
    made: read(api.bodyConsole.bayProvenance, { waterBodyId }),
    extras: read(api.bodyConsole.consoleExtras, { waterBodyId }),
  });
  const neighbors = useNeighbors(loaded(r.extras));
  const navigate = useNavigate();
  const made = loaded(r.made);
  return (
    <ShapeTabView
      outline={mapLoadable(r.body, (result) =>
        // The frame draws a body the console can't open as its own page; this never shows then.
        result?.available
          ? shapeOutline({
              polygon: result.body.polygon as GeoJSON.Polygon | GeoJSON.MultiPolygon,
              source: result.body.source,
              ...(result.body.geometrySource !== undefined
                ? { geometrySource: result.body.geometrySource }
                : {}),
              ...(result.body.lastCampaignId !== undefined
                ? { lastCampaignId: result.body.lastCampaignId }
                : {}),
            })
          : undefined,
      )}
      bays={mapLoadable(r.subAreas, (rows) => shapeBays(rows, made))}
      baysMadeFailed={isFailed(r.made) ? r.made : null}
      merge={mapLoadable(r.extras, (facts) => shapeMerge(facts, neighbors))}
      bodyLink={(id) => <Link to="/admin/body/$id" params={{ id }} />}
      lit={lit}
      onLitChange={(next) => onLitChange?.(next)}
      onAddBay={() => void navigate({ to: '/admin/water/$id', params: { id: bodyId } })}
    />
  );
}

/** The Shape tab draws nothing the frame doesn't: its map needs no data of its own. */
const NO_DATA = {};

/** The Shape tab's registration in the frame's registry. */
export const SHAPE_TAB: BodyTabRegistration = {
  Wiring: ShapeTabRoute,
  map: { useData: () => NO_DATA, describe: shapeMapScene },
};
