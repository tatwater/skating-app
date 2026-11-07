import { useMemo } from 'react';

import { exploreMapSpec } from '../map/mapSpec';
import { useMapSpec } from '../map/useMapSpec';
import { ActionPane } from './ActionPane';
import { InViewList } from './InViewList';
import { ExploreFrame, LakeSidebar, SidebarBody } from './LakeSidebar';
import { useEscapeToClose, usePageNav } from './lakeNav';
import type { ExploreSearch } from './lakeSearch';

/**
 * `/` — nothing chosen (board 1.1): the lakes in view beside the region map, labeled. `?act=request`
 * is the request-a-lake flow over the sidebar (agent J's; its frame and its way back are here).
 */
export function ExplorePage({ search }: { search: ExploreSearch }) {
  const nav = usePageNav();
  useMapSpec(useMemo(() => exploreMapSpec(), []));
  const close = () => nav.replace(nav.with({ act: null }));
  useEscapeToClose(search.act !== undefined, close);

  return (
    <ExploreFrame
      sidebar={
        search.act === 'request' ? (
          <LakeSidebar
            label="Request a lake"
            body={
              <SidebarBody>
                <ActionPane act="request" backTo="Explore" onBack={close} />
              </SidebarBody>
            }
          />
        ) : (
          <InViewList />
        )
      }
    />
  );
}
