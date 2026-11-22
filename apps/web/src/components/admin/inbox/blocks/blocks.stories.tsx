import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import {
  ALERT_ITEM,
  BOARD_NOW,
  HAZARD_AUTO_ITEM,
  ROB_AUTHOR,
  SAFETY_ITEM,
  SAFETY_MANY,
} from '../handlers/Flag/flagFixtures';
import { AuthorBlock } from './AuthorBlock';
import { FlagBlock } from './FlagBlock';

/**
 * The flag handler's two shared blocks, which every handler that decides a flag imports: the flags
 * (2.1's *Flag*, a system flag, several flaggers, 2.6's bare form) and the author (2.1's *Author*,
 * a person who has left), in all four themes.
 */
function Blocks() {
  return (
    <div className="grid w-[46rem] max-w-full grid-cols-2 gap-x-(--space-7) gap-y-(--space-6)">
      <FlagBlock flags={SAFETY_ITEM.flags} targetType="report" now={BOARD_NOW} />
      <AuthorBlock author={ROB_AUTHOR} ownFlags={1} />
      <FlagBlock flags={SAFETY_MANY.flags} targetType="report" now={BOARD_NOW} />
      <FlagBlock flags={HAZARD_AUTO_ITEM.flags} targetType="hazard" now={BOARD_NOW} />
      <FlagBlock bare flags={ALERT_ITEM.flags} targetType="accessAlert" now={BOARD_NOW} />
      <AuthorBlock
        author={{
          ...ROB_AUTHOR,
          person: { ...ROB_AUTHOR.person, deleted: true },
          standing: { status: 'deleted', until: null, by: null },
          reports: null,
        }}
        title="The person"
      />
    </div>
  );
}

const meta = {
  title: 'Admin/Inbox/Blocks',
  component: Blocks,
  parameters: { fourUp: true },
} satisfies Meta<typeof Blocks>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FourUp: Story = {
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      const flags = [...q.querySelectorAll<HTMLElement>('[data-slot="flag-block"]')];
      await expect(flags).toHaveLength(4);
      // A person's flag: the quote, then the byline; the app's: no byline, its rule and count.
      await expect(flags[0]?.querySelector('[data-slot="flag-quote"]')).not.toBeNull();
      await expect(flags[0]?.querySelector('[data-slot="flag-byline"]')).not.toBeNull();
      await expect(flags[2]?.querySelector('[data-slot="flag-byline"]')).toBeNull();
      await expect(flags[2]).toHaveTextContent('Filed by the app');
      await expect(flags[2]).toHaveTextContent('4th occurrence');
      // Several flaggers: the count ends the rule.
      await expect(flags[1]?.querySelector('[data-slot="section-count"]')).toHaveTextContent('2');
      // The bare form: no slug.
      await expect(flags[3]?.querySelector('[data-slot="section-chip"]')).toBeNull();
      const authors = [...q.querySelectorAll<HTMLElement>('[data-slot="author-block"]')];
      await expect(authors[0]).toHaveTextContent('Suspended');
      await expect(authors[0]).not.toHaveTextContent('pts');
      // Someone who has left: no name, no posting rights, no count made up.
      await expect(authors[1]).toHaveTextContent('Someone who has left');
      await expect(authors[1]).toHaveTextContent('Not recorded yet');
      await expect(authors[1]).not.toHaveTextContent('Can post');
    }
  },
};
