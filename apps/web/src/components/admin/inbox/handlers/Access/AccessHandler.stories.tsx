import type { Meta, StoryObj } from '@storybook/react-vite';
import { type ReactNode, useRef } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { must } from '@/components/kit/storyKit';
import { ThemePair } from '../../../../../../.storybook/theme';
import { type DecidedState, InspectorFrame } from '../../../inspector/InspectorFrame';
import { InspectorProvider } from '../../../inspector/inspectorContext';
import { InboxMapStill } from '../../map/InboxMap';
import { ItemMapView } from '../../map/ItemMap';
import { ACCESS_MAP } from '../../map/itemMapFixtures';
import { type AccessHandlerProps, accessSlots } from './AccessHandlerView';
import {
  ACCESS_NOW,
  AFTER_NO_ACCESS,
  DISPUTE,
  FILED_BY_VIEWER,
  FIRST_REPORT,
  MANY,
  READ_ONLY,
} from './accessHandlerFixtures';
import type { AccessItem } from './accessModel';

/**
 * Board 2.2 and the other states an access item can be in, at the board's inspector width (788 px
 * at 1440), in both modes. The frame here is a stand-in for `InspectorFrame` (the pane head, the
 * scroller, the floating bar) — its own builder lands it; the slots are this handler's.
 */
const meta = {
  title: 'Admin/Inbox/Handlers/Access',
  parameters: { layout: 'fullscreen' },
  globals: { surface: 'admin' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** The inspector stand-in: a 36 px head, the scrolling body, the bar floating at the foot. */
function Inspector({
  item,
  onRule = async () => true,
  width = 788,
  height = 900,
  locked = null,
}: {
  item: AccessItem;
  locked?: DecidedState | null;
  onRule?: AccessHandlerProps['onRule'];
  width?: number;
  height?: number;
}) {
  const pane = useRef<HTMLElement | null>(null);
  const { head, actions, body } = accessSlots({
    item,
    now: ACCESS_NOW,
    // The item map, over its still: `inbox.itemMap`'s answer for Tomhannock.
    map: (
      <ItemMapView
        item={item}
        state={{ map: ACCESS_MAP, pending: false }}
        renderMap={(view) => (
          <InboxMapStill view={view} width={Math.min(336, width)} height={300} />
        )}
        timeZone="America/New_York"
      />
    ),
    bodyLink: <a href="/admin/body/wb_tomhannock?tab=access">Open in Body</a>,
    onRule,
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
        value={{ pane, decidedOnOpen: false, now: ACCESS_NOW, timeZone: 'America/New_York' }}
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
/** The dispute badge that is shown — in the head, or (no room there) over the body's line. */
const shownBadges = (root: ParentNode) =>
  [
    ...root.querySelectorAll<HTMLElement>(
      '[data-slot="access-head-badge"], [data-slot="access-body-badge"]',
    ),
  ].filter((b) => b.getClientRects().length > 0);
const expectBadge = async (root: ParentNode, text: string, where: 'head' | 'body' = 'head') => {
  const shown = shownBadges(root);
  await expect(shown).toHaveLength(1);
  await expect(shown[0]).toHaveTextContent(text);
  await expect(shown[0]?.dataset.slot).toBe(`access-${where}-badge`);
};
const quads = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('[data-theme-scope]')];

/** 2.2 as the board draws it: two reports disputing the standing accessible ruling. */
export const Dispute: Story = {
  render: () => pair(() => <Inspector item={DISPUTE} />),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      const s = within(q);
      await expectBadge(q, 'Disputes a ruling');
      await expect(s.getByText('Standing ruling')).toBeVisible();
      await expect(s.getByRole('button', { name: 'Clear the accessible ruling' })).toBeVisible();
      await expect(q.querySelector('[data-slot="body-map"]')).not.toBeNull();
      // Nothing runs off the pane sideways.
      const pane = must(q.querySelector<HTMLElement>('[data-pane="inspector"]'));
      await waitFor(() => expect(pane.scrollWidth).toBeLessThanOrEqual(pane.clientWidth));
    }
  },
};

/** A first report on a body nobody has ruled on: no badge, no ruling, nothing to clear. */
export const FirstReport: Story = {
  render: () => pair(() => <Inspector item={FIRST_REPORT} />),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      const s = within(q);
      await expect(shownBadges(q)).toHaveLength(0);
      await expect(s.getByText('No ruling yet')).toBeVisible();
      await expect(s.queryByRole('button', { name: /Clear/ })).toBeNull();
    }
  },
};

/** Reports after a standing no-public-access ruling: they don't dispute it. */
export const AfterNoAccess: Story = {
  render: () => pair(() => <Inspector item={AFTER_NO_ACCESS} />),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      await expectBadge(q, 'After a no-access ruling');
      await expect(
        within(q).getByRole('button', { name: 'Clear the no-access ruling' }),
      ).toBeVisible();
    }
  },
};

/** Six reporters, one of them the app. */
export const ManyReporters: Story = {
  render: () => pair(() => <Inspector item={MANY} />),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      await expect(within(q).getByText('Filed by the app')).toBeVisible();
      await expect(q.querySelectorAll('[data-mark="bad"]')).toHaveLength(6);
    }
  },
};

/** Decided by a colleague while open: the frame's lock, and no bar. */
export const DecidedByColleague: Story = {
  render: () =>
    pair(() => (
      <Inspector
        item={DISPUTE}
        locked={{
          by: 'Sarah Berman',
          at: ACCESS_NOW - 600_000,
          decisionWord: 'confirmed accessible',
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

/** A staffer who filed one of the reports (D289): every ruling refused, so no bar. */
export const FiledByViewer: Story = {
  render: () => pair(() => <Inspector item={FILED_BY_VIEWER} />),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      await expect(within(q).queryByRole('toolbar')).toBeNull();
      await expect(within(q).queryByRole('button', { name: /No public access/ })).toBeNull();
      // The item itself still reads whole.
      await expectBadge(q, 'Disputes a ruling');
    }
  },
};

/** After a no-access ruling: the contest asks are the middle figure. */
export const ContestAsks: Story = {
  render: () => pair(() => <Inspector item={AFTER_NO_ACCESS} />),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      const stat = must(q.querySelector<HTMLElement>('[data-stat="contest"]'));
      await expect(stat).toHaveTextContent('Ask for access back');
      await expect(stat).toHaveTextContent('2');
    }
  },
};

/** A viewer whose `can` refuses every verb: no bar. */
export const ReadOnly: Story = {
  render: () => pair(() => <Inspector item={READ_ONLY} />),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) await expect(within(q).queryByRole('toolbar')).toBeNull();
  },
};

/** A phone, under the narrow rule: the columns stack and nothing overflows at 360. */
export const Narrow: Story = {
  render: () => <Inspector item={DISPUTE} width={360} height={1400} />,
  play: async ({ canvasElement }) => {
    const pane = must(canvasElement.querySelector<HTMLElement>('[data-pane="inspector"]'));
    // The head, the body and the action bar keep to the page: the kit's bar takes its narrow layout
    // when the boards' bar is wider than the pane, and folds what doesn't fit under More.
    // Layout throughout, read until it settles: a measure taken before the fonts land is a fallback's.
    const right = pane.getBoundingClientRect().right + 0.5;
    await waitFor(() => {
      for (const slot of ['inbox-inspector-head', 'access-handler'])
        expect(
          must(pane.querySelector<HTMLElement>(`[data-slot="${slot}"]`)).getBoundingClientRect()
            .right,
        ).toBeLessThanOrEqual(right);
    });
    // The bar that is seen, not the kit's unseen measuring copy of the boards' bar.
    const bar = await waitFor(() =>
      must(
        [...pane.querySelectorAll<HTMLElement>('[role="toolbar"]')].find(
          (t) => t.closest('[data-slot="action-bar-measure"]') === null,
        ),
      ),
    );
    await waitFor(() => {
      expect(bar.getBoundingClientRect().right).toBeLessThanOrEqual(right);
      expect(bar.getBoundingClientRect().left).toBeGreaterThanOrEqual(
        pane.getBoundingClientRect().left - 0.5,
      );
    });
    // The map's zoom pair sits clear of the floating bar.
    const zoom = must(within(pane).queryByRole('button', { name: 'Zoom out' }));
    await waitFor(() =>
      expect(zoom.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        bar.getBoundingClientRect().top,
      ),
    );
    // *Disputes a ruling* is never truncated: with no room for it in the head, the head drops it
    // and the body shows it whole, over the body's line.
    const pill = await waitFor(() => {
      const shown = [
        ...pane.querySelectorAll<HTMLElement>(
          '[data-slot="access-head-badge"], [data-slot="access-body-badge"]',
        ),
      ].filter((b) => b.getClientRects().length > 0);
      expect(shown).toHaveLength(1);
      const only = must(shown[0]);
      expect(only.dataset.slot).toBe('access-body-badge');
      expect(only.scrollWidth).toBeLessThanOrEqual(only.clientWidth);
      expect(only.getBoundingClientRect().right).toBeLessThanOrEqual(right);
      return only;
    });
    await expect(pill).toHaveTextContent('Disputes a ruling');
    const map = must(canvasElement.querySelector<HTMLElement>('[data-slot="access-map"]'));
    const timeline = must(canvasElement.querySelector<HTMLElement>('[data-slot="item-timeline"]'));
    await waitFor(() =>
      expect(map.getBoundingClientRect().top).toBeGreaterThan(timeline.getBoundingClientRect().top),
    );
  },
};

/**
 * The keyboard path: C acts only while the inspector has focus; N opens the reason dialog, Esc
 * leaves it, ⌘⏎ sends the reason.
 */
export const Keys: Story = {
  args: { onRule: fn(async () => true) } as never,
  render: (args) => (
    <Inspector
      item={DISPUTE}
      onRule={(args as unknown as { onRule: AccessHandlerProps['onRule'] }).onRule}
    />
  ),
  play: async ({ canvasElement, args }) => {
    const onRule = (args as unknown as { onRule: ReturnType<typeof fn> }).onRule;
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.keyboard('c');
    await expect(onRule).not.toHaveBeenCalled();
    must(canvasElement.querySelector<HTMLElement>('[data-pane="inspector"]')).focus();
    await userEvent.keyboard('c');
    await waitFor(() => expect(onRule).toHaveBeenCalledWith('open'));

    must(canvasElement.querySelector<HTMLElement>('[data-pane="inspector"]')).focus();
    await userEvent.keyboard('n');
    await waitFor(() => expect(page.getByRole('alertdialog')).toBeVisible());
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(page.queryByRole('alertdialog')).toBeNull());

    must(canvasElement.querySelector<HTMLElement>('[data-pane="inspector"]')).focus();
    await userEvent.keyboard('n');
    const reason = await page.findByRole('textbox');
    await waitFor(() => expect(reason).toHaveFocus());
    await userEvent.keyboard('Posted by the water department');
    await userEvent.keyboard('{Meta>}{Enter}{/Meta}');
    await waitFor(() =>
      expect(onRule).toHaveBeenCalledWith('none', 'Posted by the water department'),
    );
    await waitFor(() => expect(page.queryByRole('alertdialog')).toBeNull());
  },
};
