import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { useNavigate, useParams, useRouter, useSearch } from '@tanstack/react-router';
import { useMutation } from 'convex/react';
import { type ComponentType, useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from '@/components/kit/toast';
import { useTheme } from '@/components/theme-provider';
import { errorText } from '../../adminUi';
import { useUndo } from '../../shell/undo';
import { BodyMap } from '../map/BodyMap';
import { mergeScenes } from '../map/bodyScene';
import type { BodyMapScene } from '../map/mapDescriptors';
import { SHAPE_TAB } from '../tabs/shape/ShapeTabRoute';
import { campaignText } from '../tabs/shape/shapeModel';
import { BodyConsoleMissing, BodyConsoleView } from './BodyConsoleView';
import {
  type BodyConsoleSearch,
  bodyTabOf,
  returnPathOf,
  searchFor,
  validateBodySearch,
} from './bodySearch';
import { NotBuiltTab } from './NotBuiltTab';
import {
  type BodyTabProps,
  type BodyTabRegistry,
  type BodyTabSlot,
  isBuilt,
  registerBodyTabs,
} from './tabRegistry';
import { useBodyConsole } from './useBodyConsole';

/**
 * The Body console at `/admin/body/$id`, wired: the body from the URL's `$id`, the tab, the lit
 * item and the return path from its validated search (`validateBodySearch`, which the route binds),
 * the reads (`useBodyConsole`), the map (its own MapLibre instance), and the tabs from the registry.
 *
 * The route file is the integrator's and stays one line:
 *
 *   createFileRoute('/admin/body/$id')({ validateSearch: validateBodySearch, component: BodyConsoleRoute })
 *
 * Every tab built so far is registered in {@link BODY_TAB_REGISTRY}; a slot nobody has filled draws
 * *Not built yet* with a link to the old editor, which still does that tab's work.
 */
export const BODY_TAB_REGISTRY: BodyTabRegistry = registerBodyTabs({ shape: SHAPE_TAB });

export function BodyConsoleRoute({ registry = BODY_TAB_REGISTRY }: { registry?: BodyTabRegistry }) {
  const params = useParams({ strict: false }) as { id?: string };
  const raw = useSearch({ strict: false }) as Record<string, unknown>;
  const search = useMemo(() => validateBodySearch(raw), [raw]);
  const bodyId = params.id ?? '';
  const navigate = useNavigate();
  const { resolvedTheme } = useTheme();
  const mode = resolvedTheme === 'light' ? 'light' : 'dark';
  const data = useBodyConsole(bodyId);
  const tab = bodyTabOf(search);
  const slot = registry[tab];
  const oldEditorHref = `/admin/water/${encodeURIComponent(bodyId)}`;

  const go = useCallback(
    (next: BodyConsoleSearch, replace = false) =>
      void navigate({ to: '.', search: next, replace } as never),
    [navigate],
  );
  // The return path carries the list's own search, so it goes to history whole, not through `to`.
  const router = useRouter();
  const onReturn = useCallback(() => router.history.push(returnPathOf(search)), [router, search]);
  const onLitChange = useCallback(
    (lit: string | null) => go(searchFor(search, { lit }), true),
    [go, search],
  );

  const boost = useBoostCommit(bodyId);
  const [tabScene, setTabScene] = useState<BodyMapScene | null>(null);
  const lit = search.lit ?? null;
  const readyScene = data.state === 'ready' ? data.scene : null;
  const scene = useMemo(
    () => (readyScene === null ? null : mergeScenes({ ...readyScene, lit }, tabScene)),
    [readyScene, lit, tabScene],
  );

  if (data.state === 'loading') return null;
  if (data.state === 'missing' || data.state === 'unlisted' || scene === null) {
    return (
      <BodyConsoleMissing
        state={data.state === 'missing' ? 'missing' : 'unlisted'}
        oldEditorHref={oldEditorHref}
      />
    );
  }

  return (
    <BodyConsoleView
      identity={data.identity}
      asks={data.asks}
      history={data.history}
      lit={search.lit ?? null}
      now={Date.now()}
      tab={tab}
      onTabChange={(next) => go(searchFor(search, { tab: next }))}
      onOpenAsk={(ask) => go(searchFor(search, { tab: ask.tab, lit: ask.id }))}
      attention={data.attention}
      {...(data.canSetBoost ? { onBoostCommit: boost } : {})}
      onReturn={onReturn}
      status={
        data.lastCampaign === null
          ? null
          : `Last campaign ${campaignText(data.lastCampaign).replace(/ campaign$/, '')}`
      }
      map={
        <>
          {slot.map !== undefined && (
            <TabSceneProbe
              key={slot.key}
              map={slot.map}
              bodyId={bodyId}
              lit={search.lit ?? null}
              onScene={setTabScene}
            />
          )}
          <BodyMap bbox={data.bbox} scene={scene} resetKey={tab} mode={mode} />
        </>
      }
      tabPanel={
        isBuilt(slot) ? (
          <TabWiring
            Wiring={slot.Wiring as ComponentType<BodyTabProps>}
            bodyId={bodyId}
            lit={search.lit ?? null}
            onLitChange={onLitChange}
          />
        ) : (
          <NotBuiltTab label={slot.label} oldEditorHref={oldEditorHref} />
        )
      }
    />
  );
}

function TabWiring({ Wiring, ...props }: BodyTabProps & { Wiring: ComponentType<BodyTabProps> }) {
  return <Wiring {...props} />;
}

/**
 * Reads the open tab's drawing and hands it up. Keyed by the tab where it's mounted, so one tab's
 * `useData` hooks are never swapped for another's inside one component — and the map itself, which
 * sits outside it, is never re-created by a tab change.
 */
function TabSceneProbe({
  map,
  bodyId,
  lit,
  onScene,
}: {
  map: NonNullable<BodyTabSlot['map']>;
  bodyId: string;
  lit: string | null;
  onScene: (scene: BodyMapScene | null) => void;
}) {
  const data = map.useData(bodyId);
  const scene = useMemo(
    () => (data === undefined ? null : map.describe(data, lit)),
    [data, lit, map],
  );
  useEffect(() => {
    onScene(scene);
    return () => onScene(null);
  }, [scene, onScene]);
  return null;
}

/** Sets the map boost and puts its receipt (with Undo) in the toast. */
function useBoostCommit(bodyId: string): (value: number) => void {
  const set = useMutation(api.waterBodies.setCuratedBoost);
  const { announce } = useUndo();
  const [, setBusy] = useState(false);
  return useCallback(
    (value: number) => {
      const rounded = Math.round(value * 10) / 10;
      setBusy(true);
      set({ waterBodyId: bodyId as Id<'waterBodies'>, curatedBoost: rounded })
        .then(() =>
          announce({
            title: `Map boost · ${rounded.toFixed(1)}`,
            target: { targetType: 'waterbody', targetId: bodyId },
          }),
        )
        .catch((e: unknown) => toast({ title: errorText(e), tone: 'bad' }))
        .finally(() => setBusy(false));
    },
    [announce, bodyId, set],
  );
}
