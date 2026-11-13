import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { computedColor, sameColor } from '@/components/kit/measure';
import { faceLoaded, must } from '@/components/kit/storyKit';

import { InspectorFrame } from '../names/tabStoryFrame';
import { AccessView } from './AccessView';
import { BOARD_TODAY, MASCOMA_ACCESS, NO_ACCESS } from './accessFixtures';

/**
 * Board 5.4.4, Body › Access: the tab's column at the board's size. Render `Board` beside
 * `body-v5.html?tab=access` (x 1060–1440, y 178–870) to compare.
 */
const meta = {
  title: 'Admin/Body/Access',
  component: AccessView,
  globals: { surface: 'admin', mode: 'dark' },
  parameters: { layout: 'fullscreen' },
  args: { now: BOARD_TODAY },
  render: (args) => (
    <InspectorFrame>
      <AccessView {...args} />
    </InspectorFrame>
  ),
} satisfies Meta<typeof AccessView>;

export default meta;
type Story = StoryObj<typeof meta>;

const slot = (root: ParentNode, name: string) =>
  must(root.querySelector<HTMLElement>(`[data-slot="${name}"]`));
const slots = (root: ParentNode, name: string) => [
  ...root.querySelectorAll<HTMLElement>(`[data-slot="${name}"]`),
];

const EVERY_LEVER = {
  data: MASCOMA_ACCESS,
  canPlace: true,
  onRule: fn(async () => null),
  onMakeOfficial: fn(),
  onHide: fn(async () => null),
};

/** Board 5.4.4 as drawn. */
export const Board: Story = {
  args: EVERY_LEVER,
  play: async ({ canvasElement }) => {
    const statement = slot(canvasElement, 'ruling-statement');
    await faceLoaded(statement);
    // The skater's line, as the app says it — a status, no period.
    await expect(statement).toHaveTextContent(/^Accessible to the public$/);
    // The strip: before, the ruling's date, the days it has stood (a label, not a length).
    await expect(slot(canvasElement, 'ruling-date')).toHaveTextContent('21 Sep 2026');
    await expect(slot(canvasElement, 'ruling-days')).toHaveTextContent('23 days');
    await expect(slot(canvasElement, 'ruling-strip')).toHaveTextContent('No ruling');
    await expect(slot(canvasElement, 'ruling-strip')).toHaveTextContent('Teagan');
    // Six put-ins in two groups; official ones carry their walk, mapped ones their levers.
    await expect(slot(slot(canvasElement, 'put-ins'), 'section-count')).toHaveTextContent('6');
    await expect(slots(canvasElement, 'put-in-group').map((g) => g.textContent)).toEqual([
      'OfficialWalk',
      'FromOSMShown in the app',
    ]);
    const page = within(canvasElement);
    await expect(page.getAllByRole('button', { name: 'Make official' })).toHaveLength(3);
    await expect(page.getAllByRole('button', { name: 'Link a lot' })).toHaveLength(2);
    // An accessible ruling is never green: the statement is the plain ink.
    await expect(getComputedStyle(statement).color).toEqual(
      sameColor(computedColor(statement, 'var(--fg)')),
    );
    await expect(slot(slot(canvasElement, 'posted-rules'), 'section-count')).toHaveTextContent('0');
  },
};

/** Ruling no public access takes something away: it asks why first. */
export const RuleNoPublicAccess: Story = {
  args: EVERY_LEVER,
  play: async ({ canvasElement, args }) => {
    await userEvent.click(
      within(canvasElement).getByRole('button', { name: 'Rule no public access' }),
    );
    const dialog = await within(document.body).findByRole('alertdialog');
    await userEvent.type(within(dialog).getByRole('textbox'), 'Every approach is posted');
    await userEvent.click(within(dialog).getByRole('button', { name: /^Rule no public access/ }));
    await expect(args.onRule).toHaveBeenCalledWith('none', 'Every approach is posted');
    await waitFor(() => expect(document.querySelector('[data-slot="reason-ask"]')).toBeNull());
  },
};

/** Clearing or confirming takes nothing away: no reason asked. */
export const ClearTheRuling: Story = {
  args: EVERY_LEVER,
  play: async ({ canvasElement, args }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Clear the ruling' }));
    await expect(args.onRule).toHaveBeenCalledWith(null);
    await expect(
      within(canvasElement).queryByRole('button', { name: 'Rule accessible' }),
    ).toBeNull();
  },
};

/** No public access, over an earlier accessible ruling; a posted rule; an alert pinned. */
export const NoPublicAccess: Story = {
  args: { ...EVERY_LEVER, data: NO_ACCESS },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await expect(slot(canvasElement, 'ruling-strip')).toHaveTextContent('Ruled accessible');
    await expect(slot(canvasElement, 'ruling-strip')).toHaveTextContent('Ruled no public access');
    await expect(page.getByRole('button', { name: 'Rule accessible' })).toBeVisible();
    await expect(page.queryByRole('button', { name: 'Rule no public access' })).toBeNull();
    await expect(slot(canvasElement, 'alerts')).toHaveTextContent('Gate locked');
    await expect(slot(canvasElement, 'posted-rules')).toHaveTextContent('Open sunrise to sunset');
  },
};

/** No ruling and no history: the statement and the strip are absent, never "none". */
export const NoRuling: Story = {
  args: {
    ...EVERY_LEVER,
    data: {
      ...MASCOMA_ACCESS,
      ruling: {
        verdict: null,
        statement: null,
        decidedAt: null,
        decidedBy: null,
        before: undefined,
      },
    },
  },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector('[data-slot="ruling-strip"]')).toBeNull();
    const page = within(canvasElement);
    await expect(page.getByRole('button', { name: 'Rule accessible' })).toBeVisible();
    await expect(page.queryByRole('button', { name: 'Clear the ruling' })).toBeNull();
  },
};

/** Hiding a mapped launch asks why. */
export const HideALaunch: Story = {
  args: EVERY_LEVER,
  play: async ({ canvasElement, args }) => {
    const [hide] = within(canvasElement).getAllByRole('button', { name: 'Hide' });
    await userEvent.click(must(hide));
    const dialog = await within(document.body).findByRole('alertdialog');
    await userEvent.type(within(dialog).getByRole('textbox'), 'A private dock');
    await userEvent.click(within(dialog).getByRole('button', { name: /^Hide/ }));
    await expect(args.onHide).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'pi-dam' }),
      'A private dock',
    );
  },
};

/** A viewer without the levers: the facts, no controls. */
export const ReadOnly: Story = {
  args: { data: MASCOMA_ACCESS },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByRole('button')).toBeNull();
    await expect(slots(canvasElement, 'put-in')).toHaveLength(6);
  },
};

export const Loading: Story = {
  args: { data: undefined },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'access-tab')).toHaveAttribute('aria-busy', 'true');
  },
};

/** In all four maps. */
export const FourMaps: Story = {
  args: EVERY_LEVER,
  parameters: { fourUp: true },
  render: (args) => (
    <div className="w-(--size-inspector) px-(--space-5)">
      <AccessView {...args} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const quad of quads) {
      const days = slot(quad, 'ruling-days');
      await expect(getComputedStyle(days).color).toEqual(
        sameColor(computedColor(days, 'var(--fg)')),
      );
    }
  },
};
