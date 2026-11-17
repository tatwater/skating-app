import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';

import {
  isFailed,
  loaded,
  mapLoadable,
  read,
  readState,
  useConsoleReads,
} from '@/components/admin/reads/consoleReads';
import { useRole } from '@/lib/useRole';
import type { BodyTabProps, BodyTabRegistration } from '../../frame/tabRegistry';
import { ShapeTabView } from './ShapeTab';
import {
  shapeBays,
  shapeMapScene,
  shapeMergeOf,
  shapeOutline,
  touchingNotComputed,
} from './shapeModel';

/**
 * The Shape tab, wired: the body (`waterBodies.get`), its bays (`subAreas.listForBody`, with when
 * each was made) and how each was made (`bodyConsole.bayProvenance`), and the bodies that touch it
 * (`bodyConsole.consoleExtras`, with each neighbor's name) — the frame reads the same, so the
 * client shares each subscription. Adding a bay hands off to the old editor, which has the chord, freehand and
 * paste tools, until the console's bay mode lands (map modes wait, the founder's Review 12 call).
 */
export function ShapeTabRoute({ bodyId, lit = null, onLitChange }: BodyTabProps) {
  const waterBodyId = bodyId as Id<'waterBodies'>;
  // How each bay was made and what touches the body are `body.read`'s, as the frame's extras are:
  // withheld, they're never asked (the rows say only what the bays read says; no Merge block).
  const { can } = useRole();
  const canRead = can('body.read');
  const r = useConsoleReads({
    body: read(api.waterBodies.get, { waterBodyId }),
    subAreas: read(api.subAreas.listForBody, { waterBodyId }),
    made: canRead ? read(api.bodyConsole.bayProvenance, { waterBodyId }) : null,
    extras: canRead ? read(api.bodyConsole.consoleExtras, { waterBodyId }) : null,
  });
  const navigate = useNavigate();
  const { from } = useSearch({ strict: false }) as { from?: string };
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
      // Through the four answers: a settled zero is no block, never *not computed*; a failure is
      // said. Withheld, it is never asked — no block, and no claim that nothing touches it.
      merge={canRead ? shapeMergeOf(readState(r.extras, touchingNotComputed)) : undefined}
      // A neighbor opens with the same way back as this body: to the list the operator came from.
      bodyLink={(id) => (
        <Link to="/admin/body/$id" params={{ id }} search={from === undefined ? {} : { from }} />
      )}
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
