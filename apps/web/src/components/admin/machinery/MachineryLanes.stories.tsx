import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { computedColor, sameColor } from '@/components/kit/measure';
import { must } from '@/components/kit/storyKit';

import { MachineryLanes } from './MachineryLanes';

const NOW = Date.UTC(2026, 9, 12, 18, 12);

/**
 * Machinery's sidebar (board 6.2's lanes): *Pipelines* and only the pages that are built — today
 * Corpus, *Local*, with its newest run's tail. Each tail state, and the lane before its read lands.
 */
const meta = {
  title: 'Admin/Machinery/Lanes',
  component: MachineryLanes,
  globals: { surface: 'admin', mode: 'dark' },
  args: { tails: { corpus: { state: 'stalled', at: NOW } }, selected: 'corpus', now: NOW },
  decorators: [
    (Story) => <div className="flex h-[20rem] w-[14.75rem] flex-col bg-bg">{Story()}</div>,
  ],
} satisfies Meta<typeof MachineryLanes>;

export default meta;
type Story = StoryObj<typeof meta>;

const lane = (root: HTMLElement) => within(root).getByRole('button', { name: /^Corpus/ });

export const Stalled: Story = {
  play: async ({ canvasElement }) => {
    const nav = within(canvasElement).getByRole('navigation', { name: 'Machinery' });
    await expect(within(nav).getByRole('list', { name: 'Pipelines' })).toBeVisible();
    await expect(within(nav).getAllByRole('button')).toHaveLength(1);
    const corpus = lane(canvasElement);
    await expect(corpus).toHaveTextContent('Local');
    const tail = must(
      [...corpus.querySelectorAll<HTMLElement>('*')].find((el) => el.textContent === 'stalled'),
    );
    await expect(getComputedStyle(tail).color).toEqual(
      sameColor(computedColor(tail, 'var(--bad)')),
    );
  },
};

export const StalledLight: Story = { globals: { surface: 'admin', mode: 'light' } };

export const FourUp: Story = { name: 'Four-up', parameters: { fourUp: true } };

export const Late: Story = {
  args: { tails: { corpus: { state: 'late', at: NOW } } },
  play: async ({ canvasElement }) => {
    await expect(lane(canvasElement)).toHaveTextContent('late');
  },
};

export const Running: Story = {
  args: { tails: { corpus: { state: 'running', at: NOW } } },
  play: async ({ canvasElement }) => {
    await expect(lane(canvasElement)).toHaveTextContent('running');
  },
};

export const Ok: Story = {
  args: { tails: { corpus: { state: 'ok', at: NOW - 2 * 60_000 } } },
  play: async ({ canvasElement }) => {
    await expect(lane(canvasElement)).toHaveTextContent('ok 2 min');
  },
};

export const NeverRun: Story = {
  args: { tails: { corpus: { state: 'never', at: null } } },
  play: async ({ canvasElement }) => {
    await expect(lane(canvasElement)).toHaveTextContent('not run');
  },
};

/** Before the read lands (or after it failed): the lane, and no tail — never a guess. */
export const NoTail: Story = {
  args: { tails: {} },
  play: async ({ canvasElement }) => {
    await expect(lane(canvasElement).textContent).toBe('CorpusLocal');
  },
};
