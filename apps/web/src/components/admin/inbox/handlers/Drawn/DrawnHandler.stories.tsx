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
  BARE_SKATE,
  BELOW_THRESHOLD,
  DRAWN_BY_VIEWER,
  DRAWN_DECIDED,
  DRAWN_MERGED,
  DRAWN_NOW,
  DRAWN_UNMERGING,
  LONG_REPORT,
  MODERATOR_VIEW,
  NEW_WATER,
  OVER_CASPIAN,
  REPORT_WITHHELD,
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
          map: {
            ...(item.overlap === null
              ? { ...DRAWN_MAP, others: [], overlapShare: null }
              : DRAWN_MAP),
            // The skate's track only where the item serves a skate that left one, as the server sends it.
            tracks: item.skate?.hasTrack === true ? DRAWN_MAP.tracks : [],
          },
          pending: false,
        }}
        renderMap={(view) => <InboxMapStill view={view} width={width} viewOnly={narrow} />}
        timeZone="America/New_York"
      />
    ),
    bodyLink: <a href="/admin/body/wb_drawn">Open in Body</a>,
    onMerge: async () => true,
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
      await expect(s.getByRole('blockquote')).toHaveTextContent('Skated the east arm');
      await expect(s.getByText('Trusted · 41 pts · 14 reports')).toBeVisible();
      await expect(s.getByText('1h 36m · 11 Oct 09:00–11:00')).toBeVisible();
      // The section's title reads whole: nothing at its rule's end crowds it.
      const title = must(
        s
          .getByRole('region', { name: 'The report it came from' })
          .querySelector<HTMLElement>('h2, h3, h4'),
      );
      // Layout, read until it settles: a measure taken before the fonts land is a fallback's.
      await waitFor(() => expect(title.scrollWidth).toBeLessThanOrEqual(title.clientWidth + 1));
      // The live lever: the server's survivor, its key M, and the block saying what moves.
      const merge = s.getByRole('button', { name: 'Merge into Caspian Lake' });
      await expect(merge).toHaveAttribute('aria-keyshortcuts', 'M');
      await expect(merge).not.toHaveAttribute('data-unavailable-title');
      await expect(
        s.getByRole('region', { name: 'If merged into Caspian Lake' }),
      ).toHaveTextContent('Told it was merged');
      await expect(s.getByRole('button', { name: 'Approve as new' })).toBeVisible();
      await expect(s.getByRole('button', { name: 'Reject' })).toBeVisible();
      await expect(q.querySelector('[data-slot="body-map"]')).not.toBeNull();
      const pane = must(q.querySelector<HTMLElement>('[data-pane="inspector"]'));
      // Layout, read until it settles: a measure taken before the fonts land is a fallback's.
      await waitFor(() => expect(pane.scrollWidth).toBeLessThanOrEqual(pane.clientWidth));
    }
  },
};

/** The report the drawing came from, hidden or withdrawn to this viewer: its words withheld. */
export const ReportWithheld: Story = {
  render: () => pair(() => <Inspector item={REPORT_WITHHELD} />),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      const report = within(q).getByRole('region', { name: 'The report it came from' });
      await expect(within(report).queryByRole('blockquote')).toBeNull();
      await expect(within(report).getByText(/Its words aren’t shown/)).toBeVisible();
      await expect(within(report).getByRole('button', { name: /Open in Reports/ })).toBeVisible();
    }
  },
};

/** A long report: the server's cut at 100 characters, drawn whole as the excerpt it is. */
export const LongReport: Story = {
  render: () => pair(() => <Inspector item={LONG_REPORT} />),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      const quote = within(q).getByRole('blockquote');
      await expect(quote.textContent?.endsWith('…”')).toBe(true);
      // Never clipped sideways: it wraps inside its column.
      await waitFor(() => expect(quote.scrollWidth).toBeLessThanOrEqual(quote.clientWidth + 1));
    }
  },
};

/** No report, a skate with no end or moving time, a drawer with no count served. */
export const BareSkate: Story = {
  render: () => pair(() => <Inspector item={BARE_SKATE} />),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      const report = within(q).getByRole('region', { name: 'The report it came from' });
      await expect(within(report).getByText('No report is linked to this drawing')).toBeVisible();
      await expect(within(report).getByText('11 Oct 09:00')).toBeVisible();
      await expect(within(report).getByText('Trusted · 41 pts')).toBeVisible();
    }
  },
};

/** Short of the threshold: the label quiet; a merge still drawn, the server allowing it. */
export const BelowThreshold: Story = {
  render: () => pair(() => <Inspector item={BELOW_THRESHOLD} />),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      await expect(within(q).getByRole('meter')).toHaveAttribute('aria-valuenow', '41');
      await expect(
        must(q.querySelector('[data-slot="overlap-gauge-threshold"]')).hasAttribute('data-reached'),
      ).toBe(false);
      await expect(
        within(q).getByRole('button', { name: 'Merge into Caspian Lake' }),
      ).toBeVisible();
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

/** An unmerge still runs on it: Merge held back in the server's sentence; approve and reject stay. */
export const Unmerging: Story = {
  render: () => pair(() => <Inspector item={DRAWN_UNMERGING} />),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      await expect(within(q).queryByRole('button', { name: /Merge/ })).toBeNull();
      await expect(within(q).getByRole('button', { name: 'Approve as new' })).toBeVisible();
      await expect(within(q).getByRole('note')).toHaveTextContent(
        'This body is still being unmerged. Merge it once that finishes.',
      );
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

/** Merged by a colleague: the lock, no bar, no lever. */
export const MergedByColleague: Story = {
  render: () =>
    pair(() => (
      <Inspector
        item={DRAWN_MERGED}
        locked={{
          by: 'Sarah Berman',
          at: DRAWN_NOW - 600_000,
          decision: 'merged',
          byMe: false,
          actionId: 'a2',
        }}
      />
    )),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      await expect(q.querySelector('[data-slot="inbox-inspector-lock"]')).not.toBeNull();
      await expect(within(q).queryByRole('toolbar')).toBeNull();
      await expect(within(q).queryByRole('button', { name: /Merge/ })).toBeNull();
    }
  },
};

/** A phone (360): one column, the map view-only, the bar spanning the page. */
export const Narrow: Story = {
  render: () => pair(() => <Inspector item={OVER_CASPIAN} width={360} height={1500} narrow />),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      const pane = must(q.querySelector<HTMLElement>('[data-pane="inspector"]'));
      // The view-only map draws no zoom pair.
      await expect(within(pane).queryByRole('button', { name: 'Zoom out' })).toBeNull();
      // Layout throughout, read and asserted in one retry once it has settled (a measure taken
      // before the fonts land is a fallback's): every block keeps to the page, the report and the
      // merge block stack, and the bar keeps to the page in its narrow form.
      await waitFor(() => {
        const right = pane.getBoundingClientRect().right + 0.5;
        for (const slot of ['inbox-inspector-head', 'drawn-handler', 'overlap-gauge'])
          expect(
            must(pane.querySelector<HTMLElement>(`[data-slot="${slot}"]`)).getBoundingClientRect()
              .right,
          ).toBeLessThanOrEqual(right);
        const report = must(pane.querySelector<HTMLElement>('[data-slot="drawn-report"]'));
        const merged = must(pane.querySelector<HTMLElement>('[data-slot="drawn-if-merged"]'));
        expect(merged.getBoundingClientRect().top).toBeGreaterThan(
          report.getBoundingClientRect().bottom - 1,
        );
        const bar = must(seenBar(pane));
        expect(bar.getBoundingClientRect().right).toBeLessThanOrEqual(right);
        expect(bar.getBoundingClientRect().left).toBeGreaterThanOrEqual(
          pane.getBoundingClientRect().left - 0.5,
        );
      });
    }
  },
};
