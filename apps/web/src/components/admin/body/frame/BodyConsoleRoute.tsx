import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { Link, useNavigate, useParams, useRouter, useSearch } from '@tanstack/react-router';
import { useMutation } from 'convex/react';
import {
  type ComponentType,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { ReadBoundary } from '@/components/kit/read-boundary';
import { RetryNote } from '@/components/kit/retry-note';
import { Skeleton } from '@/components/kit/skeleton';
import { toast } from '@/components/kit/toast';
import { useTheme } from '@/components/theme-provider';
import { cn } from '@/lib/utils';
import { listWords } from '@/lib/words';
import { errorText } from '../../adminUi';
import { useUndo } from '../../shell/undo';
import { BodyMap } from '../map/BodyMap';
import { mergeScenes } from '../map/bodyScene';
import type { BodyMapScene } from '../map/mapDescriptors';
import { TabBoundary } from '../TabBoundary';
import { SHAPE_TAB } from '../tabs/shape/ShapeTabRoute';
import { campaignText } from '../tabs/shape/shapeModel';
import { BodyConsoleGone } from './BodyConsoleGone';
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
import { type MapFailures, useBodyConsole } from './useBodyConsole';

/**
 * The Body console at `/admin/body/$id`, wired: the body from the URL's `$id`, the tab, the lit
 * item and the return path from its validated search (`validateBodySearch`, which the route binds),
 * the reads (`useBodyConsole`), the map (its own MapLibre instance), and the tabs from the registry.
 * The map and the open tab each sit in their own boundary: one that throws says so in its pane, with
 * *Try again*, and takes nothing else down (and still reaches Sentry).
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
  // A pane that threw is tried again by remounting it: its boundary resets on a new key.
  const lit = search.lit ?? null;
  const readyScene = data.state === 'ready' ? data.scene : null;
  const scene = useMemo(
    () => (readyScene === null ? null : mergeScenes({ ...readyScene, lit }, tabScene)),
    [readyScene, lit, tabScene],
  );

  if (data.state === 'missing') return <BodyConsoleMissing state="missing" />;
  if (data.state === 'failed') return <BodyConsoleMissing state="failed" onRetry={data.retry} />;
  if (data.state === 'gone') {
    return (
      <BodyConsoleGone
        {...data.gone}
        now={Date.now()}
        onReturn={onReturn}
        survivorLink={(id) => (
          <Link
            to="/admin/body/$id"
            params={{ id }}
            search={search.from !== undefined ? { from: search.from } : {}}
          />
        )}
      />
    );
  }

  const status =
    data.state === 'ready' && data.lastCampaign !== null
      ? `Last campaign ${campaignText(data.lastCampaign).replace(/ campaign$/, '')}`
      : null;
  const tabPanel =
    data.state === 'loading' ? (
      <Skeleton className="h-(--space-20)" />
    ) : isBuilt(slot) ? (
      <TabBoundary bodyId={bodyId} tab={slot.key} label={slot.label}>
        <TabWiring
          Wiring={slot.Wiring as ComponentType<BodyTabProps>}
          bodyId={bodyId}
          lit={lit}
          onLitChange={onLitChange}
        />
      </TabBoundary>
    ) : (
      <NotBuiltTab label={slot.label} oldEditorHref={oldEditorHref} />
    );

  return (
    <BodyConsoleView
      bodyKey={bodyId}
      {...(data.state === 'ready'
        ? {
            identity: data.identity,
            completeness: data.completeness,
            towns: data.towns,
            trust: data.trust,
            asks: data.asks,
            asksMore: data.asksMore,
            history: data.history,
            attention: data.attention,
          }
        : {
            identity: undefined,
            completeness: undefined,
            towns: undefined,
            trust: undefined,
            asks: undefined,
            history: undefined,
            attention: NO_ATTENTION,
          })}
      lit={lit}
      now={Date.now()}
      tab={tab}
      onTabChange={(next) => go(searchFor(search, { tab: next }))}
      onOpenAsk={(ask) => go(searchFor(search, { tab: ask.tab, lit: ask.id }))}
      {...(data.state === 'ready' && data.canSetBoost ? { onBoostCommit: boost } : {})}
      onReturn={onReturn}
      status={status}
      map={
        data.state === 'ready' && scene !== null ? (
          <ReadBoundary
            // The open tab's drawing is read inside it: another tab is another try.
            resetKey={`${bodyId}:${slot.key}`}
            fallback={(retry) => (
              <div className="p-gutter">
                <RetryNote data-for="body-map" onRetry={retry}>
                  The map couldn’t be drawn
                </RetryNote>
              </div>
            )}
          >
            {slot.map !== undefined && (
              <TabSceneProbe
                key={slot.key}
                map={slot.map}
                bodyId={bodyId}
                lit={lit}
                onScene={setTabScene}
              />
            )}
            <BodyMap
              bbox={data.bbox}
              scene={scene}
              // A new body is a fresh rack as much as a new tab is: a neighbor already read for its
              // name opens at once, with no loading in between to remount the map.
              resetKey={`${bodyId}:${tab}`}
              mode={mode}
              foot={mapFoot(
                data.mapFailures,
                slot.Dock === undefined ? null : (
                  <TabWiring
                    key={slot.key}
                    Wiring={slot.Dock}
                    bodyId={bodyId}
                    lit={lit}
                    onLitChange={onLitChange}
                  />
                ),
              )}
            />
          </ReadBoundary>
        ) : null
      }
      tabPanel={tabPanel}
    />
  );
}

const NO_ATTENTION: ReadonlySet<never> = new Set();

/**
 * The map's foot: a notice when some of its reads failed (what it couldn't read, and *Try again*),
 * over the open tab's dock. Nothing when there is neither.
 */
function mapFoot(failures: MapFailures | null, dock: ReactNode): ReactNode {
  return (
    <>
      {/* Mounted with or without a failure, so the notice's words are announced as they come. */}
      <div
        className={cn(
          failures !== null &&
            'm-(--space-3) max-w-(--size-inspector) border border-solid border-line bg-panel p-(--space-2_5)',
        )}
      >
        <RetryNote
          data-for="body-map-reads"
          onRetry={failures?.retry}
          pending={failures?.pending ?? false}
        >
          {failures === null ? null : `The map couldn’t read ${listWords(failures.what)}`}
        </RetryNote>
      </div>
      {dock}
    </>
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
  const data = map.useData(bodyId, lit);
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

/**
 * Sets the map boost and puts its receipt (with Undo) in the toast. Resolves whether the change
 * landed, so the slider can go back to the record when it didn't.
 */
function useBoostCommit(bodyId: string): (value: number) => Promise<boolean> {
  const set = useMutation(api.waterBodies.setCuratedBoost);
  const { announce } = useUndo();
  return useCallback(
    (value: number) => {
      const rounded = Math.round(value * 10) / 10;
      const failed = (e: unknown) => toast({ title: errorText(e), tone: 'bad' });
      return set({ waterBodyId: bodyId as Id<'waterBodies'>, curatedBoost: rounded }).then(
        () =>
          announce({
            title: `Map boost · ${rounded.toFixed(1)}`,
            target: { targetType: 'waterbody', targetId: bodyId },
          }).then(
            () => true,
            // The boost landed; only its receipt didn't.
            (e: unknown) => {
              failed(e);
              return true;
            },
          ),
        (e: unknown) => {
          failed(e);
          return false;
        },
      );
    },
    [announce, bodyId, set],
  );
}
