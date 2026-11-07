import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { must } from '../../kit/storyKit';
import { SkaterPair } from '../storySupport';
import {
  CardHead,
  InsetCard,
  PanelColumn,
  PanelLoading,
  PanelUnavailable,
  PlaceGlyph,
} from './InsetCard';
import { panelTriggerProps } from './panelNavigation';

/**
 * The inset card (B03 §1.8): the frame every panel opens in, over the lake's sidebar. Its states are
 * 2.8 (loading) and 2.9 (unavailable); the keyboard story is the focus mechanic — in by hand on open,
 * Esc out, back on the row that opened it.
 */
const meta = {
  title: 'Skater/Panels/Inset card',
  component: InsetCard,
  globals: { surface: 'skater', mode: 'light' },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof InsetCard>;

export default meta;
type Story = StoryObj<typeof meta>;

const cardOf = (root: ParentNode) => root.querySelector<HTMLElement>('[data-slot="inset-card"]');

/** The card once it's past its starting style: it mounts transparent, then fades in. */
const shownCard = (root: ParentNode) =>
  waitFor(() => {
    const card = must(cardOf(root));
    expect(card).toBeVisible();
    return card;
  });

/** 2.8: the card loading — its head and a few blocks, the sizes of what comes. */
export const Loading: Story = {
  args: {} as never,
  render: () => (
    <SkaterPair height="40rem">
      {() => (
        <PanelColumn>
          <InsetCard backTo="Mascoma Lake" onClose={() => {}} returnKey="report:r1" label="Report">
            <PanelLoading />
          </InsetCard>
        </PanelColumn>
      )}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    for (const quad of canvasElement.querySelectorAll<HTMLElement>(
      '[data-skater-pair] > section',
    )) {
      const card = await shownCard(quad);
      // Cards are square; only what you press is rounded.
      await expect(getComputedStyle(card).borderRadius).toBe('0px');
      // 12 px in from the column's edges.
      const column = must(quad.querySelector<HTMLElement>('[data-slot="panel-column"]'));
      await expect(card.getBoundingClientRect().left - column.getBoundingClientRect().left).toBe(
        12,
      );
      await expect(
        within(card).getByRole('button', { name: /Back to Mascoma Lake/ }),
      ).toBeVisible();
      await expect(card.querySelector('[data-slot="panel-loading"]')).toHaveAttribute(
        'aria-busy',
        'true',
      );
    }
  },
};

/** 2.9: a link that names the lake, its hazard no longer on the map — said in the card. */
export const Unavailable: Story = {
  args: {} as never,
  render: () => (
    <SkaterPair height="30rem">
      {() => (
        <PanelColumn>
          <InsetCard backTo="Mascoma Lake" onClose={() => {}} returnKey="hazard:h9" label="Hazard">
            <PanelUnavailable title="Hazard not found">
              This marker isn’t available. The link may be broken, or it may have been removed from
              the map.
            </PanelUnavailable>
          </InsetCard>
        </PanelColumn>
      )}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    const card = await shownCard(canvasElement);
    await expect(within(card).getByRole('heading', { name: 'Hazard not found' })).toBeVisible();
  },
};

const closed = fn();

/**
 * The keyboard: the row opens the card, focus moves into it, Esc closes it, and focus comes back to
 * the row — by hand, because a card is a route and its opener has unmounted by the time it closes.
 */
export const Keyboard: Story = {
  args: {} as never,
  globals: { mode: 'dark' },
  render: function Render() {
    const [open, setOpen] = useState(false);
    return (
      <div className="h-[36rem]">
        <PanelColumn
          behind={
            open ? null : (
              <aside
                data-slot="lake-sidebar"
                className="flex flex-col gap-(--space-3) p-(--space-6)"
              >
                <a
                  href="/report/r1"
                  {...panelTriggerProps('report', 'r1')}
                  onClick={(event) => {
                    event.preventDefault();
                    setOpen(true);
                  }}
                >
                  Pat Lacasse · Today · 11:40 AM
                </a>
              </aside>
            )
          }
        >
          {open && (
            <InsetCard
              backTo="Mascoma Lake"
              onClose={() => {
                closed();
                setOpen(false);
              }}
              returnKey="report:r1"
              label="Report"
            >
              <CardHead
                kind="Report"
                title="Mascoma South"
                where={
                  <>
                    <PlaceGlyph />
                    <span>Today · off the ice 11:40 AM · skated 2h</span>
                  </>
                }
              />
              <button type="button">Helpful</button>
            </InsetCard>
          )}
        </PanelColumn>
      </div>
    );
  },
  play: async ({ canvasElement }) => {
    const row = within(canvasElement).getByRole('link', { name: /Pat Lacasse/ });
    await userEvent.tab();
    await expect(row).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    // In by hand: focus lands in the card.
    const card = await shownCard(document);
    await waitFor(() => expect(card.contains(document.activeElement)).toBe(true));
    await expect(card).toHaveAttribute('role', 'dialog');
    // Tab walks the card: the head first.
    await userEvent.tab();
    await expect(within(card).getByRole('button', { name: /Back to Mascoma Lake/ })).toHaveFocus();
    // Esc out, and focus back on the row that opened it.
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(cardOf(document)).toBeNull());
    await expect(closed).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(within(canvasElement).getByRole('link', { name: /Pat Lacasse/ })).toHaveFocus(),
    );
  },
};
