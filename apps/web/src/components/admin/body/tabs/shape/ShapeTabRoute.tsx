import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from 'convex/react';

import type { BodyTabProps, BodyTabRegistration } from '../../frame/tabRegistry';
import { ShapeTabView } from './ShapeTab';
import { shapeBays, shapeMapScene, shapeOutline } from './shapeModel';

/**
 * The Shape tab, wired: the body (`waterBodies.get`) and its bays (`subAreas.listForBody`) — the
 * reads the old editor makes, so the client shares one subscription with the frame. Adding a bay
 * hands off to the old editor, which has the chord, freehand and paste tools, until the console's
 * bay mode lands (map modes wait, the founder's Review 12 call).
 */
export function ShapeTabRoute({ bodyId, lit = null, onLitChange }: BodyTabProps) {
  const waterBodyId = bodyId as Id<'waterBodies'>;
  const result = useQuery(api.waterBodies.get, { waterBodyId });
  const subAreas = useQuery(api.subAreas.listForBody, { waterBodyId });
  const navigate = useNavigate();
  const body = result?.available ? result.body : undefined;
  return (
    <ShapeTabView
      outline={
        body === undefined
          ? undefined
          : shapeOutline({
              polygon: body.polygon as GeoJSON.Polygon | GeoJSON.MultiPolygon,
              source: body.source,
              ...(body.geometrySource !== undefined ? { geometrySource: body.geometrySource } : {}),
              ...(body.lastCampaignId !== undefined ? { lastCampaignId: body.lastCampaignId } : {}),
            })
      }
      bays={subAreas === undefined ? undefined : shapeBays(subAreas)}
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
