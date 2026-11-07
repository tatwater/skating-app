import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCopy, faEllipsis, faTrashCan } from '@fortawesome/sharp-regular-svg-icons';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { type ReactNode, useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { Button } from './button';
import {
  DropdownMenu,
  DropdownMenuCaret,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuNote,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './dropdown-menu';
import { computedColor, contrastBetween, JUNCTION_TOLERANCE_PX, resolvePx } from './measure';
import { closeWithEscape, KICKER, must, openWith, useQuadOpen } from './storyKit';

const meta = {
  title: 'Kit/DropdownMenu',
  component: DropdownMenu,
  tags: ['autodocs'],
  // Room under the trigger for the menu.
  decorators: [(Story) => <div className="pb-[16rem]">{Story()}</div>],
} satisfies Meta<typeof DropdownMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The open menu, wherever it was portaled (the document, or a four-up quad). */
const popup = (root: ParentNode = document) =>
  root.querySelector<HTMLElement>('[data-slot="dropdown-menu-content"][data-open]');
const item = (name: string | RegExp) => within(must(popup())).getByRole('menuitem', { name });

const chose = fn();
/** Called once the menu has finished opening (or closing). */
const settled = fn();

/** Waits for the open menu's highlight to land on `name` (and says where it is if not). */
const highlighted = (name: string) =>
  waitFor(() =>
    expect(
      popup()?.querySelector('[data-highlighted] [data-slot="dropdown-menu-text"]')?.textContent ??
        'nothing',
    ).toBe(name),
  );

/** The log's copy menu: icons in their slot, keys in theirs, a kicker over each group. */
function CopyMenu({
  open,
  onOpenChange,
  modal,
  container,
  onOpenChangeComplete,
}: {
  /** Only a four-up quad controls it (`useQuadOpen`); every other story leaves it to the trigger. */
  open?: boolean;
  onOpenChange?: (open: boolean, details: { reason: string; event?: Event }) => void;
  modal?: boolean;
  container?: HTMLElement | null;
  onOpenChangeComplete?: (open: boolean) => void;
}) {
  return (
    <DropdownMenu
      open={open}
      onOpenChange={onOpenChange}
      modal={modal}
      onOpenChangeComplete={onOpenChangeComplete}
    >
      <DropdownMenuTrigger render={<Button size="sm" />}>
        Copy log
        <DropdownMenuCaret />
      </DropdownMenuTrigger>
      <DropdownMenuContent container={container}>
        <DropdownMenuGroup>
          <DropdownMenuLabel>This run</DropdownMenuLabel>
          <DropdownMenuItem
            icon={<FontAwesomeIcon icon={faCopy} />}
            kbd="C"
            aria-keyshortcuts="C"
            onClick={() => chose('log')}
          >
            Copy the whole log
          </DropdownMenuItem>
          <DropdownMenuItem kbd="⇧ C" onClick={() => chose('warnings')}>
            Copy warnings and errors
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => chose('prompt')}>
            Copy a diagnosis prompt
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>Every run</DropdownMenuLabel>
          <DropdownMenuItem disabled onClick={() => chose('all')}>
            Copy all logs
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A rare, destructive page action, alone in a ⋯ menu beside the page's buttons. */
function PageMenu({ onRemove }: { onRemove?: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="bare" size="icon-sm" aria-label="More actions" />}
      >
        <FontAwesomeIcon icon={faEllipsis} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          variant="danger"
          icon={<FontAwesomeIcon icon={faTrashCan} />}
          onClick={onRemove}
        >
          Remove this body…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * A menu button: the caret on the trigger; clicking opens a square plate under it; choosing an
 * item runs it and closes the menu.
 */
export const Default: Story = {
  render: () => <CopyMenu />,
  beforeEach: () => chose.mockClear(),
  play: async ({ canvasElement }) => {
    const trigger = within(canvasElement).getByRole('button', { name: 'Copy log' });
    await expect(trigger.querySelector('svg')).toHaveClass('fa-angle-down');
    await userEvent.click(trigger);
    const plate = await waitFor(() => must(popup()));
    const style = getComputedStyle(plate);
    await expect(style.borderRadius).toBe('0px');
    await expect(style.backgroundColor).toBe(computedColor(plate, 'var(--plate-solid)'));
    await expect(style.borderTopColor).toBe(computedColor(plate, 'var(--line2)'));
    await waitFor(() =>
      expect(plate.getBoundingClientRect().top).toBeGreaterThanOrEqual(
        trigger.getBoundingClientRect().bottom,
      ),
    );
    await userEvent.click(item('Copy warnings and errors'));
    await expect(chose).toHaveBeenCalledWith('warnings');
    await waitFor(() => expect(popup()).toBeNull());
  },
};

/**
 * The keyboard: ↓ on the trigger opens on the first item, ↓ moves, typing jumps to a label (not
 * to a key cap), ⏎ runs it, Esc closes and gives focus back.
 */
export const Keyboard: Story = {
  render: () => <CopyMenu onOpenChangeComplete={settled} />,
  beforeEach: () => {
    chose.mockClear();
    settled.mockClear();
  },
  play: async ({ canvasElement }) => {
    const trigger = within(canvasElement).getByRole('button', { name: 'Copy log' });
    trigger.focus();
    await userEvent.keyboard('{ArrowDown}');
    // Navigate once the menu has opened, as a person would; keys sent mid-transition race it.
    await waitFor(() => expect(settled).toHaveBeenCalledWith(true));
    await highlighted('Copy the whole log');
    await userEvent.keyboard('{ArrowDown}');
    await highlighted('Copy warnings and errors');
    // Type-ahead matches the words: "copy a" lands on the prompt.
    await userEvent.keyboard('copy a');
    await highlighted('Copy a diagnosis prompt');
    await userEvent.keyboard('{Enter}');
    await expect(chose).toHaveBeenCalledWith('prompt');
    await waitFor(() => expect(popup()).toBeNull());
    // Focus came back to the trigger: open again with Enter, and Esc out.
    await waitFor(() => expect(trigger).toHaveFocus());
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(popup()).not.toBeNull());
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(popup()).toBeNull());
    await expect(trigger).toHaveFocus();
  },
};

/**
 * A destructive item reads like any other at rest; highlighted, its words turn red. It opens the
 * confirm rather than acting — the trailing "…" says another step follows.
 */
export const Danger: Story = {
  render: () => <PageMenu onRemove={chose} />,
  beforeEach: () => chose.mockClear(),
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'More actions' }));
    const remove = await waitFor(() => item('Remove this body…'));
    // Highlight off: hover the plate's edge, not the row.
    remove.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
    await waitFor(() => expect(remove).not.toHaveAttribute('data-highlighted'));
    await expect(getComputedStyle(remove).color).toBe(computedColor(remove, 'var(--fg1)'));
    await userEvent.hover(remove);
    await waitFor(() => expect(remove).toHaveAttribute('data-highlighted'));
    const red = computedColor(remove, 'var(--bad)');
    await waitFor(() => expect(getComputedStyle(remove).color).toBe(red));
    await userEvent.click(remove);
    await expect(chose).toHaveBeenCalledOnce();
  },
};

/** A disabled item keeps its place, dimmed; choosing it does nothing and the menu stays. */
export const DisabledItem: Story = {
  render: () => <CopyMenu />,
  beforeEach: () => chose.mockClear(),
  play: async ({ canvasElement }) => {
    await openWith(canvasElement, 'Copy log');
    const all = await waitFor(() => item('Copy all logs'));
    await expect(all).toHaveAttribute('aria-disabled', 'true');
    await expect(getComputedStyle(all).color).toBe(computedColor(all, 'var(--fg-disabled)'));
    await userEvent.click(all, { pointerEventsCheck: 0 });
    await expect(chose).not.toHaveBeenCalled();
    await expect(popup()).not.toBeNull();
    await closeWithEscape(popup);
  },
};

/** Nothing to act on yet: one note row an item tall, so the plate never collapses. */
export const Empty: Story = {
  render: () => (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button size="sm" />}>
        Copy log
        <DropdownMenuCaret />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuNote>Nothing logged yet</DropdownMenuNote>
      </DropdownMenuContent>
    </DropdownMenu>
  ),
  play: async ({ canvasElement }) => {
    await openWith(canvasElement, 'Copy log');
    const plate = await waitFor(() => must(popup()));
    const note = must(plate.querySelector<HTMLElement>('[data-slot="dropdown-menu-note"]'));
    await expect(note.getBoundingClientRect().height).toBeCloseTo(
      resolvePx(plate, 'var(--size-td)'),
      1,
    );
    await expect(getComputedStyle(note).color).toBe(computedColor(note, 'var(--fg3)'));
    await closeWithEscape(popup);
  },
};

/** Open as a board draws it; every live word and kicker passes AA on the plate. */
export const Open: Story = {
  render: () => <CopyMenu />,
  play: async ({ canvasElement }) => {
    await openWith(canvasElement, 'Copy log');
    const plate = await waitFor(() => must(popup()));
    const ground = ['var(--bg)', 'var(--plate-solid)'];
    for (const el of plate.querySelectorAll<HTMLElement>(
      '[data-slot="dropdown-menu-item"]:not([data-disabled]), [data-slot="dropdown-menu-label"]',
    )) {
      const ratio = contrastBetween(el, ground, [...ground, getComputedStyle(el).color]);
      await expect(ratio).toBeGreaterThanOrEqual(4.5);
    }
    await closeWithEscape(popup);
  },
};

function QuadMenu(): ReactNode {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const quad = useQuadOpen(container);
  return (
    <div ref={setContainer} className="relative pb-[15rem]">
      {container !== null && <CopyMenu {...quad} modal={false} container={container} />}
    </div>
  );
}

/**
 * Open in all four maps — each quad's Copy log opens its own menu, portaled into the quad, so it
 * takes that quad's theme. Non-modal here, so all four stand open at once.
 */
export const FourUp: Story = {
  render: () => <QuadMenu />,
  parameters: { fourUp: true },
  decorators: [(Story) => Story()],
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    const plates = new Set<string>();
    for (const q of quads) {
      await userEvent.click(within(q).getByRole('button', { name: 'Copy log' }));
    }
    for (const q of quads) {
      const plate = await waitFor(() => must(popup(q)));
      plates.add(getComputedStyle(plate).backgroundColor);
      const row = must(q.querySelector('[data-slot="dropdown-menu-item"]')).getBoundingClientRect();
      await expect(row.height).toBeCloseTo(resolvePx(q, 'var(--size-td)'), 1);
    }
    await expect(plates.size).toBeGreaterThan(1);
  },
};

// ── Junctions ─────────────────────────────────────────────────────────────────────────────────

/**
 * Rows are a table row tall and inset 1.15 em. The three columns are fixed slots: every label
 * starts at one x whether or not its row has an icon, and every key cap ends at one x however
 * long its label (the widest key sets the column) — the repeated-row rule.
 */
function MenuJunction() {
  return (
    <div className="m-(--space-8)">
      <CopyMenu />
      <p className={`${KICKER} mt-[14rem]`}>Labels and keys in fixed columns</p>
    </div>
  );
}

async function playMenuJunction({ canvasElement }: { canvasElement: HTMLElement }) {
  await openWith(canvasElement, 'Copy log');
  const plate = await waitFor(() => must(popup()));
  const td = resolvePx(plate, 'var(--size-td)');
  const items = [...plate.querySelectorAll<HTMLElement>('[data-slot="dropdown-menu-item"]')];
  await expect(items).toHaveLength(4);
  for (const el of items) await expect(el.getBoundingClientRect().height).toBeCloseTo(td, 1);
  const lefts = items.map(
    (el) => must(el.querySelector('[data-slot="dropdown-menu-text"]')).getBoundingClientRect().left,
  );
  for (const l of lefts)
    await expect(Math.abs(l - must(lefts[0]))).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
  // Two rows carry keys of different widths; their slots end together, at the row's inset.
  const caps = [...plate.querySelectorAll<HTMLElement>('[data-slot="kbd"]')].map((k) =>
    k.getBoundingClientRect(),
  );
  await expect(caps).toHaveLength(2);
  await expect(Math.abs(must(caps[0]).right - must(caps[1]).right)).toBeLessThanOrEqual(
    JUNCTION_TOLERANCE_PX,
  );
  const first = must(items[0]);
  const em = parseFloat(getComputedStyle(first).fontSize);
  await expect(first.getBoundingClientRect().right - must(caps[0]).right).toBeCloseTo(1.15 * em, 0);
  // The icon slot starts 1.15 em in, and the kicker starts there too.
  const icon = must(
    first.querySelector('[data-slot="dropdown-menu-icon"]'),
  ).getBoundingClientRect();
  await expect(icon.left - first.getBoundingClientRect().left).toBeCloseTo(1.15 * em, 0);
  const kicker = must(plate.querySelector('[data-slot="dropdown-menu-label"]'));
  const range = document.createRange();
  range.selectNodeContents(kicker);
  await expect(Math.abs(range.getBoundingClientRect().left - icon.left)).toBeLessThanOrEqual(1);
  // The key caps are the surface's key height, so they never make a row taller.
  await expect(must(caps[0]).height).toBeCloseTo(resolvePx(plate, 'var(--size-key)'), 1);
  await closeWithEscape(popup);
}

export const JunctionColumnsAdmin: Story = {
  render: () => <MenuJunction />,
  globals: { surface: 'admin' },
  play: playMenuJunction,
};

export const JunctionColumnsSkater: Story = {
  render: () => <MenuJunction />,
  globals: { surface: 'skater' },
  play: playMenuJunction,
};
