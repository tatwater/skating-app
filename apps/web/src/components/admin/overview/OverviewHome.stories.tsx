import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import { computedColor, JUNCTION_TOLERANCE_PX, sameColor } from '@/components/kit/measure';
import { faceLoaded, must } from '@/components/kit/storyKit';

import { OverviewBoard } from './overviewBoard';
import { HOME, HOME_MODERATOR, LAST_CHECKED_LIVE, LAST_CHECKED_QUIET } from './overviewFixtures';

/**
 * Boards 1.1–1.3: the Overview's Home tab in the console's frame, at the boards' 1440 × 900, on the
 * pinned clock. Render one beside its board to compare.
 */
const meta = {
  title: 'Admin/Overview/Home',
  component: OverviewBoard,
  globals: { surface: 'admin', mode: 'dark' },
  args: { data: HOME, live: 'live', lastCheckedAt: LAST_CHECKED_LIVE },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof OverviewBoard>;

export default meta;
type Story = StoryObj<typeof meta>;

const slot = (root: ParentNode, name: string) =>
  must(root.querySelector<HTMLElement>(`[data-slot="${name}"]`));
const slots = (root: ParentNode, name: string) => [
  ...root.querySelectorAll<HTMLElement>(`[data-slot="${name}"]`),
];

/** Board 1.1 — Home as the founder reviewed it, the live mark's plate open. */
export const Home: Story = {
  args: { plateOpen: true },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await faceLoaded(slot(canvasElement, 'page-word'));
    // The tab is Home.
    await expect(page.getByRole('tab', { name: 'Home' })).toHaveAttribute('aria-selected', 'true');
    // The heads row: one state per badge, never a bullet inside one.
    const heads = slots(canvasElement, 'head');
    await expect(heads.map((h) => h.getAttribute('aria-label'))).toEqual([
      'Needs a person',
      'Needs a hand',
    ]);
    const badges = heads.flatMap((h) => slots(h, 'badge').map((b) => b.textContent));
    await expect(badges).toEqual(['19 in the inbox', '2 re-fits', '1 stalled', '2 failed']);
    // Safety is red the moment anything waits in it.
    const safety = must(
      slots(canvasElement, 'count-row').find((r) => r.textContent?.startsWith('Safety')),
    );
    const value = slot(safety, 'count-value');
    await expect(getComputedStyle(value).color).toEqual(
      sameColor(computedColor(value, 'var(--bad)')),
    );
    // The plate says when the feed last checked, to the second.
    await waitFor(() => expect(document.querySelector('[data-slot="live-time"]')).not.toBeNull());
    await expect(must(document.querySelector('[data-slot="live-time"]'))).toHaveTextContent(
      '11:59:31',
    );
  },
};

/**
 * Board 1.2 — go-mode: G pressed, everything but the rail steps back and the go bar names the next
 * key. The shell does the dimming; Home only has to sit inside it.
 */
export const GoMode: Story = {
  play: async ({ canvasElement }) => {
    await faceLoaded(slot(canvasElement, 'page-word'));
    await userEvent.keyboard('g');
    const bar = slot(canvasElement, 'go-bar');
    await waitFor(() => expect(bar).toHaveAttribute('data-open'));
    const main = slot(canvasElement, 'shell-main');
    await waitFor(() =>
      expect(Math.abs(Number(getComputedStyle(main).opacity) - 0.28)).toBeLessThanOrEqual(0.01),
    );
  },
};

/** Board 1.3 — the feed gone quiet: the mark is hollow, *Not live*, and the plate offers Refresh. */
export const NotLive: Story = {
  args: { live: 'off', lastCheckedAt: LAST_CHECKED_QUIET, plateOpen: true },
  play: async ({ canvasElement }) => {
    const mark = slot(canvasElement, 'live-mark');
    await expect(mark).toHaveAttribute('data-state', 'off');
    await expect(mark).toHaveTextContent('Not live');
    const plate = await within(document.body).findByRole('button', { name: 'Refresh' });
    await expect(plate).toBeVisible();
    await expect(must(document.querySelector('[data-slot="live-time"]'))).toHaveTextContent(
      '11:53:34',
    );
    // The lamp reads the same.
    await expect(slot(canvasElement, 'status-lamp')).toHaveTextContent('Convex not live');
  },
};

/** Board 1.1 in the console's light map. */
export const HomeLight: Story = {
  globals: { surface: 'admin', mode: 'light' },
  args: { plateOpen: true },
  play: async ({ canvasElement }) => {
    await faceLoaded(slot(canvasElement, 'page-word'));
    const word = slot(canvasElement, 'page-word');
    await expect(getComputedStyle(word).color).toEqual(sameColor(computedColor(word, 'var(--fg)')));
  },
};

/** A moderator's Home: no Support lane and no appeals — not marked, simply not drawn. */
export const Moderator: Story = {
  args: { data: HOME_MODERATOR },
  play: async ({ canvasElement }) => {
    const labels = slots(canvasElement, 'count-label').map((l) => l.textContent);
    await expect(labels).not.toContain('Support');
    await expect(labels).not.toContain('Appeals open');
    await expect(labels).toContain('Content flags');
  },
};

/** Everything on its way: each block holds its place, so nothing moves when the numbers land. */
export const Loading: Story = {
  args: { data: {}, live: 'checking', lastCheckedAt: null },
  play: async ({ canvasElement }) => {
    const cards = slots(canvasElement, 'count-card');
    await expect(cards).toHaveLength(4);
    for (const card of cards) await expect(card).toHaveAttribute('aria-busy', 'true');
    await expect(slot(canvasElement, 'live-mark')).toHaveTextContent('Checking');
  },
};

/**
 * As the app mounts it today: the reads that exist (the Inbox, Corpus and People counts, the
 * feed), and every block no read serves yet — the season's four, cost, Machinery — saying so.
 */
export const NotReadYet: Story = {
  name: 'Not read yet',
  args: {
    data: {
      ...HOME,
      watch: null,
      winter: null,
      imagery: null,
      firstSkate: null,
      cost: null,
      machinery: null,
    },
  },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await faceLoaded(slot(canvasElement, 'page-word'));
    await expect(page.getAllByText('Not recorded yet')).toHaveLength(8);
    await expect(page.getByText('Spend by month lands here')).toBeVisible();
    await expect(page.queryByRole('link', { name: /Ledger|Health/ })).toBeNull();
    // The rest of the page stands as it does with every read.
    await expect(page.getByText('19 open')).toBeVisible();
  },
};

/**
 * The page fits the screen: the lower half runs to the page's foot and the feed scrolls inside it,
 * so the frame never scrolls.
 */
export const FitsTheScreen: Story = {
  play: async ({ canvasElement }) => {
    await faceLoaded(slot(canvasElement, 'page-word'));
    const main = slot(canvasElement, 'shell-main').getBoundingClientRect();
    const home = slot(canvasElement, 'overview-home').getBoundingClientRect();
    await expect(home.bottom).toBeLessThanOrEqual(main.bottom + JUNCTION_TOLERANCE_PX);
    const feed = slot(canvasElement, 'audit-feed').getBoundingClientRect();
    await expect(feed.bottom).toBeLessThanOrEqual(main.bottom + JUNCTION_TOLERANCE_PX);
  },
};
