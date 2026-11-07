import { ActionPane } from '../lake/ActionPane';
import type { PageNav } from '../lake/lakeNav';
import type { LakeAct } from '../lake/lakeSearch';
import { MapFloat } from '../map/MapFloat';
import { BountyPane } from './BountyPane';
import { HazardSheetHost } from './HazardSheetHost';
import { ImageryPane } from './ImageryPane';

/**
 * The lake's `?act=` actions (row 3): the imagery plate floated over the map (`MapFloat`; Esc
 * still the page's), the hazard flow in the New report sheet's frame over the page
 * (Review 2; `HazardSheetHost`), the bounty as the dialog its boards draw over the lake. The access
 * problem is agent D's and keeps C's placeholder until it lands.
 */
export function LakeAction({
  act,
  waterBodyId,
  lakeName,
  subAreaId,
  band,
  frame,
  backTo,
  nav,
  onBack,
}: {
  act: LakeAct;
  waterBodyId: string;
  lakeName: string;
  subAreaId?: string;
  band?: 'tc' | 'vh';
  frame?: string;
  backTo: string;
  nav: PageNav;
  onBack: () => void;
}) {
  const sub = subAreaId !== undefined ? { subAreaId } : {};
  switch (act) {
    case 'bounty':
      return (
        <BountyPane
          waterBodyId={waterBodyId}
          lakeName={lakeName}
          {...sub}
          onClose={onBack}
          onPosted={(id) => nav.push(`/bounty/${id}`)}
        />
      );
    case 'hazard':
      // The New report sheet's frame (Review 2), not the sidebar pane: map left, questions right.
      return (
        <HazardSheetHost
          waterBodyId={waterBodyId}
          {...sub}
          reportOpen={new URLSearchParams(nav.search).has('post')}
          onClose={onBack}
        />
      );
    case 'imagery':
      // Floated over the map it paints (boards 3.14/3.15), not over the tabs: the sidebar stays.
      return (
        <MapFloat>
          <section
            aria-label="Latest imagery"
            data-slot="imagery-plate"
            className="w-[33rem] max-w-full border border-solid border-line2 bg-plate-solid p-(--space-4) shadow-plate"
          >
            <ImageryPane
              waterBodyId={waterBodyId}
              {...sub}
              {...(band !== undefined ? { band } : {})}
              {...(frame !== undefined ? { frame } : {})}
              onSearch={(edit) =>
                nav.replace(
                  nav.with(
                    Object.fromEntries(Object.entries(edit).filter(([, v]) => v !== undefined)),
                  ),
                )
              }
              onClose={onBack}
            />
          </section>
        </MapFloat>
      );
    default:
      return <ActionPane act={act} backTo={backTo} onBack={onBack} />;
  }
}
