import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { faceLoaded, must } from '@/components/kit/storyKit';

import { StaffStrip } from './PersonStrips';
import { NOW, SARAH_PAGE, SARAH_STATS, SEASON } from './personFixtures';
import type { StaffStatsRead } from './personModel';

/**
 * The staff strip naming who undid a staffer's decisions this week — each a circle and a first
 * name, the rest counted — at the boards' detail column and at a phone's width, where the cells wrap
 * two to a row. The circles sit in the sub-line, under the value, never over it.
 */

const undoer = (userId: string, displayName: string) => ({
  userId: userId as never,
  displayName,
  username: displayName.toLowerCase().replace(/\s+/g, ''),
  profileImageUrl: null,
  count: 1,
});

const NAMED: StaffStatsRead = {
  ...SARAH_STATS,
  decisions: {
    ...SARAH_STATS.decisions,
    undoneByOthers: {
      count: 5,
      capped: false,
      by: [undoer('u1', 'Ada Quill'), undoer('u2', 'Bo Lindqvist'), undoer('u3', 'Cy Marsh')],
      byMore: 2,
    },
  },
};

const meta = {
  title: 'Admin/People/Staff strip',
  component: StaffStrip,
  globals: { surface: 'admin', mode: 'dark' },
  args: { person: SARAH_PAGE, stats: NAMED, season: SEASON, now: NOW },
  decorators: [(Story) => <div className="w-[47.5rem] bg-bg p-(--space-5)">{Story()}</div>],
} satisfies Meta<typeof StaffStrip>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Every circle under its cell's value and inside its cell — read once the face has loaded. */
async function checkNames(canvasElement: HTMLElement) {
  const cell = must(canvasElement.querySelector<HTMLElement>('[data-fact="decisions"]'));
  await faceLoaded(must(cell.querySelector('[data-slot="stat-sub"]')));
  // Measured together, after the face: no node is held across an await.
  const value = must(cell.querySelector('[data-slot="value"]')).getBoundingClientRect();
  const box = cell.getBoundingClientRect();
  const faces = [...cell.querySelectorAll('[data-slot="avatar"]')].map((f) =>
    f.getBoundingClientRect(),
  );
  await expect(faces).toHaveLength(3);
  for (const face of faces) {
    await expect(face.top).toBeGreaterThanOrEqual(value.bottom);
    await expect(face.left).toBeGreaterThanOrEqual(box.left - 0.5);
    await expect(face.right).toBeLessThanOrEqual(box.right + 0.5);
  }
}

export const NamesWhoUndid: Story = {
  play: async ({ canvasElement }) => {
    await checkNames(canvasElement);
    const sub = must(canvasElement.querySelector('[data-fact="decisions"] [data-slot="stat-sub"]'));
    await expect(sub.textContent).toContain('and 2 more');
  },
};

/** A phone's width: the cells two to a row, the names wrapping inside their cell. */
export const AtPhoneWidth: Story = {
  decorators: [(Story) => <div className="w-[22.5rem] bg-bg p-(--space-4)">{Story()}</div>],
  play: async ({ canvasElement }) => checkNames(canvasElement),
};
