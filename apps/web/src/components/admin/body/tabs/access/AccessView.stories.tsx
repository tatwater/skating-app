import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { FAILED_READ } from '@/components/admin/reads/readFailureFixtures';
import { computedColor, sameColor } from '@/components/kit/measure';
import { faceLoaded, must } from '@/components/kit/storyKit';
import { InspectorFrame } from '../tabStoryFrame';
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
  onRule: fn(async () => true),
  onMakeOfficial: fn(),
  onHide: fn(async () => true),
  onAddPutIn: fn(),
  onAddLot: fn(),
  onLinkLot: fn(),
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
    // Every put-in can be linked: one with no lot links one, one with a lot changes it.
    await expect(page.getAllByRole('button', { name: 'Link a lot' })).toHaveLength(2);
    await expect(page.getAllByRole('button', { name: 'Change lot' })).toHaveLength(4);
    // An accessible ruling is never green: the statement is the plain ink.
    await expect(getComputedStyle(statement).color).toEqual(
      sameColor(computedColor(statement, 'var(--fg)')),
    );
    await expect(slot(slot(canvasElement, 'posted-rules'), 'section-count')).toHaveTextContent('0');
  },
};

/** The map tasks' entry points: P and L, and each put-in's link. */
export const MapTasks: Story = {
  args: EVERY_LEVER,
  play: async ({ canvasElement, args }) => {
    const page = within(canvasElement);
    await userEvent.click(page.getByRole('button', { name: /Add a put-in/ }));
    await expect(args.onAddPutIn).toHaveBeenCalled();
    await userEvent.click(page.getByRole('button', { name: /Add a lot/ }));
    await expect(args.onAddLot).toHaveBeenCalled();
    const [link] = page.getAllByRole('button', { name: 'Link a lot' });
    await userEvent.click(must(link));
    await expect(args.onLinkLot).toHaveBeenCalledWith(expect.objectContaining({ id: 'pi-lower' }));
  },
};

/** A task up: drawn over the blocks, and the entry points rest. */
export const TaskUp: Story = {
  args: { ...EVERY_LEVER, task: <p data-slot="a-task">A task</p> },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await expect(slot(canvasElement, 'a-task')).toBeVisible();
    await expect(page.queryByRole('button', { name: /Add a put-in/ })).toBeNull();
    await expect(page.queryByRole('button', { name: 'Link a lot' })).toBeNull();
    await expect(page.queryByRole('button', { name: 'Change lot' })).toBeNull();
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
    await expect(slot(canvasElement, 'ruling-earlier')).toHaveTextContent('1 earlier ruling');
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
        history: { earlier: 0, capped: false },
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

/** The history read stopped short: the earlier rulings are a floor, never drawn as whole. */
export const CappedHistory: Story = {
  args: {
    ...EVERY_LEVER,
    data: { ...NO_ACCESS, ruling: { ...NO_ACCESS.ruling, history: { earlier: 19, capped: true } } },
  },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'ruling-earlier')).toHaveTextContent('19+ earlier rulings');
  },
};

/** Who ruled is on its way: the strip's place is held. */
export const HistoryLoading: Story = {
  args: {
    ...EVERY_LEVER,
    data: {
      ...MASCOMA_ACCESS,
      ruling: { ...MASCOMA_ACCESS.ruling, before: undefined, decidedBy: null, history: undefined },
    },
  },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'ruling-strip-loading')).toBeVisible();
    await expect(canvasElement.querySelector('[data-slot="ruling-strip"]')).toBeNull();
  },
};

/** The history landed without the row that made the ruling: who ruled isn't recorded, said so. */
export const WhoRuledNotRecorded: Story = {
  args: {
    ...EVERY_LEVER,
    data: {
      ...MASCOMA_ACCESS,
      ruling: {
        ...MASCOMA_ACCESS.ruling,
        before: undefined,
        decidedBy: null,
        history: { earlier: 0, capped: false },
      },
    },
  },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'ruling-history-absent')).toHaveTextContent(
      'Who ruled and what stood before: Not recorded yet',
    );
    await expect(canvasElement.querySelector('[data-slot="ruling-strip"]')).toBeNull();
  },
};

/**
 * Who ruled and where each launch is couldn't be read: each says so in place, and the note at the
 * top names both with Try again. The ruling itself, from the record, still stands.
 */
export const ReadsFailed: Story = {
  args: {
    ...EVERY_LEVER,
    onRetry: fn(),
    data: {
      ...MASCOMA_ACCESS,
      ruling: {
        ...MASCOMA_ACCESS.ruling,
        before: undefined,
        decidedBy: null,
        history: FAILED_READ,
      },
      putIns: MASCOMA_ACCESS.putIns.map((p) =>
        p.source === 'official' ? p : { ...p, where: FAILED_READ },
      ),
      failures: ['who ruled', 'where each launch is'],
    },
  },
  play: async ({ canvasElement, args }) => {
    const note = slot(canvasElement, 'read-failures');
    await expect(note).toHaveTextContent('Couldn’t read who ruled and where each launch is.');
    await expect(slot(canvasElement, 'ruling-history-failed')).toBeVisible();
    await expect(slot(canvasElement, 'ruling-statement')).toHaveTextContent(
      'Accessible to the public',
    );
    await expect(slots(canvasElement, 'read-failed')).toHaveLength(3);
    await userEvent.click(within(note).getByRole('button', { name: 'Try again' }));
    await expect(args.onRetry).toHaveBeenCalled();
  },
};

/** The record or the access read couldn't be read: the tab says so, with Try again. */
export const AccessFailed: Story = {
  args: { data: FAILED_READ, onRetry: fn() },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'read-failures')).toHaveTextContent(
      'Couldn’t read this body’s record or its access.',
    );
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
