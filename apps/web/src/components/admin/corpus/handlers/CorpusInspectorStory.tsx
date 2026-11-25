import { type ReactNode, type RefObject, useRef } from 'react';

import { ThemePair } from '../../../../../.storybook/theme';
import { InboxMapStill } from '../../inbox/map/InboxMap';
import { InspectorProvider } from '../../inspector/inspectorContext';
import { CorpusHeadMapView, type HeadMapState } from '../map/CorpusHeadMap';
import {
  GROTON_UNNAMED,
  GULF_ISLAND_POND,
  OSMORE_POND,
  TAYLOR_POND,
  THE_BASIN,
} from '../map/corpusMapFixtures';

/**
 * Story support for the 6a handlers (only stories import it): the inspector pane at the board's
 * width (788 px at 1440) with its context, both modes side by side, and the head map drawn as a
 * still over the boards' real outlines.
 */

export const STORY_ZONE = 'America/New_York';

export function StoryPane({
  now,
  width = 788,
  height = 900,
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

/** A head map as a still: square beside the head (4.2) or a band across the pane (4.3). */
export function StillMap({
  state,
  height,
  width,
  square = false,
}: {
  state: HeadMapState;
  height: number;
  width: number;
  square?: boolean;
}) {
  return (
    <CorpusHeadMapView
      state={state}
      height={height}
      square={square}
      renderMap={(view) => <InboxMapStill view={view} width={width} height={height} />}
    />
  );
}
