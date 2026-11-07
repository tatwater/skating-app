import { api } from '@skating/convex/api';
import type { Doc, Id } from '@skating/convex/dataModel';
import {
  chooseAccessTarget,
  type DirectionsPlatform,
  directionsUrl,
  isActive,
  isLeaving,
  standingOf,
  waterBodyDisplayName,
} from '@skating/core';
import { useMutation, useQuery } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { type MouseEvent as ReactMouseEvent, useEffect, useMemo } from 'react';

import { type FavoriteTargetType, useAnalytics } from '@/lib/analytics';
import { useSkaterMapStore } from '@/stores/skaterMapStore';

import { RequestButtons } from '../../RequestLake';
import { withNewReport } from '../chrome';
import { lakeMapSpec } from '../map/mapSpec';
import { useMapSpec } from '../map/useMapSpec';
import { AboutTab } from './AboutTab';
import { AccessTab } from './AccessTab';
import { ActionPane } from './ActionPane';
import { AlertStrip } from './AlertStrip';
import { type FavoriteState, LakeHeader, type LakeHeaderProps } from './LakeHeader';
import { ExploreFrame, LakeSidebar, LakeTabs } from './LakeSidebar';
import { LakeSidebarSkeleton, LakeUnavailable, StandingNoticeView } from './LakeStates';
import { areaFact, depthFact, elevationFact, lakeFacts, lakeKicker } from './lakeModel';
import { type PageNav, useEscapeToClose, usePageNav } from './lakeNav';
import type { LakeSearch, LakeTab } from './lakeSearch';
import { takeWaterBodyOpenSource } from './openSource';
import { ReportsTab } from './ReportsTab';
import { WeatherTab } from './WeatherTab';

/**
 * `/water/$id` — a lake chosen (boards 1.2–1.14). The sidebar beside the region map: the header,
 * the NWS alerts above the tabs, the four tabs, and the attribution at the foot; `?sub=` reframes it
 * as a bay (1.10), `?act=` opens an action over it (row 3). It declares the lake's map spec, so the
 * map frames the lake and draws its depth, hazards, put-ins and places.
 */
export function LakePage({ id, search }: { id: string; search: LakeSearch }) {
  const nav = usePageNav();
  const { capture } = useAnalytics();
  const { tab, sub, act } = search;

  const result = useQuery(api.waterBodies.get, { waterBodyId: id as Id<'waterBodies'> });
  const body = result?.available ? result.body : null;
  const subAreas = useQuery(api.subAreas.listForBody, body ? { waterBodyId: body._id } : 'skip');
  // A `?sub=` that names no live bay on this lake falls back to the lake, rather than framing nothing.
  const bay = sub ? (subAreas?.find((s) => s._id === sub && !s.removed) ?? null) : null;
  const liveSub = bay?._id;

  useMapSpec(
    useMemo(() => lakeMapSpec(id, liveSub), [id, liveSub]),
    { onOpenImagery: () => nav.push(nav.with({ act: 'imagery' })) },
  );

  // Arrival: which surface opened this lake (D240). Once per lake, taken on arrival.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the id is the arrival; the path is read at that moment.
  useEffect(() => {
    capture('water_body_opened', { source: takeWaterBodyOpenSource(nav.pathname) });
  }, [id]);
  // A tab brought up — including the first one on each lake opened.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new lake brings its tab up again.
  useEffect(() => {
    capture('water_body_tab_viewed', { tab });
  }, [id, tab, capture]);

  const closeAct = () =>
    nav.replace(nav.with({ act: null, band: null, frame: null, hazard: null }));
  useEscapeToClose(act !== undefined, closeAct);

  const contourCredit = useSkaterMapStore((s) => s.contourCredit);

  if (result === undefined) return <ExploreFrame sidebar={<LakeSidebarSkeleton />} />;
  if (result === null || !result.available) {
    return (
      <ExploreFrame
        sidebar={
          <LakeUnavailable
            kind={result === null ? 'not-found' : 'unavailable'}
            explore={nav.link('/')}
          />
        }
      />
    );
  }
  const lake = result.body;
  const lakeName = waterBodyDisplayName(lake.name);

  return (
    <ExploreFrame
      sidebar={
        <LakeSidebar
          label={bay ? bay.name : lakeName}
          header={
            <>
              <ConnectedHeader lake={lake} bay={bay} nav={nav} />
              <AlertStrip waterBodyId={lake._id} />
            </>
          }
          body={
            <LakeTabs
              tab={tab}
              onTabChange={(next) =>
                nav.replace(nav.with({ tab: next === 'reports' ? null : next }))
              }
              contourCredit={contourCredit}
              overlay={
                act !== undefined ? (
                  <ActionPane act={act} backTo={bay ? bay.name : lakeName} onBack={closeAct} />
                ) : null
              }
            >
              <TabBody tab={tab} lake={lake} bay={bay} nav={nav} />
            </LakeTabs>
          }
        />
      }
    />
  );
}

/** A bay row, as `subAreas.listForBody` returns it. */
type Bay = FunctionReturnType<typeof api.subAreas.listForBody>[number];

function TabBody({
  tab,
  lake,
  bay,
  nav,
}: {
  tab: LakeTab;
  lake: Doc<'waterBodies'>;
  bay: Bay | null;
  nav: PageNav;
}) {
  const leaving = isLeaving(useQuery(api.profiles.current, {}));
  const subAreaId = bay?._id;
  const open =
    (path: 'hazard' | 'report' | 'bounty') =>
    (id: string, event: ReactMouseEvent<HTMLAnchorElement>) =>
      nav.link(`/${path}/${id}`).onClick(event);
  switch (tab) {
    case 'reports':
      return (
        <ReportsTab
          waterBodyId={lake._id}
          {...(subAreaId !== undefined ? { subAreaId } : {})}
          onOpen={{ hazard: open('hazard'), report: open('report') }}
          onOpenBounties={open('bounty')}
        />
      );
    case 'weather':
      return (
        <WeatherTab waterBodyId={lake._id} {...(subAreaId !== undefined ? { subAreaId } : {})} />
      );
    case 'access':
      return (
        <AccessTab
          waterBodyId={lake._id}
          {...(subAreaId !== undefined ? { subAreaId } : {})}
          onReportProblem={() => nav.push(nav.with({ act: 'access-problem' }))}
        />
      );
    case 'about':
      return (
        <AboutTab
          body={lake}
          bay={bay ? { ...(bay.fetchProfileM ? { fetchProfileM: bay.fetchProfileM } : {}) } : null}
          leaving={leaving}
        />
      );
  }
}

/** Apple Maps on iOS, Google Maps elsewhere — the directions link's platform. */
function detectPlatform(): DirectionsPlatform {
  if (typeof navigator === 'undefined') return 'web';
  return /iPhone|iPad|iPod/.test(navigator.userAgent) ? 'ios' : 'web';
}

/** The header, connected: the favorites (lake and bay), directions, the actions, the standing. */
function ConnectedHeader({
  lake,
  bay,
  nav,
}: {
  lake: Doc<'waterBodies'>;
  bay: Bay | null;
  nav: PageNav;
}) {
  const { capture } = useAnalytics();
  const lakeId = lake._id;
  const profile = useQuery(api.profiles.current, {});
  const leaving = isLeaving(profile);
  const lakeFav = useQuery(api.waterBodyFavorites.isFavorite, { waterBodyId: lakeId });
  const bayFav = useQuery(
    api.waterBodyFavorites.isFavorite,
    bay ? { waterBodyId: lakeId, subAreaId: bay._id } : 'skip',
  );
  const toggle = useMutation(api.waterBodyFavorites.toggle);
  const access = useQuery(api.accessPoints.accessForBody, { waterBodyId: lakeId });
  const legacy = useQuery(api.putIns.listForBody, { waterBodyId: lakeId });

  const favoriteOf = (on: boolean | undefined, target: FavoriteTargetType): FavoriteState => ({
    on: on === true,
    pending: on === undefined,
    onToggle: () => {
      const args = {
        waterBodyId: lakeId,
        ...(bay && target === 'sub_area' ? { subAreaId: bay._id } : {}),
      };
      // A refused toggle is swallowed: the reactive read is the truth, so the star stays put.
      void toggle(args)
        .then(({ favorited }) =>
          capture(favorited ? 'water_body_favorited' : 'water_body_unfavorited', {
            target_type: target,
          }),
        )
        .catch(() => {});
    },
  });

  const target = access
    ? chooseAccessTarget(access.putIns, access.parking, new Set(access.blockedIds))
    : null;
  const fallback = !target && legacy && legacy.length > 0 ? legacy[0] : null;
  const coord = target?.coord ?? fallback?.coord;
  const toParking = target?.via === 'parking';

  const active = isActive(lake);
  const lakeName = waterBodyDisplayName(lake.name);
  const newReportHref = withNewReport(nav.pathname, nav.search, lakeId);

  const props: LakeHeaderProps = {
    kicker: lakeKicker(bay ? 'bay' : lake.type, lake.states),
    name: bay ? bay.name : lakeName,
    partOf: bay
      ? {
          name: lakeName,
          link: nav.link(nav.with({ sub: null })),
          favorite: lakeFav === true,
        }
      : null,
    facts: bay
      ? [
          areaFact(bay.surfaceAreaSqM),
          depthFact({
            ...(bay.maxDepthM !== undefined ? { maxDepthM: bay.maxDepthM } : {}),
            ...(bay.maxDepthSource !== undefined ? { maxDepthSource: bay.maxDepthSource } : {}),
          }),
          elevationFact(lake.elevationM),
        ].filter((f) => f !== null)
      : lakeFacts(lake),
    favorite: bay ? favoriteOf(bayFav, 'sub_area') : favoriteOf(lakeFav, 'water_body'),
    inactive: !active,
    standing: active ? null : (
      <StandingNoticeView
        standing={standingOf(lake)}
        asks={leaving ? null : <RequestButtons body={lake} />}
      />
    ),
    newReport: leaving
      ? null
      : nav.link(newReportHref, () => capture('report_sheet_opened', { entry: 'water_body' })),
    reportHazard: leaving ? null : nav.link(nav.with({ act: 'hazard' })),
    postBounty: leaving || !active ? null : nav.link(nav.with({ act: 'bounty' })),
    directions: coord
      ? {
          href: directionsUrl(coord, detectPlatform()),
          label: toParking ? 'Directions to parking' : 'Directions',
          onOpen: () => capture('directions_opened', { target: toParking ? 'parking' : 'put_in' }),
        }
      : null,
  };
  return <LakeHeader {...props} />;
}
