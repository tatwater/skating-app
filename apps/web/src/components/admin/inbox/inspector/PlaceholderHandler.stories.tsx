import type { Meta, StoryObj } from '@storybook/react-vite';
import { useRef } from 'react';
import { expect, within } from 'storybook/test';

import { must } from '@/components/kit/storyKit';
import { KeysProvider } from '@/lib/keys';

import { storyLink } from '../inboxBoard';
import {
  ADMIT_ITEM,
  DRAWN_ITEM,
  NEWFOUND,
  NOW,
  PHOTO_ITEM,
  PLACE_ITEM,
  TICKET_ITEM,
} from '../list/inboxFixtures';
import type { InboxItemView } from '../list/inboxTypes';
import { InboxInspector } from './InboxInspector';

/**
 * The placeholder for each kind the Inbox can't decide yet — a photo flag, a request, a place ask, a
 * drawn body, a support ticket: its facts, read only, and one line saying where that kind is decided
 * for now, with a link there (same tab; the old pages take no params, so a plain link).
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

/** The line, and each link's label and where it goes. */
async function expectElsewhere(root: HTMLElement, line: RegExp, targets: string[]) {
  const block = must(root.querySelector<HTMLElement>('[data-slot="inbox-placeholder-elsewhere"]'));
  await expect(block).toHaveTextContent(line);
  const links = [...block.querySelectorAll<HTMLElement>('[data-slot="inbox-placeholder-link"]')];
  await expect(links.map((l) => l.dataset.to)).toEqual(targets);
  for (const [i, link] of links.entries()) {
    // A link that looks like one: the link chip, its arrow, the console's own path, same tab.
    await expect(link.tagName).toBe('A');
    await expect(link).toHaveAttribute('href', `#${targets[i]}`);
    await expect(link).not.toHaveAttribute('target');
    await expect(link.textContent).toMatch(/→$/);
  }
  // The facts still read under it; no action bar.
  await expect(root.querySelector('[data-slot="inbox-placeholder-facts"]')).not.toBeNull();
  await expect(within(root).queryByRole('toolbar')).toBeNull();
}

export const PhotoFlag: Story = {
  play: ({ canvasElement }) =>
    expectElsewhere(canvasElement, /decided on the Flags page for now/, ['/admin/flags']),
};

export const Request: Story = {
  args: { item: ADMIT_ITEM },
  play: ({ canvasElement }) =>
    expectElsewhere(canvasElement, /decided on the Requests page for now/, [
      '/admin/water/requests',
    ]),
};

export const PlaceAsk: Story = {
  args: { item: PLACE_ITEM },
  play: ({ canvasElement }) =>
    expectElsewhere(canvasElement, /answered by drawing in the body’s editor/, [
      '/admin/water/requests',
      `/admin/water/${NEWFOUND.waterBodyId}`,
    ]),
};

export const DrawnBody: Story = {
  args: { item: DRAWN_ITEM },
  play: ({ canvasElement }) =>
    expectElsewhere(canvasElement, /decided in the Water bodies list for now/, ['/admin/water']),
};

export const Ticket: Story = {
  args: { item: TICKET_ITEM },
  play: ({ canvasElement }) =>
    expectElsewhere(canvasElement, /answered on the Support page for now/, ['/admin/support']),
};

export const PhotoFlagLight: Story = { globals: { surface: 'admin', mode: 'light' } };
