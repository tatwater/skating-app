import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { computedColor, sameColor } from '@/components/kit/measure';
import { must } from '@/components/kit/storyKit';

import { MachineryLanes } from './MachineryLanes';

const NOW = Date.UTC(2026, 9, 12, 18, 12);

/**
 * Machinery's sidebar (board 6.2's lanes): *Pipelines* and only the pages that are built — Corpus,
 * *Local*, with its newest run's tail, and Imagery, *Convex*, with its season's or its crons' word.
 * Each tail state, and a lane before its read lands.
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
    await expect(within(nav).getAllByRole('button')).toHaveLength(2);
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
    await expect(imageryLane(canvasElement).textContent).toBe('ImageryConvex');
  },
};

const imageryLane = (root: HTMLElement) => within(root).getByRole('button', { name: /^Imagery/ });

const HOUR = 3_600_000;
/** An imagery cron as the lane reads it: its schedule, its heartbeat, its last run. */
const cron = (
  every: number,
  hb: { lastTickAt?: number; lastOutcome?: 'ok' | 'worked' | 'failed' | 'killed' },
  lastRun: { startedAt: number; outcome: string } | null = null,
) => ({ schedule: { every }, inputs: hb, lastRun });

/** Imagery waiting, the line not crossed: *not started*, quiet. */
export const ImageryNotStarted: Story = {
  args: { tails: { imagery: { state: 'notStarted', ready: false } }, selected: 'imagery' },
  play: async ({ canvasElement }) => {
    const lane = imageryLane(canvasElement);
    await expect(lane).toHaveTextContent('Convex');
    await expect(lane).toHaveTextContent('not started');
    await expect(lane).toHaveAttribute('aria-current', 'true');
  },
};

/** The line crossed: *not started* in amber — a start waits on a person. */
export const ImageryReady: Story = {
  args: { tails: { imagery: { state: 'notStarted', ready: true } }, selected: 'imagery' },
  play: async ({ canvasElement }) => {
    const tail = must(
      [...imageryLane(canvasElement).querySelectorAll<HTMLElement>('*')].find(
        (el) => el.textContent === 'not started',
      ),
    );
    await expect(getComputedStyle(tail).color).toEqual(
      sameColor(computedColor(tail, 'var(--warn)')),
    );
  },
};

export const ImageryPaused: Story = {
  args: { tails: { imagery: { state: 'paused' } }, selected: 'imagery' },
  play: async ({ canvasElement }) => {
    await expect(imageryLane(canvasElement)).toHaveTextContent('paused');
  },
};

/** Running, its three crons on time: *ok* and the newest tick's age. */
export const ImageryOk: Story = {
  args: {
    tails: {
      imagery: {
        state: 'running',
        crons: [
          cron(6 * HOUR, { lastTickAt: NOW - 2 * HOUR, lastOutcome: 'ok' }),
          cron(3 * 60_000, { lastTickAt: NOW - 2 * 60_000, lastOutcome: 'ok' }),
          cron(10 * 60_000, { lastTickAt: NOW - 5 * 60_000, lastOutcome: 'ok' }),
        ],
      },
    },
    selected: 'imagery',
  },
  play: async ({ canvasElement }) => {
    await expect(imageryLane(canvasElement)).toHaveTextContent('ok 2 min');
  },
};

/** Running, the pump quiet past ten periods: the worst of the three, *stalled* in red. */
export const ImageryStalled: Story = {
  args: {
    tails: {
      imagery: {
        state: 'running',
        crons: [
          cron(6 * HOUR, { lastTickAt: NOW - 2 * HOUR, lastOutcome: 'ok' }),
          cron(3 * 60_000, { lastTickAt: NOW - 40 * 60_000, lastOutcome: 'ok' }),
          cron(10 * 60_000, { lastTickAt: NOW - 5 * 60_000, lastOutcome: 'ok' }),
        ],
      },
    },
    selected: 'imagery',
  },
  play: async ({ canvasElement }) => {
    await expect(imageryLane(canvasElement)).toHaveTextContent('stalled');
  },
};

/** No cron has a recorded tick yet: *not recorded yet* (Ma28). */
export const ImageryNotRecorded: Story = {
  args: {
    tails: { imagery: { state: 'running', crons: [cron(6 * HOUR, {}), cron(3 * 60_000, {})] } },
    selected: 'imagery',
  },
  play: async ({ canvasElement }) => {
    await expect(imageryLane(canvasElement)).toHaveTextContent('not recorded yet');
  },
};
