import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { searchQueryArg } from '@skating/core';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useMutation } from 'convex/react';
import { useEffect, useState } from 'react';

import {
  isFailed,
  loaded,
  mapLoadable,
  read,
  readState,
  useConsoleReads,
} from '@/components/admin/reads/consoleReads';
import { useRole } from '@/lib/useRole';
import { undoOf } from '../../../inbox/actions/useDecisionRunner';
import type { Receipt } from '../../../shell/undo';
import type { BodyTabProps, BodyTabRegistration } from '../../frame/tabRegistry';
import { useTabAction } from '../useTabAction';
import type { SurvivorHit } from './MergeFlow';
import { MERGE_PREVIEW, MERGE_WRITE, type Survivor } from './mergeModel';
import { MERGE_WORDS as MW } from './mergeWords';
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
 *
 * **The merge**, for a viewer with `corpus.duplicates`: the survivor picked among the touching bodies
 * or found by name (`waterBodies.searchByName`, bodies only, once typing rests), the server's preview
 * of merging this body into it (`bodyConsole.mergePreview`), and the write (`waterBodies.merge`, with
 * its reason) through `useTabAction` — under the body hold and the save rule; a refusal is a toast
 * naming this body; the receipt names both bodies, with Undo (the unmerge) from the write's own
 * answer. Once it lands, this body's record is the survivor's, and the frame draws the merged page.
 */
export function ShapeTabRoute({ bodyId, lit = null, onLitChange }: BodyTabProps) {
  const waterBodyId = bodyId as Id<'waterBodies'>;
  // How each bay was made and what touches the body are `body.read`'s, as the frame's extras are:
  // withheld, they're never asked (the rows say only what the bays read says; no Merge block).
  const { can } = useRole();
  const canRead = can('body.read');
  // The merge is a moderator's duplicates work: without it, nothing of the flow is read or drawn.
  const canMerge = canRead && can('corpus.duplicates');
  const [survivor, setSurvivor] = useState<Survivor | null>(null);
  const [query, setQuery] = useState('');
  const asked = searchQueryArg(useResting(query, SEARCH_REST_MS), SEARCH_HITS);
  const r = useConsoleReads({
    body: read(api.waterBodies.get, { waterBodyId }),
    subAreas: read(api.subAreas.listForBody, { waterBodyId }),
    made: canRead ? read(api.bodyConsole.bayProvenance, { waterBodyId }) : null,
    extras: canRead ? read(api.bodyConsole.consoleExtras, { waterBodyId }) : null,
    hits:
      canMerge && asked !== 'skip'
        ? read(api.waterBodies.searchByName, { ...asked, bodiesOnly: true })
        : null,
    preview:
      canMerge && survivor !== null
        ? read(MERGE_PREVIEW, {
            loserId: waterBodyId,
            survivorId: survivor.id as Id<'waterBodies'>,
          })
        : null,
  });
  const { attempt } = useTabAction(bodyId);
  const mergeWrite = useMutation(MERGE_WRITE);
  const record = loaded(r.body);
  const bodyName = record?.available ? record.body.name : '';
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
      {...(canMerge
        ? {
            mergeFlow: {
              survivor,
              onPick: setSurvivor,
              query,
              onQueryChange: setQuery,
              hits:
                asked === 'skip'
                  ? null
                  : mapLoadable(r.hits, (found) => survivorHits(found, bodyId)),
              preview: r.preview,
              bodyName,
              onMerge: async (reason: string) => {
                if (survivor === null) return false;
                const into = survivor;
                // The receipt names both bodies — the survivor here, this body as its subject — and
                // takes its Undo (the unmerge) from the write's own answer.
                const target = { targetType: 'waterbody', targetId: bodyId } as const;
                const sent = await attempt(
                  () =>
                    mergeWrite({
                      survivorId: into.id as Id<'waterBodies'>,
                      loserId: waterBodyId,
                      reason,
                    }),
                  (answer): Receipt => ({
                    title: MW.merged(into.name),
                    description: MW.mergedDetail,
                    target,
                    // Its Undo is the unmerge: the Undone toast says what stayed where it was.
                    action: 'merge_waterbody',
                    ...undoOf({ target, answer }),
                  }),
                  MW.what,
                );
                return sent.landed;
              },
            },
          }
        : {})}
      lit={lit}
      onLitChange={(next) => onLitChange?.(next)}
      onAddBay={() => void navigate({ to: '/admin/water/$id', params: { id: bodyId } })}
    />
  );
}

/** How long typing rests before the survivor search asks the server (the palette's rest). */
const SEARCH_REST_MS = 150;
/** The most bodies the survivor search lists. */
const SEARCH_HITS = 6;

/** `value`, once it has rested `ms` unchanged. */
function useResting(value: string, ms: number): string {
  const [rested, setRested] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setRested(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return rested;
}

type SearchHitRead = { waterBodyId: string; name: string; type: string; states: string[] };

/** The search's bodies as survivors: never this body itself, each with its kind and states. */
export function survivorHits(found: readonly SearchHitRead[], bodyId: string): SurvivorHit[] {
  return found
    .filter((h) => h.waterBodyId !== bodyId)
    .map((h) => ({
      id: h.waterBodyId,
      name: h.name,
      sub: [h.type.charAt(0).toUpperCase() + h.type.slice(1), h.states.join(', ')]
        .filter(Boolean)
        .join(' · '),
    }));
}

/** The Shape tab draws nothing the frame doesn't: its map needs no data of its own. */
const NO_DATA = {};

/** The Shape tab's registration in the frame's registry. */
export const SHAPE_TAB: BodyTabRegistration = {
  Wiring: ShapeTabRoute,
  map: { useData: () => NO_DATA, describe: shapeMapScene },
};
