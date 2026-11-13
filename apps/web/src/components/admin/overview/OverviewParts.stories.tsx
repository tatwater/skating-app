import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import {
  computedColor,
  JUNCTION_TOLERANCE_PX,
  resolvePx,
  sameColor,
} from '@/components/kit/measure';
import { StatusDot } from '@/components/kit/status-dot';
import { faceLoaded, must } from '@/components/kit/storyKit';

import { LiveMark } from './LiveMark';
import { InboxCard, MachineryCard } from './OverviewCards';
import { OverviewPage } from './OverviewPage';
import { HOME, LAST_CHECKED_LIVE, LAST_CHECKED_QUIET, MACHINERY, NOW } from './overviewFixtures';

/** The Home blocks one at a time, in all four maps where the piece is surface-neutral. */
const meta = {
  title: 'Admin/Overview/Parts',
  globals: { surface: 'admin', mode: 'dark' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const slot = (root: ParentNode, name: string) =>
  must(root.querySelector<HTMLElement>(`[data-slot="${name}"]`));
const slots = (root: ParentNode, name: string) => [
  ...root.querySelectorAll<HTMLElement>(`[data-slot="${name}"]`),
];

/** The status square: 6 px, square, red · amber · gray · hollow. */
export const StatusDots: Story = {
  parameters: { fourUp: true },
  render: () => (
    <div className="flex items-center gap-(--space-3)">
      <StatusDot tone="bad" />
      <StatusDot tone="warn" />
      <StatusDot tone="quiet" />
      <StatusDot tone="hollow" />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const quad = must(canvasElement.querySelector('[data-theme-scope]'));
    const dots = slots(quad, 'status-dot');
    await expect(dots).toHaveLength(4);
    for (const dot of dots) {
      const r = dot.getBoundingClientRect();
      await expect(r.width).toBeCloseTo(6, 0);
      await expect(r.height).toBeCloseTo(6, 0);
      // Square: a status mark, not a person.
      await expect(getComputedStyle(dot).borderRadius).toBe('0px');
      await expect(dot).toHaveAttribute('aria-hidden', 'true');
    }
    const [bad, warn, , hollow] = dots.map(must);
    await expect(getComputedStyle(must(bad)).backgroundColor).toEqual(
      sameColor(computedColor(must(bad), 'var(--bad)')),
    );
    await expect(getComputedStyle(must(warn)).backgroundColor).toEqual(
      sameColor(computedColor(must(warn), 'var(--warn)')),
    );
    await expect(getComputedStyle(must(hollow)).backgroundColor).toEqual(
      sameColor('rgba(0, 0, 0, 0)'),
    );
  },
};

/** The live mark's three states: live, checking, not live (hollow). */
export const LiveMarks: Story = {
  parameters: { fourUp: true },
  render: () => (
    <div className="flex items-center gap-(--space-6)">
      <LiveMark state="live" lastCheckedAt={LAST_CHECKED_LIVE} />
      <LiveMark state="checking" lastCheckedAt={LAST_CHECKED_LIVE} />
      <LiveMark state="off" lastCheckedAt={LAST_CHECKED_QUIET} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const quad = must(canvasElement.querySelector('[data-theme-scope]'));
    const marks = slots(quad, 'live-mark');
    await expect(marks.map((m) => m.textContent)).toEqual(['Live', 'Checking', 'Not live']);
    // Not live: the LED goes hollow — no fill.
    const off = slot(must(marks[2]), 'badge');
    await expect(getComputedStyle(off, '::before').backgroundColor).toEqual(
      sameColor('rgba(0, 0, 0, 0)'),
    );
    const live = slot(must(marks[0]), 'badge');
    await expect(getComputedStyle(live, '::before').backgroundColor).not.toEqual(
      sameColor('rgba(0, 0, 0, 0)'),
    );
  },
};

const onRefresh = fn();

/** Hovering the mark opens the plate, to the second; the quiet state's plate offers Refresh. */
export const LivePlate: Story = {
  render: () => (
    <div className="flex justify-end p-(--space-8)">
      <LiveMark state="off" lastCheckedAt={LAST_CHECKED_QUIET} onRefresh={onRefresh} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    onRefresh.mockClear();
    const mark = slot(canvasElement, 'live-mark');
    await userEvent.click(mark);
    const refresh = await within(document.body).findByRole('button', { name: 'Refresh' });
    await expect(must(document.querySelector('[data-slot="live-time"]'))).toHaveTextContent(
      '11:53:34',
    );
    await userEvent.click(refresh);
    await expect(onRefresh).toHaveBeenCalledOnce();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(document.querySelector('[data-slot="live-plate"]')).toBeNull());
  },
};

const onTab = fn();

function Tabs3({ onChange }: { onChange: (v: string) => void }) {
  const [tab, setTab] = useState<'home' | 'metrics' | 'seasons'>('home');
  return (
    <OverviewPage
      value={tab}
      onValueChange={(v) => {
        setTab(v);
        onChange(v);
      }}
      tabs={[
        { value: 'home', label: 'Home', panel: <p data-testid="panel">Home panel</p> },
        { value: 'metrics', label: 'Metrics', panel: <p data-testid="panel">Metrics panel</p> },
        { value: 'seasons', label: 'Seasons', panel: <p data-testid="panel">Seasons panel</p> },
      ]}
      heads={[{ kicker: 'Needs a person', tone: 'warn', badges: ['19 in the inbox'] }]}
    />
  );
}

/**
 * The page head: the word, the controlled tabs (a third joins as data), the heads. Picking a tab
 * asks the route; only the chosen tab's panel is mounted.
 */
export const PageTabs: Story = {
  render: () => <Tabs3 onChange={onTab} />,
  play: async ({ canvasElement }) => {
    onTab.mockClear();
    const page = within(canvasElement);
    await faceLoaded(slot(canvasElement, 'page-word'));
    await expect(page.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Home',
      'Metrics',
      'Seasons',
    ]);
    await userEvent.click(page.getByRole('tab', { name: 'Seasons' }));
    await expect(onTab).toHaveBeenCalledWith('seasons');
    await waitFor(() => expect(page.getByTestId('panel')).toHaveTextContent('Seasons panel'));
    await expect(page.getAllByTestId('panel')).toHaveLength(1);
    // The tabs sit on the word's foot.
    const word = slot(canvasElement, 'page-word').getBoundingClientRect();
    const list = page.getByRole('tablist').getBoundingClientRect();
    await expect(Math.abs(list.bottom + 1 - word.bottom)).toBeLessThanOrEqual(4);
  },
};

/**
 * A count card: the slug 12 px over its rows, rows the board's 22 px, rules unbroken, the value's
 * ink its meaning, and a row that goes somewhere is a link.
 */
export const CountCardRows: Story = {
  render: () => (
    <div className="w-[15rem]">
      <InboxCard data={HOME.inbox} now={NOW} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    await faceLoaded(slot(canvasElement, 'count-label'));
    const chip = slot(canvasElement, 'section-chip').getBoundingClientRect();
    const rows = slots(canvasElement, 'count-row');
    const first = must(rows[0]).getBoundingClientRect();
    const gap = resolvePx(canvasElement, 'var(--gap-heading)');
    await expect(Math.abs(first.top - chip.bottom - gap)).toBeLessThanOrEqual(
      JUNCTION_TOLERANCE_PX,
    );
    for (const row of rows) {
      await expect(Math.abs(row.getBoundingClientRect().height - 22.5)).toBeLessThanOrEqual(1);
    }
    // A lane is a link to that lane.
    const link = slot(must(rows[0]), 'count-link');
    await expect(link).toHaveAttribute('href', '/admin/inbox?lane=safety');
    await expect(slot(canvasElement, 'section-note')).toHaveTextContent('19 open');
    await expect(slot(canvasElement, 'count-foot')).toHaveTextContent(
      'Oldest open 4 d · median age 1.5 d',
    );
  },
};

/** Machinery: the status square, the word in its tone, the time in a fixed column. */
export const MachineryRows: Story = {
  render: () => (
    <div className="w-[20.5rem]">
      <MachineryCard data={MACHINERY} now={NOW} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const rows = slots(canvasElement, 'count-row');
    await expect(rows.map((r) => r.dataset.state)).toEqual([
      'stalled',
      'failed',
      'failed',
      'late',
      'retried',
      'ok',
      'ok',
    ]);
    // The times share one right edge.
    const rights = rows.map((r) => slot(r, 'count-value').getBoundingClientRect().right);
    for (const r of rights) await expect(Math.abs(r - must(rights[0]))).toBeLessThanOrEqual(0.5);
    await expect(within(canvasElement).getByRole('link', { name: /Health/ })).toHaveAttribute(
      'href',
      '/admin/machinery',
    );
  },
};
