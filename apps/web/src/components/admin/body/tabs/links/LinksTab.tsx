import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { useMutation } from 'convex/react';
import { useEffect, useMemo, useState } from 'react';

import { errorText } from '@/components/admin/adminUi';
import { isFailed, read, useConsoleReadSet } from '@/components/admin/reads/consoleReads';
import { ReadNote } from '@/components/admin/reads/ReadNote';
import { useUndo } from '@/components/admin/shell/undo';
import { useRole } from '@/lib/useRole';
import type { BodyTabProps, BodyTabRegistration } from '../../frame/tabRegistry';
import { LoadingSection, TabBody } from '../tabParts';
import { LinksTabView } from './LinksTabView';
import { linksMapScene } from './linksMap';

/**
 * Body › Links, wired: the body from `waterBodies.get` — the derived links are built from its own
 * facts at render time (its interior point for Windy and Copernicus, its name and states for the
 * community, its area for the satellite rule), as the lake sheet builds them, and the lake sheet
 * link from its id — and every change to the staff's links (add, edit, remove, reorder) written
 * whole through `waterBodies.setReferenceLinks` (`body.identity`) and announced to the shell's
 * Undo, whose undo puts the previous list back. Every link opens in a new tab.
 *
 * The body is read through the tabs' shared reads: loading holds the sections' place, and a
 * failure says so with *Try again*.
 */
export function LinksTab(props: BodyTabProps) {
  return <LinksReads {...props} />;
}

/** The body, for the tab and its map: one key, so Try again re-reads it for both. */
function useBody(bodyId: string) {
  return useConsoleReadSet({
    body: read(api.waterBodies.get, { waterBodyId: bodyId as Id<'waterBodies'> }),
  });
}

function LinksReads({ bodyId: id }: BodyTabProps) {
  const bodyId = id as Id<'waterBodies'>;
  const { reads: got } = useBody(bodyId);
  const result = got.body;
  const setLinks = useMutation(api.waterBodies.setReferenceLinks);
  const { can } = useRole();
  const { announce } = useUndo();
  const now = useDayClock();

  if (result === undefined) {
    return (
      <TabBody aria-busy="true">
        {/* The tab's note, mounted from the first state, so a failure's words are announced. */}
        <ReadNote reads={[result]}>This body couldn’t be read</ReadNote>
        <LoadingSection lines={3} />
        <LoadingSection lines={2} />
      </TabBody>
    );
  }
  if (isFailed(result)) {
    return (
      <TabBody>
        <ReadNote reads={[result]}>This body couldn’t be read</ReadNote>
      </TabBody>
    );
  }
  if (result === null || !result.available) return null;
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

type LinksMapData = { body: Parameters<typeof linksMapScene>[0] };

/**
 * The map's data: the body, kept until its read changes (Convex keeps the result's identity). A
 * failed or missing read draws nothing of its own.
 */
function useLinksMapData(bodyId: string): LinksMapData | undefined {
  const result = useBody(bodyId).reads.body;
  return useMemo(
    () =>
      result === undefined || isFailed(result)
        ? undefined
        : { body: result?.available === true ? result.body : null },
    [result],
  );
}

/** The Links tab's registration in the frame's registry. */
export const LINKS_TAB: BodyTabRegistration<LinksMapData> = {
  Wiring: LinksTab,
  map: {
    useData: useLinksMapData,
    describe: (data: LinksMapData, lit: string | null) => linksMapScene(data.body, lit),
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
