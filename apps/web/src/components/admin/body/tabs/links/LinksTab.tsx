import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { useMutation, useQuery } from 'convex/react';
import { useEffect, useState } from 'react';

import { errorText } from '@/components/admin/adminUi';
import { useUndo } from '@/components/admin/shell/undo';
import { useRole } from '@/lib/useRole';

import type { BodyTabProps, BodyTabRegistration } from '../../frame/tabRegistry';
import { LinksTabView } from './LinksTabView';
import { linksMapScene } from './linksMap';

/**
 * Body › Links, wired: the body from `waterBodies.get` (the derived links are built from it at
 * render time, as the lake sheet builds them), and every change to the staff's links — add, edit,
 * remove, reorder — written whole through `waterBodies.setReferenceLinks` (`body.identity`) and
 * announced to the shell's Undo, whose undo puts the previous list back.
 */
export function LinksTab({ bodyId: id }: BodyTabProps) {
  const bodyId = id as Id<'waterBodies'>;
  const result = useQuery(api.waterBodies.get, { waterBodyId: bodyId });
  const setLinks = useMutation(api.waterBodies.setReferenceLinks);
  const { can } = useRole();
  const { announce } = useUndo();
  const now = useDayClock();

  if (result === undefined || result === null || !result.available) return null;
  return (
    <LinksTabView
      body={result.body}
      now={now}
      canEdit={can('body.identity')}
      lakeSheetHref={`/water/${encodeURIComponent(bodyId)}`}
      onSave={async (links) => {
        try {
          await setLinks({ waterBodyId: bodyId, links });
        } catch (err) {
          throw new Error(errorText(err));
        }
        await announce({
          title: 'Links saved',
          target: { targetType: 'waterbody', targetId: bodyId },
        });
      }}
    />
  );
}

/** The map's data: the body, as `waterBodies.get` hands it (Convex keeps its identity). */
function useLinksMapData(bodyId: string) {
  return useQuery(api.waterBodies.get, { waterBodyId: bodyId as Id<'waterBodies'> });
}

/** The Links tab's registration in the frame's registry. */
export const LINKS_TAB: BodyTabRegistration<ReturnType<typeof useLinksMapData>> = {
  Wiring: LinksTab,
  map: {
    useData: useLinksMapData,
    describe: (result: ReturnType<typeof useLinksMapData>, lit: string | null) =>
      linksMapScene(result?.available === true ? result.body : null, lit),
  },
};

/** Copernicus' window is the last 14 days from now: moved on daily. */
function useDayClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 86_400_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}
