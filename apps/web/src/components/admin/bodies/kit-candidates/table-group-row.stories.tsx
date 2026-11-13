import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';
import { must } from '@/components/kit/storyKit';
import { Table, TableCell, TableRow } from '@/components/kit/table';

import { TableGroupRow } from './table-group-row';

/** Kit candidate: a group divider inside a table (Bodies 5.3's *Dormant 4*). */
const meta = {
  title: 'Kit candidates/TableGroupRow',
  component: TableGroupRow,
  tags: ['autodocs'],
  globals: { surface: 'admin', mode: 'dark' },
  args: { colSpan: 3, label: 'Dormant', count: 2 },
  render: (args) => (
    <div className="w-[36rem]">
      <Table>
        <tbody>
          <TableRow>
            <TableCell lead>Lake Morey</TableCell>
            <TableCell>VT</TableCell>
            <TableCell align="end" mono>
              545
            </TableCell>
          </TableRow>
          <TableGroupRow {...args} />
          <TableRow>
            <TableCell lead>Morey Pond</TableCell>
            <TableCell>NH</TableCell>
            <TableCell align="end" mono>
              41
            </TableCell>
          </TableRow>
          <TableRow>
            <TableCell lead>Morses Pond</TableCell>
            <TableCell>ME</TableCell>
            <TableCell align="end" mono>
              63
            </TableCell>
          </TableRow>
        </tbody>
      </Table>
    </div>
  ),
} satisfies Meta<typeof TableGroupRow>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The divider spans the table, its rule the full width. */
export const Divider: Story = {
  play: async ({ canvasElement }) => {
    const th = must(canvasElement.querySelector<HTMLElement>('[data-slot="table-group-row"] th'));
    const table = must(canvasElement.querySelector<HTMLElement>('table'));
    await expect(th.getBoundingClientRect().width).toBeCloseTo(
      table.getBoundingClientRect().width,
      0,
    );
    await expect(th).toHaveTextContent('Dormant2');
  },
};

/** In all four maps. */
export const FourUp: Story = { parameters: { fourUp: true } };
