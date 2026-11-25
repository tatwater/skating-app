import { type ReactNode, type RefObject, useLayoutEffect, useRef, useState } from 'react';

import { ThemePair } from '../../../../../.storybook/theme';
import { InboxMapStill } from '../../inbox/map/InboxMap';
import { InspectorProvider } from '../../inspector/inspectorContext';
import { CorpusHeadMapView, HEAD_MAP_MAX_ZOOM, type HeadMapState } from '../map/CorpusHeadMap';
import {
  GROTON_UNNAMED,
  GULF_ISLAND_POND,
  OSMORE_POND,
  TAYLOR_POND,
  THE_BASIN,
} from '../map/corpusMapFixtures';

/**
 * Story support for the 7a handlers (only stories import it): the inspector pane at the page's
 * width (720 × 830 px at 1440 × 900) with its context, both modes side by side, and the head map drawn as a
 * still over the boards' real outlines.
 */

export const STORY_ZONE = 'America/New_York';

/**
 * The inspector pane at 1440 × 900: what the rail (64), the lanes (236) and the list (420, the
 * boards') leave — 720 wide. The boards draw 744, their lanes column being 212.
 */
export const BOARD_PANE = { width: 720, height: 830 } as const;

export function StoryPane({
  now,
  width = BOARD_PANE.width,
  height = BOARD_PANE.height,
  children,
}: {
  now: number;
  width?: number;
  height?: number;
  children: (pane: RefObject<HTMLElement | null>) => ReactNode;
}) {
  const pane = useRef<HTMLElement | null>(null);
  return (
    <section
      ref={pane}
      tabIndex={-1}
      aria-label="Inspector"
      data-pane="inspector"
      className="relative flex overflow-hidden bg-bg outline-none"
      style={{ width, height }}
    >
      <InspectorProvider
        value={{ pane, decidedOnOpen: false, now, timeZone: STORY_ZONE, narrow: false }}
      >
        {children(pane)}
      </InspectorProvider>
    </section>
  );
}

export const pair = (ui: () => ReactNode) => (
  <ThemePair surface="admin" columns="one">
    {ui}
  </ThemePair>
);

export const quads = (root: HTMLElement) => [
  ...root.querySelectorAll<HTMLElement>('[data-theme-scope]'),
];

export const BASIN_MAP: HeadMapState = {
  body: { id: 'wbbasin', name: 'The Basin', outline: THE_BASIN },
  neighbors: [
    { id: 'wbtaylor', name: 'Taylor Pond', outline: TAYLOR_POND },
    { id: 'wbgulfisland', name: 'Gulf Island Pond', outline: GULF_ISLAND_POND },
  ],
};

export const GROTON_MAP: HeadMapState = {
  body: { id: 'wbgroton', name: '', outline: GROTON_UNNAMED },
  neighbors: [{ id: 'wbosmore', name: 'Osmore Pond', outline: OSMORE_POND }],
  outlineLabel: 'The outline · OSM',
};

/** When the stories' photograph was flown (Groton's NAIP scene: 22 June 2023). */
export const STORY_AERIAL_AT = Date.UTC(2023, 5, 22);

/**
 * A head map as a still: square beside the head (4.2) or a band across the pane (4.3, over the
 * summer aerial's stand-in: a story can't fetch the photograph).
 */
export function StillMap({
  state,
  height,
  width,
  square = false,
  aerial = false,
}: {
  state: HeadMapState;
  height: number;
  /** The still's width; a band without one is drawn at its pane's width, measured. */
  width?: number;
  square?: boolean;
  aerial?: boolean;
}) {
  return (
    <CorpusHeadMapView
      state={state}
      height={height}
      square={square}
      renderMap={(view) => (
        <MeasuredWidth width={width}>
          {(w) => (
            <InboxMapStill
              view={view}
              width={w}
              height={height}
              aerial={aerial}
              aerialCapturedAt={STORY_AERIAL_AT}
              maxZoom={HEAD_MAP_MAX_ZOOM}
            />
          )}
        </MeasuredWidth>
      )}
    />
  );
}

/** The given width, or its box's own, measured (and re-measured as the pane changes). */
function MeasuredWidth({
  width,
  children,
}: {
  width: number | undefined;
  children: (width: number) => ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [measured, setMeasured] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (width !== undefined || el === null) return;
    const read = () => setMeasured(el.clientWidth);
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [width]);
  if (width !== undefined) return children(width);
  return (
    <div ref={ref} className="w-full">
      {measured !== null && measured > 0 && children(measured)}
    </div>
  );
}
