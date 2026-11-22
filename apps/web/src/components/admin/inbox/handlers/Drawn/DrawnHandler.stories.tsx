import type { Meta, StoryObj } from '@storybook/react-vite';
import { type ReactNode, useRef } from 'react';
import { expect, waitFor, within } from 'storybook/test';

import { must } from '@/components/kit/storyKit';
import { ThemePair } from '../../../../../../.storybook/theme';
import { type DecidedState, InspectorFrame } from '../../inspector/InspectorFrame';
import { InspectorProvider } from '../../inspector/inspectorContext';
import { InboxMapStill } from '../../map/InboxMap';
import { ItemMapView } from '../../map/ItemMap';
import { DRAWN_MAP } from '../../map/itemMapFixtures';
import { drawnSlots } from './DrawnHandlerView';
import {
  BELOW_THRESHOLD,
  DRAWN_BY_VIEWER,
  DRAWN_DECIDED,
  DRAWN_NOW,
  MODERATOR_VIEW,
  NEW_WATER,
  OVER_CASPIAN,
} from './drawnFixtures';
import type { DrawnItem } from './drawnModel';

/**
 * Board 2.5 and the other states a drawn item can be in, at the board's inspector width (788 px at
 * 1440) in both modes, and at a phone's 360. The real `InspectorFrame` around the handler's slots;
 * the map is `inbox.itemMap`'s answer for Caspian Lake, drawn as a still.
 */
const meta = {
  title: 'Admin/Inbox/Handlers/Drawn',
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
  item: DrawnItem;
  width?: number;
  height?: number;
  locked?: DecidedState | null;
  narrow?: boolean;
}) {
  const pane = useRef<HTMLElement | null>(null);
  const { head, actions, body } = drawnSlots({
    item,
    now: DRAWN_NOW,
    map: (
      <ItemMapView
        item={item}
        state={{
          map: item.overlap === null ? { ...DRAWN_MAP, others: [], overlapShare: null } : DRAWN_MAP,
          pending: false,
        }}
        renderMap={(view) => <InboxMapStill view={view} width={width} viewOnly={narrow} />}
        timeZone="America/New_York"
      />
    ),
    bodyLink: <a href="/admin/body/wb_drawn">Open in Body</a>,
    editorLink: <a href="/admin/water/wb_drawn">Old editor</a>,
    onApprove: async () => true,
    onReject: async () => true,
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
        value={{ pane, decidedOnOpen: false, now: DRAWN_NOW, timeZone: 'America/New_York', narrow }}
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
/** The bar that is seen, not the kit's unseen measuring copy. */
const seenBar = (root: ParentNode) =>
  [...root.querySelectorAll<HTMLElement>('[role="toolbar"]')].find(
    (t) => t.closest('[data-slot="action-bar-measure"]') === null,
  );

/** 2.5 as the board draws it: 92 % of the drawing is Caspian Lake. */
export const OverCaspian: Story = {
  render: () => pair(() => <Inspector item={OVER_CASPIAN} />),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      const s = within(q);
      await expect(s.getByRole('meter', { name: 'Of the drawing is Caspian Lake' })).toBeVisible();
      await expect(s.getByRole('region', { name: 'If merged into Caspian Lake' })).toBeVisible();
      const merge = s.getByRole('button', { name: /Merge into Caspian Lake/ });
      await expect(merge).toHaveAttribute('data-unavailable-title', 'Coming soon');
      await expect(s.getByRole('button', { name: 'Approve as new' })).toBeVisible();
      await expect(s.getByRole('button', { name: 'Reject' })).toBeVisible();
      await expect(q.querySelector('[data-slot="body-map"]')).not.toBeNull();
      const pane = must(q.querySelector<HTMLElement>('[data-pane="inspector"]'));
      // Layout, read until it settles: a measure taken before the fonts land is a fallback's.
      await waitFor(() => expect(pane.scrollWidth).toBeLessThanOrEqual(pane.clientWidth));
    }
  },
};

/** Short of the threshold: the label quiet; a merge still drawn (Coming soon). */
export const BelowThreshold: Story = {
  render: () => pair(() => <Inspector item={BELOW_THRESHOLD} />),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      await expect(within(q).getByRole('meter')).toHaveAttribute('aria-valuenow', '41');
      await expect(
        must(q.querySelector('[data-slot="overlap-gauge-threshold"]')).hasAttribute('data-reached'),
      ).toBe(false);
    }
  },
};

/** Over no body: no gauge, no merge block, no merge lever. */
export const NewWater: Story = {
  render: () => pair(() => <Inspector item={NEW_WATER} />),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      const s = within(q);
      await expect(s.queryByRole('meter')).toBeNull();
      await expect(s.getByText('It overlaps no body on the map')).toBeVisible();
      await expect(s.queryByRole('button', { name: /Merge/ })).toBeNull();
    }
  },
};

/** A moderator the server refuses a merge: Approve and Reject only. */
export const ModeratorView: Story = {
  render: () => pair(() => <Inspector item={MODERATOR_VIEW} />),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement))
      await expect(within(q).queryByRole('button', { name: /Merge/ })).toBeNull();
  },
};

/** The viewer drew it: no bar, the refusal said once. */
export const DrawnByViewer: Story = {
  render: () => pair(() => <Inspector item={DRAWN_BY_VIEWER} />),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      await expect(within(q).queryByRole('toolbar')).toBeNull();
      await expect(within(q).getByRole('note')).toHaveTextContent('You filed this');
    }
  },
};

/** Decided by a colleague: the lock, and no bar. */
export const DecidedByColleague: Story = {
  render: () =>
    pair(() => (
      <Inspector
        item={DRAWN_DECIDED}
        locked={{
          by: 'Sarah Berman',
          at: DRAWN_NOW - 600_000,
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

/** A phone (360): one column, the map view-only, the bar spanning the page. */
export const Narrow: Story = {
  render: () => pair(() => <Inspector item={OVER_CASPIAN} width={360} height={1500} narrow />),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      const pane = must(q.querySelector<HTMLElement>('[data-pane="inspector"]'));
      const right = pane.getBoundingClientRect().right + 0.5;
      for (const slot of ['inbox-inspector-head', 'drawn-handler', 'overlap-gauge'])
        await expect(
          must(pane.querySelector<HTMLElement>(`[data-slot="${slot}"]`)).getBoundingClientRect()
            .right,
        ).toBeLessThanOrEqual(right);
      // The view-only map draws no zoom pair.
      await expect(within(pane).queryByRole('button', { name: 'Zoom out' })).toBeNull();
      // The report and the merge block stack.
      const report = must(pane.querySelector<HTMLElement>('[data-slot="drawn-report"]'));
      const merged = must(pane.querySelector<HTMLElement>('[data-slot="drawn-if-merged"]'));
      await expect(merged.getBoundingClientRect().top).toBeGreaterThan(
        report.getBoundingClientRect().bottom - 1,
      );
      // The bar keeps to the page, read in one retry once it has settled its narrow form.
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
