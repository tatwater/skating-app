import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { RetryNote } from '@/components/kit/retry-note';

import { LANE_COUNTS } from '../bodies/bodiesFixtures';
import { CorpusLanes } from './CorpusLanes';
import { BOARD_LANES } from './corpusBoardFixtures';
import { sidebarLanes } from './useCorpusSidebar';
import { COUNTS_FAILED } from './words/corpusWords';

/**
 * The one Corpus sidebar (both views mount it): *Tasks* above the library's *Views* and
 * *Standing*, each lane with its count — loaded, while the server is still filing its tasks (no task
 * count, never a partial one), and with the counts' read failed (none drawn, the note at the foot).
 * Four-up: both surfaces, both modes.
 */
const meta = {
  title: 'Admin/Corpus/Sidebar',
  component: CorpusLanes,
  parameters: { layout: 'fullscreen', fourUp: true },
  args: {
    lanes: sidebarLanes(BOARD_LANES, LANE_COUNTS),
    selected: 'name-conflicts',
    onSelect: () => {},
  },
  decorators: [
    (Story) => (
      <div className="flex h-[40rem] w-(--size-lanes) flex-col border-0 border-r border-solid border-line">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CorpusLanes>;

export default meta;
type Story = StoryObj<typeof meta>;

const cells = (root: HTMLElement) => within(root);

export const Loaded: Story = {
  play: async ({ canvasElement }) => {
    const page = cells(canvasElement);
    await expect(page.getAllByText('Tasks')).toHaveLength(4);
    await expect(page.getAllByText('412')).toHaveLength(4);
    await expect(page.getAllByText('140')).toHaveLength(4);
  },
};

export const StillFiling: Story = {
  args: { lanes: sidebarLanes({ ...BOARD_LANES, pending: true }, LANE_COUNTS) },
  play: async ({ canvasElement }) => {
    await expect(cells(canvasElement).queryAllByText('412')).toHaveLength(0);
  },
};

export const CountsFailed: Story = {
  args: {
    lanes: sidebarLanes(undefined, {}),
    countsNote: (
      <RetryNote
        data-slot="counts-error"
        className="shrink-0 border-0 border-t border-solid border-line px-(--space-4_5) py-(--space-3)"
        onRetry={() => {}}
      >
        {COUNTS_FAILED}
      </RetryNote>
    ),
  },
  play: async ({ canvasElement }) => {
    await expect(cells(canvasElement).getAllByText(COUNTS_FAILED)).toHaveLength(4);
  },
};
