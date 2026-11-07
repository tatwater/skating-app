import { useMemo } from 'react';

import { RequestLakePane } from '../actions/RequestLakePane';
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
        // On a phone, nothing chosen is the bare map (board 9.1): the labels carry what the list did.
        <div className="contents max-md:hidden">
          <InViewList />
        </div>
      )}
    </>
  );
}
