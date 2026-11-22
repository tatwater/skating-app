import type { Meta, StoryObj } from '@storybook/react-vite';
import { type ReactNode, useRef } from 'react';
import { expect, waitFor, within } from 'storybook/test';

import { must } from '@/components/kit/storyKit';
import { ThemePair } from '../../../../../../.storybook/theme';
import { type DecidedState, InspectorFrame } from '../../inspector/InspectorFrame';
import { InspectorProvider } from '../../inspector/inspectorContext';
import { InboxMapStill } from '../../map/InboxMap';
import { ItemMapView } from '../../map/ItemMap';
import { PLACE_MAP } from '../../map/itemMapFixtures';
import { placeSlots } from './PlaceHandlerView';
import {
  BAY_DRAWN,
  BAY_UNDRAWN,
  LANDMARK_ALONE,
  NARROWS,
  PLACE_BY_VIEWER,
  PLACE_DECIDED,
  PLACE_NOW,
} from './placeFixtures';
import type { PlaceItem } from './placeModel';

/**
 * Board 2.4 and the other states a place ask can be in (a landmark with nothing like it, a bay
 * undrawn and drawn, the viewer's own, decided), at the board's inspector width (788 px at 1440) in
 * both modes, and at a phone's 360. The real `InspectorFrame` around the handler's slots; the map
 * is `inbox.itemMap`'s answer for the Narrows, drawn as a still.
 */
const meta = {
  title: 'Admin/Inbox/Handlers/Place',
  parameters: { layout: 'fullscreen' },
  globals: { surface: 'admin' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

function Inspector({
  item,
  width = 788,
  height = 900,
  locked = null,
  narrow = false,
}: {
  item: PlaceItem;
  width?: number;
  height?: number;
  locked?: DecidedState | null;
  narrow?: boolean;
}) {
  const pane = useRef<HTMLElement | null>(null);
  const { head, actions, body } = placeSlots({
    item,
    now: PLACE_NOW,
    map: (
      <ItemMapView
        item={item}
        state={{ map: PLACE_MAP, pending: false }}
        renderMap={(view) => (
          <InboxMapStill view={view} width={narrow ? width : 380} height={290} viewOnly={narrow} />
        )}
        timeZone="America/New_York"
      />
    ),
    bodyLink: <a href="/admin/body/wb_newfound?tab=places">Open in Body</a>,
    editorHref: '/admin/water/wb_newfound',
    onSamePlace: async () => true,
    onApprove: async () => true,
    onDecline: async () => true,
    pending: null,
    pane,
    timeZone: 'America/New_York',
  });
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
        value={{ pane, decidedOnOpen: false, now: PLACE_NOW, timeZone: 'America/New_York', narrow }}
      >
        <InspectorFrame head={head} actions={actions} locked={locked}>
          {body}
        </InspectorFrame>
      </InspectorProvider>
    </section>
  );
}

const pair = (ui: () => ReactNode) => (
  <ThemePair surface="admin" columns="one">
    {ui}
  </ThemePair>
);
const quads = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('[data-theme-scope]')];
const seenBar = (root: ParentNode) =>
  [...root.querySelectorAll<HTMLElement>('[role="toolbar"]')].find(
    (t) => t.closest('[data-slot="action-bar-measure"]') === null,
  );

/** 2.4 as the board draws it: "the Narrows" against The Narrows in OpenStreetMap. */
export const Lookalike: Story = {
  render: () => pair(() => <Inspector item={NARROWS} />),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      const s = within(q);
      await expect(s.getByRole('table', { name: 'Same place?' })).toBeVisible();
      await expect(s.getByRole('button', { name: 'Same place' })).toBeVisible();
      await expect(s.getByRole('button', { name: 'Draw in Body →' })).toBeVisible();
      await expect(s.getByRole('button', { name: 'Decline' })).toBeVisible();
      await expect(q.querySelector('[data-slot="body-map"]')).not.toBeNull();
      // The map sits beside the where at the board's width.
      const map = must(q.querySelector<HTMLElement>('[data-slot="place-map"]'));
      const line = must(q.querySelector<HTMLElement>('[data-slot="place-body-line"]'));
      const pane = must(q.querySelector<HTMLElement>('[data-pane="inspector"]'));
      // Layout, read until it settles: a measure taken before the fonts land is a fallback's.
      await waitFor(() => {
        expect(map.getBoundingClientRect().left).toBeGreaterThan(
          line.getBoundingClientRect().right,
        );
        expect(pane.scrollWidth).toBeLessThanOrEqual(pane.clientWidth);
      });
    }
  },
};

/** A landmark ask with nothing like it: Draw in Body, or decline. */
export const NothingLikeIt: Story = {
  render: () => pair(() => <Inspector item={LANDMARK_ALONE} />),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      await expect(within(q).queryByRole('table')).toBeNull();
      await expect(within(q).queryByRole('button', { name: 'Same place' })).toBeNull();
    }
  },
};

/** A bay ask, three askers, no bay drawn: the shared ask list, Draw in Body. */
export const BayUndrawn: Story = {
  render: () => pair(() => <Inspector item={BAY_UNDRAWN} />),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      const s = within(q);
      await expect(s.getByRole('region', { name: 'Asked by' })).toBeVisible();
      await expect(s.queryByRole('region', { name: 'Same place?' })).toBeNull();
      await expect(s.getByRole('button', { name: 'Draw in Body →' })).toBeVisible();
      await expect(s.queryByRole('button', { name: 'Approve' })).toBeNull();
    }
  },
};

/** The bay drawn now: Approve. */
export const BayDrawn: Story = {
  render: () => pair(() => <Inspector item={BAY_DRAWN} />),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      await expect(within(q).getByRole('button', { name: 'Approve' })).toBeVisible();
      await expect(within(q).getByRole('region', { name: 'If approved' })).toBeVisible();
    }
  },
};

/** The viewer asked it: no bar, the refusal said once. */
export const AskedByViewer: Story = {
  render: () => pair(() => <Inspector item={PLACE_BY_VIEWER} />),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      await expect(within(q).queryByRole('toolbar')).toBeNull();
      await expect(within(q).getByText(/You filed this/)).toBeVisible();
    }
  },
};

/** Decided by a colleague: the lock, and no bar. */
export const DecidedByColleague: Story = {
  render: () =>
    pair(() => (
      <Inspector
        item={PLACE_DECIDED}
        locked={{
          by: 'Sarah Berman',
          at: PLACE_NOW - 600_000,
          decision: 'approved',
          byMe: false,
          actionId: 'a1',
        }}
      />
    )),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      await expect(q.querySelector('[data-slot="inbox-inspector-lock"]')).not.toBeNull();
      await expect(within(q).queryByRole('toolbar')).toBeNull();
    }
  },
};

/** A phone (360): one column, the map under the where and view-only, the bar spanning the page. */
export const Narrow: Story = {
  render: () => pair(() => <Inspector item={NARROWS} width={360} height={1700} narrow />),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      const pane = must(q.querySelector<HTMLElement>('[data-pane="inspector"]'));
      const right = pane.getBoundingClientRect().right + 0.5;
      for (const slot of ['inbox-inspector-head', 'place-handler', 'compare-table'])
        await expect(
          must(pane.querySelector<HTMLElement>(`[data-slot="${slot}"]`)).getBoundingClientRect()
            .right,
        ).toBeLessThanOrEqual(right);
      await expect(within(pane).queryByRole('button', { name: 'Zoom out' })).toBeNull();
      const map = must(pane.querySelector<HTMLElement>('[data-slot="place-map"]'));
      const line = must(pane.querySelector<HTMLElement>('[data-slot="place-body-line"]'));
      await expect(map.getBoundingClientRect().top).toBeGreaterThan(
        line.getBoundingClientRect().bottom,
      );
      await waitFor(() => {
        const bar = must(seenBar(pane));
        expect(bar.getBoundingClientRect().right).toBeLessThanOrEqual(right);
        expect(bar.getBoundingClientRect().left).toBeGreaterThanOrEqual(
          pane.getBoundingClientRect().left - 0.5,
        );
      });
    }
  },
};
