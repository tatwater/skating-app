import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactNode } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { must } from '@/components/kit/storyKit';
import { ThemePair } from '../../../../../../.storybook/theme';
import { StoryRequestInspector } from './requestBoard';
import {
  activate,
  activateMany,
  activateNoDormancy,
  activateShelved,
  admit,
  admitFlowing,
  admitNoMatch,
  admitPending,
  contest,
  contestNoRuling,
  REQUEST_NOW,
  restore,
  takedown,
} from './requestFixtures';
import type { RequestItem } from './requestModel';

/**
 * Board 2.3 and every request kind derived from it, at the board's inspector size (788 × 874 of the
 * 1440 × 900 board), in both modes: the admit with a catalog match, with none and with a lookup not
 * yet answered, a match the catalog calls flowing water; activate (dormant by the season rule, shelved
 * by a moderator, or with no dormancy served), restore, contest access (with its standing ruling, and
 * without one) and takedown (as an admin, and as a moderator, for whom restore and takedown are an admin's); the
 * viewer's own filing; a decided one; a question past the read's page of asks; and a phone's width.
 */
const meta = {
  title: 'Admin/Inbox/Handlers/Request',
  parameters: { layout: 'fullscreen' },
  globals: { surface: 'admin' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const onWrite = fn(async () => true);

const pair = (ui: () => ReactNode) => (
  <ThemePair surface="admin" columns="one">
    {ui}
  </ThemePair>
);
const one = (item: RequestItem) =>
  pair(() => <StoryRequestInspector item={item} onWrite={onWrite} />);
const quads = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('[data-theme-scope]')];
const bar = (q: HTMLElement) => within(q).queryByRole('toolbar');

/** Each quad's bar draws exactly these buttons (their names, by label). */
async function expectBar(root: HTMLElement, names: string[]) {
  for (const q of quads(root)) {
    if (names.length === 0) {
      await expect(bar(q)).toBeNull();
      continue;
    }
    for (const name of names) {
      await expect(
        within(must(bar(q))).getByRole('button', { name: new RegExp(`^${name}`) }),
      ).toBeVisible();
    }
  }
}

/** 2.3: an admit the catalog matched, asked by two — the asks, the catalog, the two futures. */
export const Admit: Story = {
  render: () => one(admit()),
  play: async ({ canvasElement }) => {
    await expectBar(canvasElement, ['Admit', 'Decline']);
    for (const q of quads(canvasElement)) {
      const s = within(q);
      await expect(s.getByText('Admit a body')).toBeVisible();
      await expect(s.getByText('Asked by 2 · 3 days ago')).toBeVisible();
      await expect(s.getByRole('region', { name: 'The catalog' })).toHaveTextContent(
        '3DHP · YQ4K2',
      );
      // *Nearest* says the served distance; the map draws a leader to the body, with no figure on it.
      await expect(s.getByRole('region', { name: 'The catalog' })).toHaveTextContent(
        'Ricker Pond · 0.8 mi',
      );
      await expect(q.querySelector('[data-style="measure"]')).toBeNull();
      await expect(s.getByRole('region', { name: 'Admitting it' })).toHaveTextContent(
        '2 asks · both told',
      );
      await expect(s.getByRole('region', { name: 'Declining it' })).toHaveTextContent(
        '2 asks · told, with your note',
      );
      await expect(q.querySelector('[data-slot="item-map"]')).not.toBeNull();
      // Nothing runs off the pane sideways.
      const pane = must(q.querySelector<HTMLElement>('[data-pane="inspector"]'));
      await expect(pane.scrollWidth).toBeLessThanOrEqual(pane.clientWidth);
    }
  },
};

/** An admit the catalog didn't match: *Look up again* in *Admit*'s place, and why. */
export const AdmitNoMatch: Story = {
  render: () => one(admitNoMatch()),
  play: async ({ canvasElement }) => {
    await expectBar(canvasElement, ['Look up again', 'Decline']);
    for (const q of quads(canvasElement)) {
      const s = within(q);
      await expect(s.queryByRole('button', { name: /^Admit/ })).toBeNull();
      await expect(s.getByRole('region', { name: 'The catalog' })).toHaveTextContent(
        'No 3DHP feature within 150 m',
      );
      await expect(s.getByRole('region', { name: 'Looking it up again' })).toBeVisible();
    }
  },
};

/** An admit whose lookup hasn't answered yet. */
export const AdmitPending: Story = {
  render: () => one(admitPending()),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      await expect(within(q).getByRole('region', { name: 'The catalog' })).toHaveTextContent(
        'Not answered yet',
      );
    }
  },
};

/** A match the catalog calls flowing water, no body of ours near: *Admit* refused, no *Nearest*. */
export const AdmitFlowing: Story = {
  render: () => one(admitFlowing()),
  play: async ({ canvasElement }) => {
    await expectBar(canvasElement, ['Decline']);
    for (const q of quads(canvasElement)) {
      await expect(must(q.querySelector('[data-slot="request-refusals"]'))).toHaveTextContent(
        /flowing water or a canal/,
      );
      await expect(within(q).queryByRole('button', { name: /^Admit/ })).toBeNull();
      // No nearest body served: no row, and no rule on the map though the answer holds an outline.
      await expect(within(q).getByRole('region', { name: 'The catalog' })).not.toHaveTextContent(
        'Nearest',
      );
      await expect(q.querySelector('[data-style="measure"]')).toBeNull();
    }
  },
};

/** An activate: the body, why it is dormant and since when, what activating brings back. */
export const Activate: Story = {
  render: () => one(activate()),
  play: async ({ canvasElement }) => {
    await expectBar(canvasElement, ['Activate', 'Decline']);
    for (const q of quads(canvasElement)) {
      const s = within(q);
      await expect(s.getByText('Activation')).toBeVisible();
      await expect(s.getByRole('heading', { name: 'Lake Tarleton' })).toBeVisible();
      await expect(s.getByText('Lake or pond · Piermont, NH · 329 ac')).toBeVisible();
      const activating = s.getByRole('region', { name: 'Activating it' });
      await expect(activating).toHaveTextContent('Enrichment queues it if it has none');
      await expect(activating).toHaveTextContent('Inactive · since 18 Dec 2025');
      await expect(must(q.querySelector('[data-slot="open-in-body"]'))).toHaveTextContent(
        'Open in Body',
      );
    }
  },
};

/** An activate whose body a moderator shelved: the reason, the note skaters read, who set it. */
export const ActivateShelved: Story = {
  render: () => one(activateShelved()),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      const activating = within(q).getByRole('region', { name: 'Activating it' });
      await expect(activating).toHaveTextContent('Moderator · since 24 Sep 2026');
      await expect(activating).toHaveTextContent('“Shelved while the town rebuilds the launch.”');
      await expect(activating).toHaveTextContent('Matt');
    }
  },
};

/** An activate with no dormancy served: no reason drawn, never an invented one. */
export const ActivateNoDormancy: Story = {
  render: () => one(activateNoDormancy()),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      await expect(within(q).getByRole('region', { name: 'Activating it' })).not.toHaveTextContent(
        'Dormant',
      );
    }
  },
};

/** A restore, as an admin. */
export const Restore: Story = {
  render: () => one(restore()),
  play: async ({ canvasElement }) => {
    await expectBar(canvasElement, ['Restore', 'Decline']);
    for (const q of quads(canvasElement)) {
      await expect(within(q).getByRole('region', { name: 'The body' })).toHaveTextContent(
        'Removed',
      );
    }
  },
};

/** A restore, as a moderator: the server refuses both levers to them — no bar, and its sentence. */
export const RestoreForModerator: Story = {
  render: () => one(restore('moderator')),
  play: async ({ canvasElement }) => {
    await expectBar(canvasElement, []);
    for (const q of quads(canvasElement)) {
      await expect(within(q).getByText('Requires admin role')).toBeVisible();
    }
  },
};

/** Contest access: the standing ruling it contests (the Access handler's event); confirming it accessible. */
export const Contest: Story = {
  render: () => one(contest()),
  play: async ({ canvasElement }) => {
    await expectBar(canvasElement, ['Confirm accessible', 'Decline']);
    for (const q of quads(canvasElement)) {
      await expect(within(q).getByText('Access contested')).toBeVisible();
      await expect(
        within(q).getByRole('region', { name: 'Confirming it accessible' }),
      ).toHaveTextContent('The ruling, to accessible');
      const ruling = within(q).getByRole('region', { name: 'The ruling' });
      await expect(within(ruling).getByText('Standing ruling')).toBeVisible();
      await expect(ruling).toHaveTextContent('Ruled no public access');
      await expect(ruling).toHaveTextContent('Sarah Berman');
      await expect(ruling).toHaveTextContent(
        'Source: The landowner wrote in; the only access is across their field.',
      );
    }
  },
};

/** Contest access on a body whose ruling has since been cleared: the body, no ruling drawn. */
export const ContestNoRuling: Story = {
  render: () => one(contestNoRuling()),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      await expect(within(q).queryByRole('region', { name: 'The ruling' })).toBeNull();
      await expect(within(q).getByRole('region', { name: 'The body' })).toBeVisible();
    }
  },
};

/** A takedown, as an admin: *Take it down* in red. */
export const Takedown: Story = {
  render: () => one(takedown()),
  play: async ({ canvasElement }) => {
    await expectBar(canvasElement, ['Take it down', 'Decline']);
    for (const q of quads(canvasElement)) {
      await expect(
        within(must(bar(q))).getByRole('button', { name: /^Take it down/ }),
      ).toHaveAttribute('data-variant', 'danger');
    }
  },
};

/** A takedown's reason, asked in the reason dialog; T from the inspector opens it, typing nothing. */
export const TakedownAsksItsReason: Story = {
  render: () => <StoryRequestInspector item={takedown()} onWrite={onWrite} />,
  play: async ({ canvasElement }) => {
    const pane = must(canvasElement.querySelector<HTMLElement>('[data-pane="inspector"]'));
    pane.focus();
    await waitFor(() => expect(pane).toHaveFocus());
    await userEvent.keyboard('t');
    const dialog = await waitFor(() =>
      must(document.querySelector<HTMLElement>('[role="alertdialog"]')),
    );
    await expect(dialog).toHaveTextContent('Take it down · Post Pond');
    await expect(within(dialog).getByRole('textbox')).toHaveValue('');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(document.querySelector('[role="alertdialog"]')).toBeNull());
    await expect(onWrite).not.toHaveBeenCalled();
  },
};

/** A takedown, as a moderator: the server refuses both levers to them — no bar, and its sentence. */
export const TakedownForModerator: Story = {
  render: () => one(takedown('moderator')),
  play: async ({ canvasElement }) => {
    await expectBar(canvasElement, []);
    for (const q of quads(canvasElement)) {
      await expect(within(q).getByText('Requires admin role')).toBeVisible();
    }
  },
};

/** The staffer who filed one of its asks (D289): every lever refused, the server's sentence said. */
export const FiledByViewer: Story = {
  render: () => one(admit('filer')),
  play: async ({ canvasElement }) => {
    await expectBar(canvasElement, []);
    for (const q of quads(canvasElement)) {
      await expect(
        within(q).getByText('You filed this, so another staff member decides it.'),
      ).toBeVisible();
    }
  },
};

/** Decided by a colleague while open: the frame's lock, no bar, no refusal said. */
export const DecidedByColleague: Story = {
  render: () =>
    pair(() => (
      <StoryRequestInspector
        item={admit('decided')}
        onWrite={onWrite}
        locked={{
          by: 'Sarah Berman',
          at: REQUEST_NOW - 600_000,
          decisionWord: 'approved',
          byMe: false,
          actionId: 'a1',
        }}
      />
    )),
  play: async ({ canvasElement }) => {
    await expectBar(canvasElement, []);
    for (const q of quads(canvasElement)) {
      await expect(q.querySelector('[data-slot="inbox-inspector-lock"]')).not.toBeNull();
      await expect(q.querySelector('[data-slot="request-refusals"]')).toBeNull();
    }
  },
};

/** More askers than the read holds: the page of fifty, counted to a floor. */
export const ManyAskers: Story = {
  render: () => one(activateMany()),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      const s = within(q);
      await expect(s.getByText('Asked by 500+ · 7 hours ago')).toBeVisible();
      await expect(s.getByText('Showing 50 of 500+ asks')).toBeVisible();
      await expect(s.getByText('500+ people')).toBeVisible();
    }
  },
};

/** A phone's width: the blocks stack, and nothing runs off the pane. */
export const Narrow: Story = {
  render: () => (
    <StoryRequestInspector item={admit()} onWrite={onWrite} width={360} height={1600} />
  ),
  play: async ({ canvasElement }) => {
    const pane = must(canvasElement.querySelector<HTMLElement>('[data-pane="inspector"]'));
    // One read and its assertion inside one retry (the bar settles its narrow form after a measure).
    await waitFor(() => {
      const right = pane.getBoundingClientRect().right + 0.5;
      for (const slot of ['inbox-inspector-head', 'request-handler', 'request-asks']) {
        expect(
          must(pane.querySelector<HTMLElement>(`[data-slot="${slot}"]`)).getBoundingClientRect()
            .right,
        ).toBeLessThanOrEqual(right);
      }
      // The two blocks stack: the catalog sits under the asks.
      const asks = must(pane.querySelector<HTMLElement>('[data-slot="request-asks"]'));
      const catalog = must(pane.querySelector<HTMLElement>('[data-slot="request-catalog"]'));
      expect(catalog.getBoundingClientRect().top).toBeGreaterThanOrEqual(
        asks.getBoundingClientRect().bottom,
      );
    });
  },
};
