import type { Meta, StoryObj } from '@storybook/react-vite';
import { type ReactNode, type RefObject, useRef, useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { KeysProvider } from '@/lib/keys';
import { cn } from '@/lib/utils';
import { ActionBar, type ActionBarGroup } from './action-bar';
import { Button } from './button';
import { Input } from './input';
import { computedColor, resolvePx, sameColor } from './measure';
import { PersonLockup } from './person-lockup';
import { must } from './storyKit';
import { ToolbarItem } from './toolbar';

/**
 * The Inbox's action bar, from data: floated at the inspector's foot, every button outlined and
 * alike, each with its key as a chip, a destructive one a hairline box until armed, and a lone
 * action spanning the pane.
 */
const meta = {
  title: 'Kit/ActionBar',
  component: ActionBar,
  globals: { surface: 'admin', mode: 'dark' },
} satisfies Meta<typeof ActionBar>;

export default meta;
type Story = StoryObj<typeof meta>;

const pressed = fn();

/** 2.1's bar: the flag, the report, then the author's menu. */
function safetyGroups(armed = false): ActionBarGroup[] {
  return [
    {
      id: 'flag',
      label: 'Flag',
      items: [
        {
          id: 'dismiss',
          label: 'Dismiss',
          what: 'Closes the flag; the report stays as it is.',
          onPress: () => pressed('dismiss'),
        },
      ],
    },
    {
      id: 'report',
      label: 'Report',
      items: [
        {
          id: 'hide',
          label: 'Hide',
          what: 'Takes the report off the map; it stays on the author’s record.',
          onPress: () => pressed('hide'),
        },
        {
          id: 'remove',
          label: 'Remove',
          what: 'Removes the report and asks for a reason.',
          danger: true,
          armed,
          onPress: () => pressed('remove'),
        },
      ],
    },
    {
      id: 'author',
      label: 'Author',
      items: [
        {
          kind: 'control',
          id: 'author',
          control: (
            <ToolbarItem render={<Button />} aria-label="Rob Tremblay’s menu">
              <PersonLockup name="Rob Tremblay" />
            </ToolbarItem>
          ),
        },
      ],
    },
  ];
}

/** An inspector pane at the board's 1440-wide inspector width, its scroller under the bar. */
function Pane({
  children,
  bar,
  width = 'w-[53rem]',
}: {
  children?: ReactNode;
  bar: (pane: RefObject<HTMLElement | null>) => ReactNode;
  /** The pane's width: the board's inspector, or a phone's 360 px. */
  width?: string;
}) {
  const pane = useRef<HTMLElement>(null);
  return (
    <section
      ref={pane}
      data-pane=""
      tabIndex={-1}
      aria-label="Inspector"
      className={cn(
        'relative h-[16rem] shrink-0 overflow-hidden border border-solid border-line bg-bg',
        width,
      )}
    >
      <div className="flex flex-col gap-(--space-3) p-gutter pb-(--space-20) text-row text-fg2">
        Mascoma Lake · “Black ice, 3½" at the beach, held fine”
        {children}
      </div>
      {bar(pane)}
    </section>
  );
}

const bar = (canvasElement: HTMLElement) => within(canvasElement).getByRole('toolbar');

export const FourUp: Story = {
  args: { groups: safetyGroups(), 'aria-label': 'Flag actions' },
  parameters: { fourUp: true },
  render: (args) => <Pane bar={(pane) => <ActionBar {...args} pane={pane} />} />,
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      const el = within(q).getByRole('toolbar');
      const pane = must(q.querySelector<HTMLElement>('[data-pane]'));
      // Floating: space-2 over the pane's foot, centered, tight to its buttons.
      const p = pane.getBoundingClientRect();
      const b = el.getBoundingClientRect();
      const edge = resolvePx(pane, 'var(--space-2)');
      await expect(Math.abs(p.bottom - 1 - b.bottom - edge)).toBeLessThanOrEqual(0.5);
      await expect(Math.abs(b.left - p.left - (p.right - b.right))).toBeLessThanOrEqual(1);
      await expect(b.width).toBeLessThan(p.width - 2 * edge);
      // Every button rests alike — the destructive one too: no fill, the same hairline ink.
      const dismiss = within(el).getByRole('button', { name: 'Dismiss' });
      const remove = within(el).getByRole('button', { name: 'Remove' });
      for (const button of [dismiss, remove]) {
        await expect(getComputedStyle(button).backgroundColor).toEqual(
          sameColor('rgba(0, 0, 0, 0)'),
        );
      }
      await expect(getComputedStyle(remove).color).toEqual(
        sameColor(getComputedStyle(dismiss).color),
      );
      // Each button's key is its label's letter, as a chip; the reader hears it as the shortcut.
      await expect(dismiss).toHaveAttribute('aria-keyshortcuts', 'D');
      await expect(dismiss).toHaveTextContent('DismissD');
      await expect(within(el).getByText('Flag')).toBeVisible();
    }
  },
};

/** A destructive button armed (its confirm step) turns red; nothing else in the bar changes. */
export const Armed: Story = {
  args: { groups: safetyGroups(true), 'aria-label': 'Flag actions' },
  render: (args) => <Pane bar={(pane) => <ActionBar {...args} pane={pane} />} />,
  play: async ({ canvasElement }) => {
    const remove = within(bar(canvasElement)).getByRole('button', { name: 'Remove' });
    await expect(remove).toHaveAttribute('data-armed');
    const bad = computedColor(remove, 'var(--bad)'); // (a probe: never inside waitFor)
    await waitFor(() => expect(getComputedStyle(remove).color).toEqual(sameColor(bad)));
  },
};

/** What a button does is its tooltip, on focus as on hover: the label, then the sentence. */
export const TooltipSaysWhat: Story = {
  args: { groups: safetyGroups(), 'aria-label': 'Flag actions' },
  render: (args) => <Pane bar={(pane) => <ActionBar {...args} pane={pane} />} />,
  play: async ({ canvasElement }) => {
    const hide = within(bar(canvasElement)).getByRole('button', { name: 'Hide' });
    hide.focus();
    await waitFor(() =>
      expect(document.querySelector('[data-slot="tooltip-title"]')).toHaveTextContent('Hide'),
    );
    await expect(document.querySelector('[data-slot="tooltip-body"]')).toHaveTextContent(
      /off the map/,
    );
    hide.blur();
    await waitFor(() => expect(document.querySelector('[data-slot="tooltip-title"]')).toBeNull());
  },
};

function KeyedPane({ disabled = false, busy = false }: { disabled?: boolean; busy?: boolean }) {
  const [log, setLog] = useState<string[]>([]);
  const groups: ActionBarGroup[] = [
    {
      id: 'g',
      items: [
        {
          id: 'dismiss',
          label: 'Dismiss',
          what: 'Closes the flag.',
          onPress: () => setLog((l) => [...l, 'dismiss']),
          disabled,
          loading: busy,
        },
        {
          id: 'keep',
          label: 'Keep it',
          // K never moves a list: the bar takes another letter.
          hotkey: 'P',
          what: 'Keeps it on the map.',
          onPress: () => setLog((l) => [...l, 'keep']),
        },
        {
          id: 'clear',
          label: 'Clear the ruling',
          hotkey: null,
          what: 'Clears the ruling.',
          onPress: () => setLog((l) => [...l, 'clear']),
        },
      ],
    },
  ];
  return (
    <KeysProvider>
      <Pane bar={(pane) => <ActionBar groups={groups} pane={pane} aria-label="Actions" />}>
        <Input aria-label="Note" placeholder="A note" />
        <output data-slot="log">{log.join(',')}</output>
      </Pane>
    </KeysProvider>
  );
}

/**
 * The keys act in the pane: D dismisses while focus is inside it, a named key stands in for a
 * letter the rules refuse, a keyless button has no chip, and typing in a field types.
 */
export const KeysActInThePane: Story = {
  args: { groups: [], 'aria-label': 'Actions' },
  render: () => <KeyedPane />,
  play: async ({ canvasElement }) => {
    const log = () => must(canvasElement.querySelector('[data-slot="log"]')).textContent;
    const pane = must(canvasElement.querySelector<HTMLElement>('[data-pane]'));
    pane.focus();
    await userEvent.keyboard('d');
    await waitFor(() => expect(log()).toBe('dismiss'));
    await userEvent.keyboard('p');
    await waitFor(() => expect(log()).toBe('dismiss,keep'));
    const clear = within(bar(canvasElement)).getByRole('button', { name: 'Clear the ruling' });
    await expect(clear).not.toHaveAttribute('aria-keyshortcuts');
    await expect(clear.querySelector('[data-slot="kbd"]')).toBeNull();
    // A field keeps its letters.
    const note = within(canvasElement).getByRole('textbox', { name: 'Note' });
    await userEvent.click(note);
    await userEvent.keyboard('d');
    await expect(note).toHaveValue('d');
    await expect(log()).toBe('dismiss,keep');
  },
};

/** A disabled button's key is inert, like its press. */
export const DisabledKeyIsInert: Story = {
  args: { groups: [], 'aria-label': 'Actions' },
  render: () => <KeyedPane disabled />,
  play: async ({ canvasElement }) => {
    const log = () => must(canvasElement.querySelector('[data-slot="log"]')).textContent;
    must(canvasElement.querySelector<HTMLElement>('[data-pane]')).focus();
    await userEvent.keyboard('d');
    await userEvent.keyboard('p');
    await waitFor(() => expect(log()).toBe('keep'));
  },
};

/** A key held down: its press, the browser's key-repeat presses (`repeat`), then its release. */
function hold(target: Element, key: string, code: string, repeats: number) {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, code, bubbles: true }));
  for (let i = 0; i < repeats; i++) {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, code, repeat: true, bubbles: true }));
  }
  target.dispatchEvent(new KeyboardEvent('keyup', { key, code, bubbles: true }));
}

/**
 * A busy button's key is inert too — pressed or held — while its write is out; the other keys act,
 * and a held key acts once, not once per key-repeat.
 */
export const BusyKeyIsInert: Story = {
  args: { groups: [], 'aria-label': 'Actions' },
  render: () => <KeyedPane busy />,
  play: async ({ canvasElement }) => {
    const log = () => must(canvasElement.querySelector('[data-slot="log"]')).textContent;
    const dismiss = within(bar(canvasElement)).getByRole('button', { name: 'Dismiss' });
    await expect(dismiss).toHaveAttribute('aria-busy', 'true');
    const pane = must(canvasElement.querySelector<HTMLElement>('[data-pane]'));
    pane.focus();
    await userEvent.keyboard('d');
    hold(pane, 'd', 'KeyD', 5);
    // A held P acts once; it is the only thing that acted.
    hold(pane, 'p', 'KeyP', 5);
    await waitFor(() => expect(log()).toBe('keep'));
    await userEvent.keyboard('p');
    await waitFor(() => expect(log()).toBe('keep,keep'));
  },
};

/** One action spans the pane, `space-2` from each side, the button grown to fill it. */
export const OneAction: Story = {
  args: {
    'aria-label': 'Ticket actions',
    groups: [
      {
        id: 'ticket',
        items: [
          {
            id: 'resolve',
            label: 'Resolve',
            what: 'Closes the ticket; a reply reopens it.',
            onPress: () => pressed('resolve'),
          },
        ],
      },
    ],
  },
  render: (args) => <Pane bar={(pane) => <ActionBar {...args} pane={pane} />} />,
  play: async ({ canvasElement }) => {
    const el = bar(canvasElement);
    const pane = must(canvasElement.querySelector<HTMLElement>('[data-pane]'));
    await expect(el).toHaveAttribute('data-full');
    const p = pane.getBoundingClientRect();
    const b = el.getBoundingClientRect();
    const edge = resolvePx(pane, 'var(--space-2)');
    await expect(Math.abs(b.left - (p.left + 1) - edge)).toBeLessThanOrEqual(0.5);
    await expect(Math.abs(p.right - 1 - b.right - edge)).toBeLessThanOrEqual(0.5);
    const resolve = within(el).getByRole('button', { name: 'Resolve' });
    const style = getComputedStyle(el);
    const inner =
      b.width -
      parseFloat(style.paddingLeft) -
      parseFloat(style.paddingRight) -
      parseFloat(style.borderLeftWidth) * 2;
    await expect(resolve.getBoundingClientRect().width).toBeCloseTo(inner, 0);
    await expect(getComputedStyle(resolve).backgroundColor).toEqual(sameColor('rgba(0, 0, 0, 0)'));
  },
};

// ── Narrow: a phone's 360 px ─────────────────────────────────────────────────────────────────

const PHONE = 'w-[360px]';

const five: ActionBarGroup[] = [
  {
    id: 'alert',
    label: 'Alert',
    items: [
      { id: 'unpin', label: 'Unpin', what: 'Back to active.', onPress: () => pressed('unpin') },
      {
        id: 'retract',
        label: 'Retract',
        what: 'Gone, no longer true.',
        danger: true,
        onPress: () => pressed('retract'),
      },
    ],
  },
  {
    id: 'flag',
    label: 'Flag',
    items: [
      {
        id: 'dismiss',
        label: 'Dismiss',
        what: 'The flag only.',
        onPress: () => pressed('dismiss'),
      },
      { id: 'hide', label: 'Hide', what: 'Off the map.', onPress: () => pressed('hide') },
      {
        id: 'warn',
        label: 'Warn the author',
        hotkey: 'W',
        what: 'A note.',
        onPress: () => pressed('warn'),
      },
    ],
  },
  safetyGroups()[2] as ActionBarGroup,
];

/** Nothing scrolls sideways: the bar and every control in it inside the pane. */
async function fitsThePane(canvasElement: HTMLElement) {
  const pane = must(canvasElement.querySelector<HTMLElement>('[data-pane]'));
  const el = bar(canvasElement);
  await expect(pane.scrollWidth).toBeLessThanOrEqual(pane.clientWidth);
  const p = pane.getBoundingClientRect();
  for (const node of [el, ...within(el).getAllByRole('button')]) {
    const r = node.getBoundingClientRect();
    await expect(r.left).toBeGreaterThanOrEqual(p.left);
    await expect(r.right).toBeLessThanOrEqual(p.right);
  }
}

/** One action at 360 px: unchanged — it spans the pane, its key beside its label. */
export const NarrowOne: Story = {
  args: OneAction.args as never,
  render: (args) => <Pane width={PHONE} bar={(pane) => <ActionBar {...args} pane={pane} />} />,
  play: async ({ canvasElement }) => {
    const el = bar(canvasElement);
    await expect(el).toHaveAttribute('data-full');
    await expect(el).not.toHaveAttribute('data-narrow');
    await expect(within(el).getByRole('button', { name: 'Resolve' })).toHaveTextContent('ResolveR');
    await fitsThePane(canvasElement);
  },
};

/**
 * Three actions at 360 px (the Access handler's ruling bar): the bar spans the pane, its kickers
 * and hairlines gone; what fits stays with its key, the rest is under More, which names its keys.
 */
export const NarrowThree: Story = {
  args: {
    'aria-label': 'Access actions',
    groups: [
      {
        id: 'ruling',
        label: 'Ruling',
        items: [
          {
            id: 'none',
            label: 'No public access',
            what: 'Dims the body.',
            onPress: () => pressed('none'),
          },
          {
            id: 'open',
            label: 'Confirm accessible',
            hotkey: 'C',
            what: 'Dismisses the reports.',
            onPress: () => pressed('open'),
          },
        ],
      },
      {
        id: 'clear',
        items: [
          {
            id: 'clear',
            label: 'Clear the accessible ruling',
            hotkey: null,
            what: 'Clears it.',
            onPress: () => pressed('clear'),
          },
        ],
      },
    ],
  },
  render: (args) => <Pane width={PHONE} bar={(pane) => <ActionBar {...args} pane={pane} />} />,
  play: async ({ canvasElement }) => {
    const el = bar(canvasElement);
    await waitFor(() => expect(el).toHaveAttribute('data-narrow'));
    await fitsThePane(canvasElement);
    await expect(el.querySelector('[data-slot="toolbar-label"]')).toBeNull();
    await expect(el.querySelector('[data-slot="toolbar-separator"]')).toBeNull();
    const first = within(el).getByRole('button', { name: 'No public access' });
    await expect(first).toHaveTextContent('No public accessN');
    // The keyboard path: one tab stop, the arrows to More, Enter opens it, the folded ones listed.
    first.focus();
    await userEvent.keyboard('{End}');
    const more = within(el).getByRole('button', { name: 'More actions' });
    await expect(more).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    // The menu fades in: wait for the item to be visible, never read it mid-fade.
    await waitFor(() =>
      expect(
        within(document.body).getByRole('menuitem', { name: /Clear the accessible ruling/ }),
      ).toBeVisible(),
    );
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(more).toHaveFocus());
  },
};

/** Five actions and the author's menu at 360 px: every one reachable, every key still acting. */
export const NarrowFive: Story = {
  args: { 'aria-label': 'Alert actions', groups: five },
  render: (args) => (
    <KeysProvider>
      <Pane width={PHONE} bar={(pane) => <ActionBar {...args} pane={pane} />} />
    </KeysProvider>
  ),
  play: async ({ canvasElement }) => {
    pressed.mockClear();
    const el = bar(canvasElement);
    await waitFor(() => expect(el).toHaveAttribute('data-narrow'));
    await fitsThePane(canvasElement);
    // The author's menu stays in the bar; the buttons not shown are all under More.
    await expect(within(el).getByRole('button', { name: 'Rob Tremblay’s menu' })).toBeVisible();
    const shown = within(el)
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label') ?? b.textContent ?? '');
    await userEvent.click(within(el).getByRole('button', { name: 'More actions' }));
    const menu = await within(document.body).findByRole('menu');
    const folded = within(menu)
      .getAllByRole('menuitem')
      .map((m) => m.textContent ?? '');
    for (const label of ['Unpin', 'Retract', 'Dismiss', 'Hide', 'Warn the author']) {
      const inBar = shown.some((t) => t.startsWith(label));
      const inMenu = folded.some((t) => t.startsWith(label));
      await expect(inBar !== inMenu, label).toBe(true);
    }
    // A folded action names its key in the menu.
    await expect(folded.find((t) => t.startsWith('Warn the author'))).toMatch(/W$/);
    await userEvent.keyboard('{Escape}');
    // Its key acts from the pane, folded or not.
    must(canvasElement.querySelector<HTMLElement>('[data-pane]')).focus();
    await userEvent.keyboard('w');
    await waitFor(() => expect(pressed).toHaveBeenCalledWith('warn'));
  },
};
