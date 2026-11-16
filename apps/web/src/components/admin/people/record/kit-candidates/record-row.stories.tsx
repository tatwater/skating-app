import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import { Button } from '@/components/kit/button';
import { must } from '@/components/kit/storyKit';

import { RecordRow, RecordRowQuote } from './record-row';

/**
 * Kit candidate: the record row (the record sheet's list, 8.7–8.9) — chips, the words, where and
 * when, why, the age; the open row lit; a row given back in this sitting a tone down, with its own
 * *Undo* beside the row's button.
 */
const meta = {
  title: 'Admin/People/Kit candidates/Record row',
  component: RecordRow,
  globals: { surface: 'admin', mode: 'dark' },
  args: {
    chips: [{ label: 'report' }, { label: 'hidden' }],
    title: '“3½" on the second freezing night”',
    lines: ['Mascoma Lake · 4 Oct · hidden 10 Oct', 'Reason: “Second unsafe claim this week”'],
    onClick: fn(),
  },
  decorators: [(Story) => <ul className="m-0 w-[21.25rem] p-0">{Story()}</ul>],
} satisfies Meta<typeof RecordRow>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The three rows the board draws: at rest, open, and restored in this sitting with its Undo. */
export const States: Story = {
  render: (args) => (
    <>
      <RecordRow {...args} meta="4 d" />
      <RecordRow
        {...args}
        selected
        chips={[{ label: 'comment' }, { label: 'hidden' }, { label: 'deleted' }]}
        title="“Learn to read a thermometer.”"
        lines={[
          'On Luc Pelletier’s report · Lake Morey · 22 Sep · hidden 23 Sep',
          <>
            Reason: <RecordRowQuote>Hostile tone, third time this month</RecordRowQuote>
          </>,
        ]}
        meta="21 d"
      />
      <RecordRow
        {...args}
        back
        chips={[{ label: 'report' }, { label: 'Restored · Dana', lit: true }]}
        lines={['Mascoma Lake · 4 Oct', 'Was hidden: “Second unsafe claim this week”']}
        meta="14:52"
        action={<Button size="xs">Undo</Button>}
      />
      <RecordRow
        {...args}
        gone
        chips={[{ label: 'report' }, { label: 'overturned' }, { label: 'erased' }]}
        title="The words were erased"
        meta="250 d"
      />
    </>
  ),
  play: async ({ canvasElement, args }) => {
    const rows = canvasElement.querySelectorAll<HTMLElement>('[data-slot="record-row"]');
    await expect(rows).toHaveLength(4);
    // The open row says so; the Undo is its own control, beside the row's button, not in it.
    const open = must(rows[1]?.querySelector('button'));
    await expect(open).toHaveAttribute('aria-current', 'true');
    const undo = within(must(rows[2])).getByRole('button', { name: 'Undo' });
    await expect(
      must(rows[2]?.querySelector('[data-slot="record-row-button"]')).contains(undo),
    ).toBe(false);
    await userEvent.click(must(rows[0]?.querySelector('button')));
    await expect(args.onClick).toHaveBeenCalled();
  },
};
