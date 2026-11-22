import type { Meta, StoryObj } from '@storybook/react-vite';
import { useRef } from 'react';
import { expect, waitFor, within } from 'storybook/test';

import { KeysProvider } from '@/lib/keys';

import { storyLink } from '../inboxBoard';
import { NOW, PHOTO_ITEM } from '../list/inboxFixtures';
import type { InboxItemView } from '../list/inboxTypes';
import { InboxInspector } from './InboxInspector';

/**
 * The placeholder for a kind this build has no handler for (a newer server's, here a photo flag
 * with the registry emptied): its facts, read only — and, while an old page still decided a kind,
 * one line saying where, with a link there. Every old page has retired, so it says nothing more.
 * facts, read only, and one line saying where that kind is decided for now, with a link there (same
 * tab; the old pages take no params, so a plain link).
 */
function Pane({ item, canReadSupport = true }: { item: InboxItemView; canReadSupport?: boolean }) {
  const pane = useRef<HTMLElement | null>(null);
  return (
    <KeysProvider>
      <section
        ref={pane}
        data-pane="detail"
        tabIndex={-1}
        className="relative flex h-[30rem] w-[52rem] flex-col bg-bg"
      >
        <InboxInspector
          state={{ kind: 'item', item, phase: 'live' }}
          now={NOW}
          pane={pane}
          onBack={() => {}}
          linkFor={storyLink}
          canReadSupport={canReadSupport}
          registry={new Map()}
        />
      </section>
    </KeysProvider>
  );
}

const meta = {
  title: 'Admin/Inbox/Placeholder',
  component: Pane,
  globals: { surface: 'admin', mode: 'dark' },
  args: { item: PHOTO_ITEM },
} satisfies Meta<typeof Pane>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NoHandler: Story = {
  play: async ({ canvasElement }) => {
    await waitFor(() => {
      expect(canvasElement.querySelector('[data-slot="inbox-placeholder-facts"]')).not.toBeNull();
      expect(canvasElement.querySelector('[data-slot="inbox-placeholder-elsewhere"]')).toBeNull();
      expect(within(canvasElement).queryByRole('toolbar')).toBeNull();
    });
  },
};

export const NoHandlerLight: Story = { globals: { surface: 'admin', mode: 'light' } };
