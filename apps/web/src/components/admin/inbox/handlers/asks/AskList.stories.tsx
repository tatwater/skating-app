import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { InspectorProvider } from '../../inspector/inspectorContext';
import { AskList } from './AskList';
import { ASKS_NOW, ASKS_TZ, BOARD_ASKS, GONE_ASK, MANY_ASKS, REPORT_ASK } from './askFixtures';

/**
 * The shared ask list in all four themes: 2.3's two askers, newest first (one with a recorded
 * skate); a gone asker and an ask from a report; and a page the server cut short.
 */
function Lists() {
  return (
    <InspectorProvider
      value={{ pane: { current: null }, decidedOnOpen: false, now: ASKS_NOW, timeZone: ASKS_TZ }}
    >
      <div className="grid w-[46rem] max-w-full grid-cols-2 gap-x-(--space-7) gap-y-(--space-6)">
        <AskList asks={BOARD_ASKS} now={ASKS_NOW} total={{ count: 2, floor: false, cut: false }} />
        <AskList
          asks={[REPORT_ASK, GONE_ASK]}
          now={ASKS_NOW}
          total={{ count: 2, floor: false, cut: false }}
        />
        <AskList
          asks={MANY_ASKS.slice(0, 3)}
          now={ASKS_NOW}
          total={{ count: 500, floor: true, cut: false }}
        />
      </div>
    </InspectorProvider>
  );
}

const meta = {
  title: 'Admin/Inbox/Asks',
  component: Lists,
  parameters: { fourUp: true },
} satisfies Meta<typeof Lists>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FourUp: Story = {
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      const lists = [...q.querySelectorAll<HTMLElement>('[data-slot="ask-list"]')];
      await expect(lists).toHaveLength(3);
      const [board, odd, cut] = lists as [HTMLElement, HTMLElement, HTMLElement];
      // Newest first: Luc's ask (12 Oct) over Kate's (11 Oct).
      const names = [...board.querySelectorAll('[data-slot="person-name"]')].map(
        (n) => n.textContent,
      );
      await expect(names).toEqual(['Luc Pelletier', 'Kate Donovan']);
      await expect(within(board).getByText('With a recorded skate')).toBeVisible();
      await expect(within(odd).getByText('A former skater')).toBeVisible();
      await expect(within(odd).getByText('From their report · 14 Oct')).toBeVisible();
      await expect(within(cut).getByText('Showing 3 of 500+ asks')).toBeVisible();
    }
  },
};
