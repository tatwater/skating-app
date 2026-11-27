import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { computedColor, sameColor } from '@/components/kit/measure';
import { StatGrid } from '@/components/kit/stat-tile';

import { HeartbeatStat } from './HeartbeatStat';
import { LAST_FLUSH, ZONE } from './runFixtures';
import { StageBar, type StageTone } from './StageBar';

/**
 * The two kit candidates: the stage bar in every tone, and the heartbeat through `live-v5` §1's
 * states — running, late, stalled, held, never beat, marked failed by hand. Four-up.
 */
const TONES: StageTone[] = [
  'done',
  'running',
  'late',
  'stalled',
  'waiting',
  'failed',
  'dead',
  'idle',
];
const MIN = 60_000;

function Instruments() {
  return (
    <div className="flex w-[48rem] max-w-full flex-col gap-(--space-6)">
      <StageBar
        label="Every tone"
        segments={[
          ...TONES.map((t) => ({ id: t, tone: t, group: 'script' as const })),
          { id: 'h1', tone: 'idle', group: 'hand' as const },
          { id: 'h2', tone: 'idle', group: 'hand' as const },
        ]}
      />
      <StatGrid columns={3}>
        <HeartbeatStat
          key="r"
          liveness={{ state: 'running', quietMs: 18_000, expectedMs: 3 * MIN, waitUntil: null }}
          status="running"
          marked={false}
          lastHeardAt={LAST_FLUSH}
        />
        <HeartbeatStat
          key="l"
          liveness={{ state: 'late', quietMs: 7 * MIN, expectedMs: 3 * MIN, waitUntil: null }}
          status="running"
          marked={false}
          lastHeardAt={LAST_FLUSH}
        />
        <HeartbeatStat
          key="s"
          liveness={{ state: 'stalled', quietMs: 41 * MIN, expectedMs: 3 * MIN, waitUntil: null }}
          status="running"
          marked={false}
          lastHeardAt={LAST_FLUSH}
        />
        <HeartbeatStat
          key="w"
          liveness={{
            state: 'waiting',
            quietMs: 41 * MIN,
            expectedMs: 3 * MIN,
            waitUntil: LAST_FLUSH + 70 * MIN,
          }}
          status="running"
          marked={false}
          lastHeardAt={LAST_FLUSH}
          timeZone={ZONE}
        />
        <HeartbeatStat
          key="n"
          liveness={{ state: 'notRecorded' }}
          status="running"
          marked={false}
          lastHeardAt={null}
        />
        <HeartbeatStat
          key="m"
          liveness={{ state: 'finished' }}
          status="failed"
          marked
          lastHeardAt={LAST_FLUSH}
          timeZone={ZONE}
        />
        <HeartbeatStat
          key="p"
          liveness={{ state: 'running', quietMs: 200 * MIN, expectedMs: null, waitUntil: null }}
          status="running"
          marked={false}
          lastHeardAt={null}
        />
        <HeartbeatStat
          key="d"
          liveness={{ state: 'finished' }}
          status="succeeded"
          marked={false}
          lastHeardAt={null}
        />
        <HeartbeatStat
          key="x"
          liveness={{ state: 'finished' }}
          status="running"
          marked={false}
          lastHeardAt={null}
        />
      </StatGrid>
    </div>
  );
}

const meta = {
  title: 'Admin/Machinery/Instruments',
  component: Instruments,
  globals: { surface: 'admin', mode: 'dark' },
} satisfies Meta<typeof Instruments>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Every: Story = {
  play: async ({ canvasElement }) => {
    const segs = [...canvasElement.querySelectorAll<HTMLElement>('[data-slot="stage-segment"]')];
    await expect(segs).toHaveLength(10);
    const tone = (t: string) => must(segs.find((s) => s.dataset.tone === t));
    await expect(getComputedStyle(tone('stalled')).backgroundColor).toEqual(
      sameColor(computedColor(tone('stalled'), 'var(--bad)')),
    );
    await expect(getComputedStyle(tone('running')).backgroundColor).toEqual(
      sameColor(computedColor(tone('running'), 'var(--acc)')),
    );
    // The by-hand group starts a gap further on.
    const [, , , , , , , , h1] = segs;
    await expect(parseFloat(getComputedStyle(must(h1)).marginInlineStart)).toBeGreaterThan(0);
    const beats = [...canvasElement.querySelectorAll<HTMLElement>('[data-slot="heartbeat"]')];
    await expect(beats.map((b) => b.dataset.state)).toEqual([
      'running',
      'late',
      'stalled',
      'waiting',
      'notRecorded',
      'finished',
      'running',
      'finished',
      'finished',
    ]);
    await expect(beats[0]).toHaveTextContent(/18\s*s ago/);
    await expect(beats[2]).toHaveTextContent(/41\s*min quiet/);
    await expect(beats[3]).toHaveTextContent('Waiting until 14:41');
    await expect(beats[5]).toHaveTextContent(/failed\s*By hand/);
    await expect(beats[6]).toHaveTextContent('never called late');
    const value = must(beats[2]?.querySelector<HTMLElement>('[data-slot="value"]'));
    await expect(getComputedStyle(value).color).toEqual(
      sameColor(computedColor(value, 'var(--bad)')),
    );
  },
};

function must<T>(v: T | null | undefined): T {
  if (v == null) throw new Error('missing');
  return v;
}

export const FourUp: Story = {
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    await expect(
      canvasElement.querySelectorAll('[data-theme-scope] [data-slot="stage-bar"]'),
    ).toHaveLength(4);
  },
};
