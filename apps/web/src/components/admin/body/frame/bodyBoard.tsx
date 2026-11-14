/**
 * Story support: the Body console in the console's frame at the boards' size (1440 × 900), on the
 * boards' day, so a story can be set beside boards 5.4.1 and read the same. Story-only; nothing in
 * the app imports it. The map is the still (`BodyMapStillView`) — the same chrome over an SVG of
 * the same scene, since a story can't fetch the basemap's tiles.
 */
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { isFailed } from '@/components/admin/reads/consoleReads';
import { StatusLamp } from '@/components/kit/status-bar';
import { ConsoleShell } from '../../shell/ConsoleShell';
import { CONSOLE_MODES } from '../../shell/consoleNav';
import { seasonTape } from '../../shell/consoleTime';
import { BodyMapStillView } from '../map/BodyMap';
import { mergeScenes } from '../map/bodyScene';
import type { BodyMapScene } from '../map/mapDescriptors';
import { ShapeTabView, type ShapeTabViewProps } from '../tabs/shape/ShapeTab';
import { shapeBays, shapeMapScene, shapeOutline } from '../tabs/shape/shapeModel';
import { BodyConsoleGone, type BodyConsoleGoneProps } from './BodyConsoleGone';
import { BodyConsoleView, type BodyConsoleViewProps } from './BodyConsoleView';
import {
  BODY_NOW,
  MASCOMA_ASKS,
  MASCOMA_BAY_PROVENANCE,
  MASCOMA_BOUNDS,
  MASCOMA_COMPLETENESS,
  MASCOMA_HISTORY_ENTRIES,
  MASCOMA_IDENTITY,
  MASCOMA_RECORD,
  MASCOMA_SCENE,
  MASCOMA_SUB_AREAS,
  MASCOMA_TOWNS,
  MASCOMA_TRUST,
} from './bodyFixtures';
import { attentionTabs } from './bodyModel';
import type { BodyTabKey } from './bodySearch';
import { MASCOMA_POLYGON } from './mascomaFixtures';
import { NotBuiltTab } from './NotBuiltTab';
import { BODY_TAB_LABELS } from './tabRegistry';

const TAPE = seasonTape(BODY_NOW);

/** Its parent's size, measured: what the still map is drawn at. */
function Measured({ children }: { children: (w: number, h: number) => ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={ref} className="absolute inset-0">
      {size !== null && size.w > 0 && children(size.w, size.h)}
    </div>
  );
}

export type BodyBoardProps = Partial<
  Pick<
    BodyConsoleViewProps,
    'identity' | 'completeness' | 'towns' | 'trust' | 'asks' | 'history' | 'initiallyFolded'
  >
> & {
  /** The Shape tab's view, over Mascoma's own (its merge block, a failed read). */
  shape?: Partial<ShapeTabViewProps>;
  /** The map's foot (a notice that some of its reads failed). */
  foot?: ReactNode;
  /** Every read still on its way. */
  loading?: boolean;
  /** The record in, completeness, the towns and the trust still on their way. */
  extrasLoading?: boolean;
  /** The open tab (Shape by default). */
  tab?: BodyTabKey;
  /** The lit item. */
  lit?: string | null;
  /** The map's one hover plate, by item id. */
  hoverId?: string | null;
  /** A tab's scene over the frame's. */
  tabScene?: BodyMapScene | null;
  className?: string;
};

/** The console's frame around a page, as the boards draw it. */
function BoardShell({ className, children }: { className: string; children: ReactNode }) {
  return (
    <ConsoleShell
      className={className}
      modes={CONSOLE_MODES.map((m) => ({ ...m, current: false }))}
      legacy={[]}
      onLegacy={() => {}}
      appHref="#app"
      viewer={{ name: 'Teagan Atwater' }}
      tape={TAPE}
      colleagues={[
        { id: 's', name: 'Sarah Berman', present: true },
        { id: 'm', name: 'Matt Steinberg' },
      ]}
      viewerId="t"
      onSearch={() => {}}
      lamp={<StatusLamp>Convex live</StatusLamp>}
    >
      {children}
    </ConsoleShell>
  );
}

/** A body the console can't open, in the console's frame, on the boards' clock. */
export function BodyGoneBoard({
  className = 'h-[56.25rem] w-[90rem]',
  ...props
}: Omit<BodyConsoleGoneProps, 'now'> & { className?: string }) {
  return (
    <BoardShell className={className}>
      <BodyConsoleGone {...props} now={BODY_NOW} onReturn={() => {}} />
    </BoardShell>
  );
}

/** The Body console in the console's frame, on the boards' clock. */
export function BodyBoard({
  identity: givenIdentity = MASCOMA_IDENTITY,
  completeness: givenCompleteness = MASCOMA_COMPLETENESS,
  towns: givenTowns = MASCOMA_TOWNS,
  trust: givenTrust = MASCOMA_TRUST,
  asks: givenAsks = MASCOMA_ASKS,
  history: givenHistory = MASCOMA_HISTORY_ENTRIES,
  shape,
  foot,
  loading = false,
  extrasLoading = false,
  initiallyFolded,
  tab: initialTab = 'shape',
  lit: initialLit = null,
  hoverId = null,
  tabScene = null,
  className = 'h-[56.25rem] w-[90rem]',
}: BodyBoardProps) {
  const identity = loading ? undefined : givenIdentity;
  const completeness = loading || extrasLoading ? undefined : givenCompleteness;
  const asks = loading ? undefined : givenAsks;
  const history = loading ? undefined : givenHistory;
  const done = completeness == null || isFailed(completeness) ? null : completeness;
  const [tab, setTab] = useState<BodyTabKey>(initialTab);
  const [lit, setLit] = useState<string | null>(initialLit);
  const scene = mergeScenes(
    { ...MASCOMA_SCENE, lit },
    tabScene ?? (tab === 'shape' ? shapeMapScene(null, lit) : null),
  );
  return (
    <BoardShell className={className}>
      <BodyConsoleView
        identity={identity}
        completeness={completeness}
        towns={loading || extrasLoading ? undefined : givenTowns}
        trust={loading || extrasLoading ? undefined : givenTrust}
        asks={asks}
        history={history}
        {...(initiallyFolded !== undefined ? { initiallyFolded } : {})}
        lit={lit}
        now={BODY_NOW}
        tab={tab}
        onTabChange={(t) => {
          setTab(t);
          setLit(null);
        }}
        onOpenAsk={(ask) => {
          setTab(ask.tab);
          setLit(ask.id);
        }}
        attention={attentionTabs(done?.missing ?? [])}
        onBoostCommit={() => {}}
        onReturn={() => {}}
        status="Last campaign 12 Oct"
        map={
          <Measured>
            {(w, h) => (
              <BodyMapStillView
                bbox={MASCOMA_BOUNDS}
                scene={scene}
                resetKey={tab}
                width={w}
                height={h}
                hoverId={hoverId}
                foot={foot}
              />
            )}
          </Measured>
        }
        tabPanel={
          tab === 'shape' ? (
            <ShapeTabView
              outline={shapeOutline({
                polygon: MASCOMA_POLYGON,
                source: MASCOMA_RECORD.source,
                geometrySource: 'osm',
                lastCampaignId: 'a07a-20261012',
              })}
              bays={shapeBays(MASCOMA_SUB_AREAS, MASCOMA_BAY_PROVENANCE)}
              lit={lit}
              onLitChange={setLit}
              onAddBay={() => {}}
              {...shape}
            />
          ) : (
            <NotBuiltTab label={BODY_TAB_LABELS[tab]} oldEditorHref="#old-editor" />
          )
        }
      />
    </BoardShell>
  );
}
