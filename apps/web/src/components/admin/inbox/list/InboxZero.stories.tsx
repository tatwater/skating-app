import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { must } from '@/components/kit/storyKit';
import { InboxZero } from './InboxZero';
import { NOW, ZERO_TODAY } from './inboxFixtures';

/**
 * Inbox zero (board 2.9), the inspector column when nothing waits: the word, the day in a line, the
 * open count stepping to zero over its rug, the day's decisions by lane, and where other work waits.
 * Its read's states: ready, on its way, failed, and a day with no decision yet.
 */
const meta = {
  title: 'Admin/Inbox/Zero',
  component: InboxZero,
  globals: { surface: 'admin', mode: 'dark' },
  args: { day: { kind: 'ready', today: ZERO_TODAY }, now: NOW },
  decorators: [(Story) => <div className="flex h-[52rem] w-[52rem] flex-col bg-bg">{Story()}</div>],
} satisfies Meta<typeof InboxZero>;

export default meta;
type Story = StoryObj<typeof meta>;

const slot = (root: ParentNode, name: string) =>
  must(root.querySelector<HTMLElement>(`[data-slot="${name}"]`));

export const Ready: Story = {
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'inbox-zero-line')).toHaveTextContent(
      'As of 12:00, 22 decided today, a median of 1.5 days from filing to decision.',
    );
    await waitFor(() =>
      expect(slot(canvasElement, 'step-rug-zero')).toHaveTextContent(/Zero 11:58/i),
    );
    const cells = [...slot(canvasElement, 'inbox-zero-by-lane').querySelectorAll('dd')].map(
      (d) => d.textContent,
    );
    await expect(cells).toEqual(['1', '3', '8', '4', '1', '3', '2']);
    // Corpus and Machinery aren't built: their links say so.
    const corpus = within(slot(canvasElement, 'inbox-zero-elsewhere')).getByRole('button', {
      name: /Corpus/,
    });
    await expect(corpus).toHaveAttribute('aria-disabled', 'true');
  },
};

export const ReadyLight: Story = { globals: { surface: 'admin', mode: 'light' } };

export const QuietDay: Story = {
  args: { day: { kind: 'ready', today: { ...ZERO_TODAY, decided: [], filed: [] } } },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'inbox-zero-line')).toHaveTextContent(
      'As of 12:00, nothing decided today.',
    );
    await expect(canvasElement.querySelector('[data-slot="step-rug-zero"]')).toBeNull();
  },
};

export const Loading: Story = {
  args: { day: { kind: 'loading' } },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector('[data-slot="inbox-zero-line"]')).toBeNull();
    await expect(slot(canvasElement, 'inbox-zero-word')).toHaveTextContent('Inbox zero');
  },
};

export const Failed: Story = {
  args: { day: { kind: 'failed', retry: fn(), retrying: false } },
  play: async ({ canvasElement, args }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: /Try again/ }));
    if (args.day.kind === 'failed') await expect(args.day.retry).toHaveBeenCalled();
  },
};

/** The server can't tell the day's starting count: the page says so, and draws no line from a guess. */
export const StartUnknown: Story = {
  args: { day: { kind: 'ready', today: { ...ZERO_TODAY, openAtStart: null, filedCapped: true } } },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'inbox-zero-start-unknown')).toHaveTextContent(/isn’t known/);
    await expect(canvasElement.querySelector('[data-slot="step-rug-line"]')).toBeNull();
  },
};

/** A real 0 at the day's start is a count, drawn as one. */
export const StartAtZero: Story = {
  args: {
    day: {
      kind: 'ready',
      today: {
        ...ZERO_TODAY,
        openAtStart: 0,
        filed: ZERO_TODAY.decided.map((d) => ({ at: d.at - 60_000, lane: d.lane })),
      },
    },
  },
  play: async ({ canvasElement }) => {
    await waitFor(() =>
      expect(canvasElement.querySelector('[data-slot="step-rug-line"]')).not.toBeNull(),
    );
    await expect(canvasElement.querySelector('[data-slot="inbox-zero-start-unknown"]')).toBeNull();
  },
};

/** A moderator: no Support column — an admin's lane is hidden, never shown as 0. */
export const Moderator: Story = {
  args: { canReadSupport: false },
  play: async ({ canvasElement }) => {
    const cells = slot(canvasElement, 'inbox-zero-by-lane');
    await expect(cells.querySelector('[data-lane="support"]')).toBeNull();
    await expect(cells.querySelectorAll('[data-lane]')).toHaveLength(6);
  },
};

/** At a phone's width every lane's name is whole: the cells wrap to more rows. */
export const AtPhone: Story = {
  decorators: [
    (Story) => <div className="flex h-[52rem] w-[18.5rem] flex-col bg-bg">{Story()}</div>,
  ],
  play: async ({ canvasElement }) => {
    const names = [
      ...slot(canvasElement, 'inbox-zero-by-lane').querySelectorAll<HTMLElement>('dt'),
    ];
    await expect(names).toHaveLength(7);
    for (const dt of names) {
      await expect(dt.scrollWidth, dt.textContent ?? '').toBeLessThanOrEqual(dt.clientWidth + 1);
    }
  },
};
