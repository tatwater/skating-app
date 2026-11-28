import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor } from 'storybook/test';

import { must } from '@/components/kit/storyKit';

import { ThemePair } from '../../../../../.storybook/theme';
import { CronTickStrip } from './CronTickStrip';
import { at, flushTicks, NOW, pollTicks, pumpTicks, SEASON_START, ZONE } from './cronFixtures';
import { CRON_WORDS } from './cronWords';

/**
 * The tick strip: the pump's last 12 hours (quiet, worked, refused, failed and killed ticks, two of
 * them out of order as a row records them), the poll since the start, a sparse cron's hourly quiet
 * ticks, a range the read cut short, nothing recorded, and loading. Dark and light, at the drawer's
 * width (780) and a narrow pane's (360).
 */

const HOUR = 3_600_000;

function Strips() {
  return (
    <ThemePair surface="admin" columns="one" heading>
      {() => (
        <div className="flex flex-col gap-(--space-8)">
          {[780, 360].map((w) => (
            <div
              key={w}
              data-slot="story-width"
              data-width={w}
              className="flex flex-col gap-(--space-8)"
              style={{ width: w }}
            >
              <CronTickStrip
                data-story="pump"
                ticks={pumpTicks()}
                from={NOW - 12 * HOUR}
                to={NOW}
                label={CRON_WORDS.stripLast(12)}
                now={NOW}
                timeZone={ZONE}
                describe={(t) => (t.at === at(8, 46) ? ['1 refusal · back of the queue'] : [])}
              />
              <CronTickStrip
                data-story="poll"
                ticks={pollTicks()}
                from={SEASON_START}
                to={NOW}
                label={CRON_WORDS.sinceTheStart}
                now={NOW}
                timeZone={ZONE}
              />
              <CronTickStrip
                data-story="sparse"
                ticks={flushTicks()}
                from={NOW - 12 * HOUR}
                to={NOW}
                sparse
                label={CRON_WORDS.stripLast(12)}
                now={NOW}
                timeZone={ZONE}
              />
              <CronTickStrip
                data-story="truncated"
                ticks={pumpTicks().slice(-40)}
                truncated
                from={NOW - 12 * HOUR}
                to={NOW}
                label={CRON_WORDS.stripLast(12)}
                now={NOW}
                timeZone={ZONE}
              />
              <CronTickStrip
                data-story="empty"
                ticks={[]}
                from={NOW - 12 * HOUR}
                to={NOW}
                label={CRON_WORDS.stripLast(12)}
                now={NOW}
                timeZone={ZONE}
              />
              <CronTickStrip
                data-story="loading"
                ticks={undefined}
                from={NOW - 12 * HOUR}
                to={NOW}
                label={CRON_WORDS.stripLast(12)}
                now={NOW}
                timeZone={ZONE}
              />
            </div>
          ))}
        </div>
      )}
    </ThemePair>
  );
}

const meta = {
  title: 'Admin/Machinery/Crons/Tick strip',
  component: Strips,
  globals: { surface: 'admin', mode: 'dark' },
} satisfies Meta<typeof Strips>;

export default meta;
type Story = StoryObj<typeof meta>;

const dark = (root: HTMLElement) => must(root.querySelector<HTMLElement>('[data-mode="dark"]'));
const strip = (root: ParentNode, name: string) =>
  must(root.querySelector<HTMLElement>(`[data-story="${name}"]`));
const ticksOf = (el: HTMLElement) => [
  ...el.querySelectorAll<SVGElement>('[data-slot="cron-tick"]'),
];

export const Every: Story = {
  play: async ({ canvasElement }) => {
    const q = dark(canvasElement);
    const pump = strip(q, 'pump');
    await waitFor(() => expect(ticksOf(pump).length).toBeGreaterThan(200));
    const kinds = new Set(ticksOf(pump).map((t) => t.dataset.kind));
    await expect([...kinds].sort()).toEqual(['failed', 'killed', 'quiet', 'refused', 'worked']);
    // Sorted whatever order the row held them in.
    const ats = ticksOf(pump).map((t) => Number(t.dataset.at));
    await expect(ats).toEqual([...ats].sort((a, b) => a - b));
    // Named by its counts, not color alone.
    const focus = must(pump.querySelector<HTMLElement>('[data-slot="cron-tick-focus"]'));
    await expect(focus.getAttribute('aria-label')).toMatch(
      /^Ticks · the last 12 hours: \d+ did something, \d+ nothing to do, 1 turned down, 1 failed, 1 cut off$/,
    );
    // The poll's long range names days; the pump's short one times, up to now.
    await expect(strip(q, 'poll').querySelector('[data-slot="cron-tick-from"]')).toHaveTextContent(
      'Fri 9 Oct',
    );
    await expect(strip(q, 'pump').querySelector('[data-slot="cron-tick-to"]')).toHaveTextContent(
      'Now',
    );
    // A sparse strip and a cut range say so; an empty one says nothing is recorded.
    await expect(strip(q, 'sparse')).toHaveTextContent('Quiet checks are kept once an hour');
    await expect(strip(q, 'truncated')).toHaveTextContent('Older ticks in this range aren’t drawn');
    await expect(strip(q, 'empty')).toHaveTextContent('Nothing recorded in this range yet');
    await expect(
      strip(q, 'loading').querySelector('[data-slot="cron-tick-marks"]'),
    ).toHaveAttribute('data-loading');
  },
};

export const Keyboard: Story = {
  play: async ({ canvasElement }) => {
    const q = dark(canvasElement);
    const pump = strip(q, 'pump');
    const focus = must(pump.querySelector<HTMLElement>('[data-slot="cron-tick-focus"]'));
    focus.focus();
    await userEvent.keyboard('{End}');
    // The newest tick's plate: when, and how long it took (an action's, measured).
    await waitFor(() =>
      expect(pump.querySelector('[data-slot="cron-tick-plate"]')).toHaveTextContent(
        'Today · 14:09',
      ),
    );
    await expect(pump.querySelector('[data-slot="cron-tick-plate"]')).toHaveTextContent('Took');
    // The oldest tick in the range (02:12 itself falls half a minute before it).
    await userEvent.keyboard('{Home}');
    await waitFor(() =>
      expect(pump.querySelector('[data-slot="cron-tick-plate"]')).toHaveTextContent(
        'Today · 02:15',
      ),
    );
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(pump.querySelector('[data-slot="cron-tick-plate"]')).toBeNull());
  },
};

export const SparseHasNoDuration: Story = {
  play: async ({ canvasElement }) => {
    const q = dark(canvasElement);
    const sparse = strip(q, 'sparse');
    const focus = must(sparse.querySelector<HTMLElement>('[data-slot="cron-tick-focus"]'));
    focus.focus();
    await userEvent.keyboard('{End}');
    const plate = () => sparse.querySelector('[data-slot="cron-tick-plate"]');
    await waitFor(() => expect(plate()).toHaveTextContent('Nothing to do'));
    // A mutation job's duration was never measured: no "Took", never "0 ms".
    await expect(plate()?.textContent).not.toContain('Took');
  },
};

export const Hover: Story = {
  play: async ({ canvasElement }) => {
    const q = dark(canvasElement);
    const pump = strip(q, 'pump');
    const refused = must(
      ticksOf(pump).find((t) => t.dataset.kind === 'refused'),
    ).getBoundingClientRect();
    const marks = must(pump.querySelector<HTMLElement>('[data-slot="cron-tick-marks"]'));
    await userEvent.pointer({
      target: marks,
      coords: { clientX: refused.left + refused.width / 2, clientY: refused.top + 4 },
    });
    await waitFor(() =>
      expect(pump.querySelector('[data-slot="cron-tick-plate"]')).toHaveTextContent(
        '1 refusal · back of the queue',
      ),
    );
  },
};
