import { useMemo } from 'react';

import { RequestLakeHost, RequestLakePane } from '../actions/RequestLakePane';
import { exploreMapSpec } from '../map/mapSpec';
import { useMapSpec } from '../map/useMapSpec';
import { ActionPane } from './ActionPane';
import { InViewList } from './InViewList';
import { LakeSidebar, SidebarBody } from './LakeSidebar';
import { useEscapeToClose, usePageNav } from './lakeNav';
import type { ExploreSearch } from './lakeSearch';

/**
 * `/` — nothing chosen (board 1.1): the lakes in view, beside the layout's region map, labeled.
 * `?act=request` is the request-a-lake flow over the sidebar (agent J's; its way back is here).
 */
export function ExplorePage({ search }: { search: ExploreSearch }) {
  const nav = usePageNav();
  useMapSpec(useMemo(() => exploreMapSpec(), []));
  const close = () => nav.replace(nav.with({ act: null }));
  useEscapeToClose(search.act !== undefined, close);

  return (
    <>
      <RequestLakeHost onOpenLake={(id) => nav.push(`/water/${id}`)} />
      {search.act === 'request' ? (
        <LakeSidebar
          label="Request a lake"
          body={
            <SidebarBody>
              <ActionPane act="request" backTo="Explore" onBack={close}>
                <RequestLakePane />
              </ActionPane>
            </SidebarBody>
          }
        />
      ) : (
        <InViewList />
      )}
    </>
  );
}
