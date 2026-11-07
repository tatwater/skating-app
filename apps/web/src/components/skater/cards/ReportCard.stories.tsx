import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { must } from '../../kit/storyKit';
import {
  BOARD_NOW,
  CARD_KATE_BLOCKED,
  CARD_PAT,
  CARD_SARAH,
  POST_ANA,
} from '../panels/panelFixtures';
import { SkaterPair } from '../storySupport';
import { FeedCard } from './FeedCard';
import { ReportCard } from './ReportCard';

/**
 * The shared report row (boards 1.2, 4.1, 6.1), dark and light: the lake's Reports tab (rows), and
 * Latest's post with its lakes (blocks). Props only — the lists that render it own the data.
 */
const meta = {
  title: 'Skater/Cards/Report card',
  component: ReportCard,
  globals: { surface: 'skater', mode: 'light' },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof ReportCard>;

export default meta;
type Story = StoryObj<typeof meta>;

const opened = fn();

/** 1.2's Reports tab: Pat's, Sarah's "Don't go" from shore, and a blocked author's — dimmed, not hidden. */
export const Rows: Story = {
  args: {} as never,
  render: () => (
    <SkaterPair height="40rem">
      {() => (
        <div className="w-[27.5rem] px-(--space-7) py-(--space-5)">
          <ReportCard
            report={CARD_PAT}
            now={BOARD_NOW}
            href="/report/r1"
            onOpen={() => opened('r1')}
            hideBody
            excerpt="Black ice from the launch to the islands, a skim of new snow past them. Drilled 5″ off the beach and 4″ near the islands."
            helpfulCount={6}
            commentCount={2}
          />
          <ReportCard
            report={CARD_SARAH}
            now={BOARD_NOW}
            href="/report/r2"
            onOpen={() => opened('r2')}
            hideBody
            excerpt="Open lead running from the bridge into the north basin. Didn't go out."
            helpfulCount={11}
            commentCount={4}
          />
          <ReportCard
            report={CARD_KATE_BLOCKED}
            now={BOARD_NOW}
            href="/report/r3"
            onOpen={() => opened('r3')}
            hideBody
            last
          />
        </div>
      )}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    const quad = must(canvasElement.querySelector<HTMLElement>('[data-skater-pair] > section'));
    const cards = within(quad).getAllByRole('link');
    await expect(cards).toHaveLength(3);
    // Square cards; the last row has no rule under it.
    await expect(getComputedStyle(must(cards[0])).borderRadius).toBe('0px');
    await expect(getComputedStyle(must(cards[2])).borderBottomWidth).toBe('0px');
    await expect(getComputedStyle(must(cards[0])).borderBottomWidth).not.toBe('0px');
    // The keyboard: a row is one tab stop, and Enter opens it in-app.
    must(cards[0]).focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(opened).toHaveBeenCalledWith('r1'));
    await userEvent.tab();
    await expect(cards[1]).toHaveFocus();
  },
};

/** 4.1: Ana's two stops on the way home — a post over two lakes, its itinerary down the left. */
export const Post: Story = {
  args: {} as never,
  render: () => (
    <SkaterPair height="38rem">
      {() => (
        <div className="w-[40rem] px-(--space-7) py-(--space-5)">
          <FeedCard
            post={POST_ANA}
            now={BOARD_NOW}
            reportHref={(id) => `/latest?report=${id}`}
            onOpenReport={(id) => opened(id)}
            helpfulCount={9}
            commentCount={1}
            last
          />
        </div>
      )}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    const quad = must(canvasElement.querySelector<HTMLElement>('[data-skater-pair] > section'));
    const post = within(quad).getByRole('article');
    await expect(
      within(post).getByRole('heading', { name: 'Two stops on the way home' }),
    ).toBeVisible();
    const blocks = within(post).getAllByRole('link');
    await expect(blocks).toHaveLength(2);
    for (const block of blocks) await expect(getComputedStyle(block).borderRadius).toBe('0px');
    await expect(within(post).getByText('Hike-in')).toBeVisible();
  },
};
