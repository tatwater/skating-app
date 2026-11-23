import { AROUND_IT_DEFAULT_DAYS } from '@skating/core';
import { type ReactNode, useRef, useState } from 'react';

import { createToastManager, Toaster } from '@/components/kit/toast';

import { UndoProvider, type UndoServer } from '../../../shell/undo';
import type { AroundState } from '../../around/AroundLine';
import { AroundSheet } from '../../around/AroundSheet';
import { storyLink } from '../../inboxBoard';
import { AuthorMenuView, type MenuLever } from '../../inspector/AuthorMenu';
import type { HandlerKey, InboxHandler } from '../../inspector/handlerRegistry';
import { InspectorFrame } from '../../inspector/InspectorFrame';
import { InspectorProvider, useInspectorContext } from '../../inspector/inspectorContext';
import { decidedStateOf } from '../../inspector/lockModel';
import { flagSlots } from './FlagView';
import { BOARD_NOW, BOARD_ZONE } from './flagFixtures';
import type { FlagItem } from './flagTypes';
import type { WeatherState } from './parts';
import { PHOTO_REVEAL } from './photoFixtures';
import { PhotoRevealContext } from './photoRevealContext';
import type { FlagWrite } from './useFlagWrites';

/**
 * **Story support for the flag handler**: the handler drawn from fixtures inside W1's real
 * `InspectorFrame` — alone, at the boards' inspector size (788 × 874 of the 1440 × 900 board), or in
 * the whole Inbox page through a story registry — with the drawer over fixture reads and the map's
 * slot held by a stand-in (W3's embed fills it in the app). Only stories import this.
 */

/** The map slot's stand-in: W3's embed fills it in the app. */
export function MapStandIn() {
  return (
    <div
      data-slot="map-stand-in"
      className="h-[18.75rem] bg-panel @[45rem]:absolute @[45rem]:inset-0 @[45rem]:h-auto"
    />
  );
}

export type FlagFixtureReads = {
  weather?: WeatherState;
  around?: AroundState;
  /** The drawer's answers, by days (1, 3, 7). */
  drawer?: Partial<Record<number, AroundState>>;
  map?: boolean;
  /** What the map slot holds instead of the stand-in (a story's `ItemMapView` over fixtures). */
  mapSlot?: ReactNode;
  levers?: readonly MenuLever[];
  onWrite: (write: FlagWrite) => Promise<boolean>;
  /** *Try again* on a failed context read. */
  onRetry?: () => void;
};

const HAS_PLACE = new Set(['report', 'hazard', 'accessAlert', 'waterbody']);

/** The handler over fixtures, inside the real frame (the inspector's context gives the pane). */
export function StoryFlagInspector({
  item,
  now,
  weather,
  around,
  drawer = {},
  map = true,
  mapSlot,
  levers,
  onWrite,
  onRetry,
}: FlagFixtureReads & { item: FlagItem; now: number }) {
  const { pane } = useInspectorContext();
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState<number>(AROUND_IT_DEFAULT_DAYS);
  const author = item.author;
  // The boards' zone, whatever zone the story runs in (the fixtures are absolute instants in it).
  const { head, actions, body } = flagSlots({
    timeZone: BOARD_ZONE,
    item,
    now,
    ...(weather !== undefined && { weather }),
    ...(around !== undefined && { around }),
    onCompare: () => setOpen(true),
    ...(onRetry !== undefined && { retry: { onRetry } }),
    ...(map &&
      item.target.exists &&
      HAS_PLACE.has(item.target.targetType) && { map: mapSlot ?? <MapStandIn /> }),
    onWrite,
    pane,
    bodyLink: (id) => storyLink(`/admin/body/${id}`),
    ...(author !== null &&
      !author.person.deleted && {
        authorMenu: (
          <AuthorMenuView
            name={author.person.displayName}
            levers={levers ?? []}
            onPick={() => {}}
            peopleHref={`/admin/people/${author.person.userId}`}
          />
        ),
      }),
  });
  return (
    <>
      <InspectorFrame
        head={head}
        actions={actions}
        locked={item.decided === null ? null : decidedStateOf(item.decided)}
      >
        {body}
      </InspectorFrame>
      {item.target.exists && item.target.targetType === 'report' && around !== undefined && (
        <AroundSheet
          open={open}
          onOpenChange={setOpen}
          state={drawer[days] ?? (days === AROUND_IT_DEFAULT_DAYS ? around : 'loading')}
          bodyName={item.target.report.body.name}
          days={days}
          onDays={setDays}
          safety={item.lane === 'safety'}
          timeZone={BOARD_ZONE}
          onRetry={onRetry}
        />
      )}
    </>
  );
}

const NO_UNDO: UndoServer = { latestOwn: async () => null, run: async () => {} };

export type FlagBoardProps = FlagFixtureReads & { item: FlagItem; now?: number };

/** The handler alone, in an inspector pane at the boards' size. */
export function FlagBoard({ item, now = BOARD_NOW, ...reads }: FlagBoardProps) {
  const pane = useRef<HTMLElement>(null);
  const [manager] = useState(createToastManager);
  return (
    <UndoProvider server={NO_UNDO} manager={manager}>
      <InspectorProvider
        value={{ pane, decidedOnOpen: false, now, timeZone: BOARD_ZONE, linkFor: storyLink }}
      >
        <section
          ref={pane}
          tabIndex={-1}
          aria-label="Inspector"
          data-slot="story-inspector"
          className="relative flex h-[54.625rem] w-[49.25rem] max-w-full flex-col overflow-hidden border-0 border-s border-solid border-line bg-bg font-(family-name:--family-sans) text-fg outline-none"
        >
          {/* A photo's full image answered from the fixtures, on Show only (as `inbox.photoReveal`). */}
          <PhotoRevealContext.Provider value={PHOTO_REVEAL}>
            <StoryFlagInspector item={item} now={now} {...reads} />
          </PhotoRevealContext.Provider>
        </section>
      </InspectorProvider>
      <Toaster manager={manager} />
    </UndoProvider>
  );
}

/** A story registry: every flag key drawn by the fixture handler (for the whole-page board). */
export function storyFlagRegistry(reads: FlagFixtureReads): ReadonlyMap<HandlerKey, InboxHandler> {
  const Handler: InboxHandler = ({ item, now }) =>
    item.kind === 'flag' ? <StoryFlagInspector item={item} now={now} {...reads} /> : null;
  const keys: HandlerKey[] = [
    'flag:report',
    'flag:post',
    'flag:comment',
    'flag:hazard',
    'flag:photo',
    'flag:accessAlert',
    'flag:waterbody',
    'flag:user',
  ];
  return new Map(keys.map((k) => [k, Handler]));
}
