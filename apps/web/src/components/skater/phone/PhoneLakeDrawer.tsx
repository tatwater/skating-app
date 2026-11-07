import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faXmark } from '@fortawesome/sharp-light-svg-icons';
import { useRouter } from '@tanstack/react-router';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { type PhoneDrawerSnap, useChromeStore } from '@/stores/chromeStore';
import { DRAWER_SNAP_POINTS, Drawer, DrawerContent, DrawerTitle } from '../../kit/drawer';
import { blockingModalOpen } from '../chrome';

import { useIsPhone } from './usePhoneLayout';

/**
 * A lake on a phone (boards 9.2–9.4): the lake's sidebar, unchanged, inside the kit Drawer over the
 * one region map. It opens at **half**, a drag takes it to **full** (under the top bar) and back,
 * and a swipe down past half closes the lake. At `md` and up it's a pass-through — the sidebar sits
 * in its column as it always has.
 *
 * - **The map stays live** behind it: a non-modal drawer, no scrim, scoped to the page area so it
 *   never covers the top bar or the tab bar. A press on the map is the map's, never a dismissal.
 * - **One Esc per screen** (Review 3): full → half → closed, one step per Esc. While something
 *   inside the lake owns Esc (`escapes` false — an action over a tab), the drawer stands aside.
 * - **Keyboard**: the grab bar is drawn, not a control, so a focusable toggle sits over it for
 *   half ↔ full; Close (the × on the kicker's line) closes the lake. Everything inside stays
 *   reachable at half, where the body scrolls.
 * - **Touch**: the head and the grab drag the sheet; the body scrolls.
 */
export function PhoneLakeDrawer({
  label,
  escapes = true,
  children,
}: {
  /** The lake's (or bay's) name: the drawer's accessible title. */
  label: string;
  /** False while something inside owns Esc (an action open over a tab). */
  escapes?: boolean;
  children: ReactNode;
}) {
  const phone = useIsPhone();
  if (!phone) return <>{children}</>;
  return (
    <LakeDrawer label={label} escapes={escapes}>
      {children}
    </LakeDrawer>
  );
}

/** The store's snap names, as the kit's snap points. */
export const SNAP_POINT: Record<PhoneDrawerSnap, number> = {
  half: DRAWER_SNAP_POINTS[0] as number,
  full: DRAWER_SNAP_POINTS[1] as number,
};

export function snapName(point: unknown): PhoneDrawerSnap {
  return point === SNAP_POINT.full ? 'full' : 'half';
}

/** Close reasons that don't close a lake: the map is live beside it, and Esc steps the ladder. */
const KEEP_OPEN = new Set<string>(['escape-key', 'outside-press', 'focus-out']);

function LakeDrawer({
  label,
  escapes,
  children,
}: {
  label: string;
  escapes: boolean;
  children: ReactNode;
}) {
  const router = useRouter();
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const snap = useChromeStore((s) => s.phoneDrawerSnap);
  const setSnap = useChromeStore((s) => s.setPhoneDrawerSnap);

  // Every lake opens at half: the map keeps the top of the screen until the skater asks for more.
  useEffect(() => {
    useChromeStore.getState().setPhoneDrawerSnap('half');
  }, []);

  const close = useRef(() => router.history.push('/'));
  close.current = () => router.history.push('/');

  useEffect(() => {
    if (!escapes) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (blockingModalOpen()) return;
      event.preventDefault();
      if (useChromeStore.getState().phoneDrawerSnap === 'full') setSnap('half');
      else close.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [escapes, setSnap]);

  const full = snap === 'full';
  return (
    <div className="contents">
      {/* The drawer's ground: the page area over the map, passing presses through to it. */}
      <div
        ref={setHost}
        data-slot="phone-lake-host"
        className="pointer-events-none absolute inset-0"
      />
      {host !== null && (
        <Drawer
          open
          modal={false}
          snapPoints={DRAWER_SNAP_POINTS}
          snapPoint={SNAP_POINT[snap]}
          onSnapPointChange={(point) => setSnap(snapName(point))}
          onOpenChange={(next, details) => {
            // The drawer stays open (it's controlled): Esc is the ladder's above, and a press on
            // the map or focus leaving for it is the map's. Only a swipe down closes the lake.
            if (!next && !KEEP_OPEN.has(details.reason)) close.current();
          }}
        >
          <DrawerContent
            container={host}
            scrim={false}
            data-slot="phone-lake-drawer"
            className={
              // The page area is the drawer's whole height (it already sits under the top bar);
              // the sidebar loses its column rule; its body takes touch scrolling back.
              'h-full shadow-sheet [&_[data-slot=lake-sidebar]]:border-r-0 [&_[data-slot=scroll-area-viewport]]:touch-auto'
            }
          >
            <DrawerTitle className="sr-only">{label}</DrawerTitle>
            <button
              type="button"
              data-attr="phone-lake-snap"
              aria-label={full ? `Show less of ${label}` : `Show more of ${label}`}
              aria-expanded={full}
              onClick={() => setSnap(full ? 'half' : 'full')}
              // Over the grab bar, for a keyboard: presses pass through, so a drag still drags.
              className="pointer-events-none absolute inset-x-0 top-0 h-(--space-4_5) rounded-control border-0 bg-transparent p-0 outline-none focus-visible:shadow-focus"
            />
            <button
              type="button"
              data-attr="phone-lake-close"
              aria-label={`Close ${label}`}
              onClick={() => close.current()}
              className="absolute top-(--space-4) right-(--space-2_5) z-(--z-raised) flex size-7 cursor-pointer items-center justify-center rounded-control border-0 bg-transparent p-0 text-fg2 outline-none hover:text-fg focus-visible:shadow-focus"
            >
              <FontAwesomeIcon icon={faXmark} aria-hidden="true" className="h-3.25" />
            </button>
            <div className="flex min-h-0 flex-1 flex-col">{children}</div>
          </DrawerContent>
        </Drawer>
      )}
    </div>
  );
}
