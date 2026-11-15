import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { Button } from '@/components/kit/button';
import { ButtonGroup } from '@/components/kit/button-group';
import { computedColor, sameColor } from '@/components/kit/measure';
import { must } from '@/components/kit/storyKit';

import { LeverList, LeverRow } from './lever-row';

/**
 * Kit candidate: the lever row (People's `.lever`) — the key, its state by meaning, its action, and
 * an optional second line. Rows sit on dotted rules; the last has none.
 */
const meta = {
  title: 'Admin/People/Kit candidates/Lever row',
  component: LeverRow,
  globals: { surface: 'admin', mode: 'dark' },
  args: { label: 'Comments', status: 'Restricted', tone: 'bad' },
  decorators: [(Story) => <div className="w-full max-w-[24rem]">{Story()}</div>],
} satisfies Meta<typeof LeverRow>;

export default meta;
type Story = StoryObj<typeof meta>;

const slot = (root: ParentNode, name: string) =>
  must(root.querySelector<HTMLElement>(`[data-slot="${name}"]`));

function Rows() {
  return (
    <LeverList>
      <LeverRow
        label="Reports"
        status="Allowed"
        tone="ok"
        action={<Button size="sm">Restrict</Button>}
      />
      <LeverRow
        label="Comments"
        status="Restricted"
        tone="bad"
        action={<Button size="sm">Restore</Button>}
      />
      <LeverRow
        label="Bounties"
        status="Limit 1 (default 3)"
        tone="warn"
        action={<Button size="sm">Set limit</Button>}
        detail={
          <>
            This season <b>3 asks</b> · 1 over the limit
          </>
        }
      />
      <LeverRow
        label="Suspension"
        status="1 day left"
        tone="warn"
        action={
          <ButtonGroup aria-label="Suspension">
            <Button size="sm">Extend</Button>
            <Button size="sm">Lift</Button>
          </ButtonGroup>
        }
      />
      <LeverRow
        label="Ban"
        status="Account kept for appeal"
        action={
          <Button size="sm" variant="danger">
            Ban
          </Button>
        }
      />
    </LeverList>
  );
}

/** The rows as People draws them: tones by meaning, a joined pair, a second line. */
export const Rows_: Story = {
  name: 'Rows',
  render: () => <Rows />,
  play: async ({ canvasElement }) => {
    const rows = [...canvasElement.querySelectorAll<HTMLElement>('[data-slot="lever-row"]')];
    await expect(rows).toHaveLength(5);
    // Every row but the last sits on a dotted rule.
    await expect(getComputedStyle(rows[0] as HTMLElement).borderBottomStyle).toBe('dotted');
    await expect(getComputedStyle(rows[4] as HTMLElement).borderBottomWidth).toBe('0px');
    // The key column is 112 px: every state starts at one x.
    const xs = rows.map((r) => Math.round(slot(r, 'lever-status').getBoundingClientRect().left));
    await expect(new Set(xs).size).toBe(1);
    const key = slot(rows[0] as HTMLElement, 'lever-key').getBoundingClientRect();
    await expect(
      Math.round(
        slot(rows[0] as HTMLElement, 'lever-status').getBoundingClientRect().left - key.left,
      ),
    ).toBe(122);
    // Tones by meaning.
    const status = slot(rows[1] as HTMLElement, 'lever-status');
    await expect(getComputedStyle(status).color).toEqual(
      sameColor(computedColor(status, 'var(--bad)')),
    );
    const amber = slot(rows[2] as HTMLElement, 'lever-status');
    await expect(getComputedStyle(amber).color).toEqual(
      sameColor(computedColor(amber, 'var(--warn)')),
    );
    // A named group, its action read in context.
    await expect(
      within(canvasElement).getByRole('group', { name: 'Comments' }),
    ).toBeInTheDocument();
  },
};

/** One row with a second line. */
export const WithDetail: Story = {
  args: {
    label: 'Hidden content',
    status: '5 items',
    tone: 'quiet',
    detail: '2 reports · 2 comments · 1 post',
  },
  play: async ({ canvasElement }) => {
    const row = slot(canvasElement, 'lever-row');
    const detail = slot(row, 'lever-detail');
    await expect(detail.getBoundingClientRect().top).toBeGreaterThan(
      slot(row, 'lever-key').getBoundingClientRect().bottom,
    );
  },
};

/** All four maps. */
export const FourUp: Story = {
  render: () => <Rows />,
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      await expect(q.querySelectorAll('[data-slot="lever-row"]')).toHaveLength(5);
    }
  },
};
