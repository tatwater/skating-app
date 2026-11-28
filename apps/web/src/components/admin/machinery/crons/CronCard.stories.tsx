import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent } from 'storybook/test';

import { Button } from '@/components/kit/button';
import { must } from '@/components/kit/storyKit';

import { ThemePair } from '../../../../../.storybook/theme';
import { CronCard } from './CronCard';
import { IMAGERY_JOBS, NOW, STATE_JOBS, ZONE } from './cronFixtures';

/**
 * The cron card in every state its rule can return — not recorded yet, running, killed, failed,
 * late, stalled, retried, on time — plus a daily cron (its fixed UTC time and its next run) and a
 * sparse one (its quiet checks kept hourly), on the pinned clock. Dark and light, at the board's
 * card width (351) and a narrow one (273, the drawer's tab); then the board's strip of three.
 */

const LABELS = ['Poll for new passes', 'Pump the queue', 'Rebuild the live index'];

function Cards({ onOpenRuns }: { onOpenRuns: (job: string) => void }) {
  return (
    <ThemePair surface="admin" columns="one" heading>
      {() => (
        <div className="flex flex-col gap-(--space-6)">
          <div
            data-slot="story-strip"
            className="flex w-[69rem] max-w-full border-b border-solid border-line"
          >
            {IMAGERY_JOBS.map((job, i) => (
              <CronCard
                key={job.job}
                job={job}
                label={LABELS[i] as string}
                headline={['6 new', '1 starting', 'nothing new'][i] as string}
                now={NOW}
                timeZone={ZONE}
                onOpenRuns={() => onOpenRuns(job.job)}
                className="min-w-0 flex-1 border-r border-dotted border-line pl-(--space-5)"
                {...(i === 0 && {
                  action: (
                    <Button size="xs" className="-ml-px">
                      Run now
                    </Button>
                  ),
                })}
              />
            ))}
          </div>
          {[351, 273].map((w) => (
            <div
              key={w}
              data-slot="story-width"
              data-width={w}
              className="grid grid-cols-2 gap-x-(--space-6) gap-y-(--space-1)"
              style={{ width: 2 * w + 24 }}
            >
              {STATE_JOBS.map(({ name, job }) => (
                <CronCard
                  key={name}
                  data-story={name}
                  job={job}
                  now={NOW}
                  timeZone={ZONE}
                  onOpenRuns={() => onOpenRuns(job.job)}
                  style={{ width: w }}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </ThemePair>
  );
}

const meta = {
  title: 'Admin/Machinery/Crons/Card',
  component: Cards,
  globals: { surface: 'admin', mode: 'dark' },
  args: { onOpenRuns: fn() },
} satisfies Meta<typeof Cards>;

export default meta;
type Story = StoryObj<typeof meta>;

const card = (root: ParentNode, name: string) =>
  must(root.querySelector<HTMLElement>(`[data-story="${name}"]`));
const slot = (el: HTMLElement, name: string) =>
  must(el.querySelector<HTMLElement>(`[data-slot="${name}"]`));

export const EveryState: Story = {
  play: async ({ canvasElement, args }) => {
    const q = must(canvasElement.querySelector<HTMLElement>('[data-mode="dark"]'));
    // The state the rule returns, read on the pinned clock.
    for (const name of [
      'never',
      'running',
      'killed',
      'failed',
      'late',
      'stalled',
      'retried',
      'ok',
    ]) {
      await expect(card(q, name).dataset.state).toBe(name);
    }
    await expect(card(q, 'daily').dataset.state).toBe('ok');
    await expect(card(q, 'sparse').dataset.state).toBe('ok');
    // The words a reader who doesn't see the color reads.
    await expect(slot(card(q, 'never'), 'cron-when')).toHaveTextContent('Not recorded yet');
    await expect(slot(card(q, 'killed'), 'cron-when')).toHaveTextContent('Killed');
    await expect(slot(card(q, 'late'), 'cron-when')).toHaveTextContent('Late');
    await expect(slot(card(q, 'late'), 'cron-sub')).toHaveTextContent('Every 6 hours · last 00:40');
    // An interval cron: its interval and its last run, never a next run.
    await expect(slot(card(q, 'ok'), 'cron-when')).toHaveTextContent('12:40');
    await expect(slot(card(q, 'ok'), 'cron-sub').textContent).not.toContain('next');
    // A daily cron: its fixed UTC time, and its next run in the viewer's clock (07:30 EDT).
    await expect(slot(card(q, 'daily'), 'cron-sub')).toHaveTextContent(
      'Daily at 11:30 UTC · next Thu 15 07:30',
    );
    // A sparse cron says its quiet checks are kept hourly.
    await expect(slot(card(q, 'sparse'), 'cron-sub')).toHaveTextContent(
      'Every minute · quiet checks kept hourly',
    );
    // Runs opens the drawer on its cron.
    await userEvent.click(slot(card(q, 'ok'), 'cron-runs'));
    await expect(args.onOpenRuns).toHaveBeenCalledWith('poll for new satellite imagery');
  },
};

export const BoardStrip: Story = {
  play: async ({ canvasElement }) => {
    const strip = must(canvasElement.querySelector<HTMLElement>('[data-slot="story-strip"]'));
    const cards = [...strip.querySelectorAll<HTMLElement>('[data-slot="cron-card"]')];
    await expect(cards.map((c) => c.dataset.state)).toEqual(['ok', 'running', 'ok']);
    await expect(slot(must(cards[0]), 'cron-sub')).toHaveTextContent('Every 6 hours · 6 new');
    await expect(slot(must(cards[1]), 'cron-when')).toHaveTextContent('Running');
    // No card overflows its slot at either width.
    for (const el of canvasElement.querySelectorAll<HTMLElement>('[data-slot="cron-card"]')) {
      await expect(el.scrollWidth).toBeLessThanOrEqual(el.clientWidth + 1);
    }
  },
};
