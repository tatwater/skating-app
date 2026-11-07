import type { Meta, StoryObj } from '@storybook/react-vite';
import { type ReactNode, useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import { Button } from './button';
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './dialog';
import { Kbd } from './kbd';
import {
  computedColor,
  contrastBetween,
  JUNCTION_TOLERANCE_PX,
  resolvePx,
  sameColor,
} from './measure';
import { closeWithEscape, must, openWith, useQuadOpen } from './storyKit';

const meta = {
  title: 'Kit/Dialog',
  component: Dialog,
  tags: ['autodocs'],
} satisfies Meta<typeof Dialog>;

export default meta;
type Story = StoryObj<typeof meta>;

const KEYS: ReadonlyArray<[string, string]> = [
  ['J', 'Next row'],
  ['K', 'Previous row'],
  ['P', 'Promote'],
  ['S', 'Suppress'],
  ['⇧⏎', 'Back to the queue'],
  ['/', 'Search'],
];

/** The open dialog's parts, wherever it was portaled. */
const popup = (root: ParentNode = document) =>
  root.querySelector<HTMLElement>('[data-slot="dialog-content"]');
const scrim = (root: ParentNode = document) =>
  root.querySelector<HTMLElement>('[data-slot="dialog-scrim"]');
const part = (root: Element, slot: string) =>
  must(root.querySelector<HTMLElement>(`[data-slot="${slot}"]`));

/** What a motion token computes to here: zero under reduced motion. */
const motion = (ms: number) =>
  matchMedia('(prefers-reduced-motion: reduce)').matches ? '0s' : `${ms / 1000}s`;

function KeyRows({ repeat = 1 }: { repeat?: number }) {
  const rows = Array.from({ length: repeat }, () => KEYS).flat();
  return (
    <>
      {rows.map(([key, what], i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: the rows repeat on purpose
          key={i}
          className="flex items-center justify-between gap-(--space-4)"
        >
          <span>{what}</span>
          <Kbd variant="dim">{key}</Kbd>
        </div>
      ))}
    </>
  );
}

type KeysDialogProps = {
  /** Only a four-up quad controls it (`useQuadOpen`); every other story leaves it to the trigger. */
  open?: boolean;
  onOpenChange?: (open: boolean, details: { reason: string; event?: Event }) => void;
  modal?: boolean;
  container?: HTMLElement | null;
  loading?: boolean;
  repeat?: number;
  foot?: ReactNode;
};

/** The `?` key sheet as a dialog: a title, the words, the rows, one way out. */
function KeysDialog({
  open,
  onOpenChange,
  modal,
  container,
  loading,
  repeat,
  foot,
}: KeysDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal={modal}>
      <DialogTrigger render={<Button />}>Keys</DialogTrigger>
      <DialogContent container={container}>
        <DialogHeader>
          <DialogTitle>Keys</DialogTitle>
          <DialogDescription>Every key this page listens for.</DialogDescription>
        </DialogHeader>
        <DialogBody loading={loading}>
          <KeyRows repeat={repeat} />
        </DialogBody>
        <DialogFooter note="Letters act while the list has focus">
          {foot}
          <DialogClose render={<Button variant="primary" />}>Done</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The trigger lights on keyboard focus; Enter opens the dialog and focus moves in. Esc closes it
 * and focus comes back; so does a press on the scrim. Square, on the panel ground, the scrim token
 * behind with no blur, and no close × — Done is the way out.
 */
export const Default: Story = {
  render: () => <KeysDialog />,
  play: async ({ canvasElement }) => {
    const trigger = within(canvasElement).getByRole('button', { name: 'Keys' });
    await userEvent.tab();
    await expect(trigger).toHaveFocus();
    await expect(getComputedStyle(trigger).boxShadow).not.toBe('none');
    await userEvent.keyboard('{Enter}');
    const dialog = await waitFor(() => must(popup()));
    await expect(dialog).toHaveAttribute('role', 'dialog');
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    const style = getComputedStyle(dialog);
    await expect(style.borderRadius).toBe('0px');
    await expect(style.backgroundColor).toEqual(sameColor(computedColor(dialog, 'var(--panel)')));
    await expect(style.borderTopColor).toEqual(sameColor(computedColor(dialog, 'var(--line2)')));
    // No ×: the only button is the action, and nothing draws an icon.
    await expect(
      within(dialog)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Done']);
    await expect(dialog.querySelector('svg')).toBeNull();
    const title = part(dialog, 'dialog-title');
    await expect(getComputedStyle(title).textTransform).toBe('uppercase');
    await expect(dialog).toHaveAccessibleName('Keys');
    await expect(dialog).toHaveAccessibleDescription('Every key this page listens for.');

    const dim = must(scrim());
    await expect(getComputedStyle(dim).backgroundColor).toEqual(
      sameColor(computedColor(dim, 'var(--scrim)')),
    );
    await expect(getComputedStyle(dim).backdropFilter).toBe('none');

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(popup()).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());

    await userEvent.click(trigger);
    await waitFor(() => expect(popup()).not.toBeNull());
    await userEvent.click(must(scrim()));
    await waitFor(() => expect(popup()).toBeNull());

    await userEvent.click(trigger);
    await userEvent.click(within(must(popup())).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(popup()).toBeNull());
  },
};

/**
 * Opening and closing fade, and only fade: opacity on `duration-base` — zero under reduced motion.
 * Nothing scales or zooms.
 */
export const Motion: Story = {
  render: () => <KeysDialog />,
  play: async ({ canvasElement }) => {
    await openWith(canvasElement, 'Keys');
    const dialog = await waitFor(() => must(popup()));
    for (const el of [dialog, must(scrim())]) {
      const style = getComputedStyle(el);
      await expect(style.transitionProperty).toBe('opacity');
      await expect(style.transitionDuration).toBe(motion(200));
      await expect(style.scale).toBe('none');
    }
    // Settled: fully opaque once the opening transition is done.
    await waitFor(() => expect(getComputedStyle(dialog).opacity).toBe('1'));
    await expect(dialog.dataset.startingStyle).toBeUndefined();
    await closeWithEscape(popup);
  },
};

/**
 * The junctions, open: the head, body and foot pad by the surface's gutter; the title sits
 * `space-1_5` over the words and `space-4` under the top edge; the scrim covers the viewport; the
 * words pass AA on the panel.
 */
export const JunctionOpen: Story = {
  render: () => <KeysDialog />,
  play: async ({ canvasElement }) => {
    await openWith(canvasElement, 'Keys');
    const dialog = await waitFor(() => must(popup()));
    await waitFor(() => expect(getComputedStyle(dialog).opacity).toBe('1'));
    const box = dialog.getBoundingClientRect();
    const edge = resolvePx(dialog, 'var(--stroke-hair)');
    const gutter = resolvePx(dialog, 'var(--gap-gutter)');
    const near = (a: number, b: number) =>
      expect(Math.abs(a - b)).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);

    const title = part(dialog, 'dialog-title').getBoundingClientRect();
    const words = part(dialog, 'dialog-description').getBoundingClientRect();
    await near(title.left - box.left - edge, gutter);
    await near(title.top - box.top - edge, resolvePx(dialog, 'var(--space-4)'));
    await near(words.top - title.bottom, resolvePx(dialog, 'var(--space-1_5)'));

    const firstRow = must(
      part(dialog, 'overlay-reserve').firstElementChild,
    ).getBoundingClientRect();
    await near(firstRow.left - box.left - edge, gutter);
    const done = within(dialog).getByRole('button', { name: 'Done' }).getBoundingClientRect();
    await near(box.right - edge - done.right, gutter);
    const note = part(dialog, 'dialog-note').getBoundingClientRect();
    await near(note.left - box.left - edge, gutter);

    const dim = must(scrim()).getBoundingClientRect();
    await expect([dim.left, dim.top, dim.width, dim.height]).toEqual([
      0,
      0,
      document.documentElement.clientWidth,
      document.documentElement.clientHeight,
    ]);
    const panel = ['var(--bg)', 'var(--panel)'];
    await expect(contrastBetween(dialog, panel, [...panel, 'var(--fg2)'])).toBeGreaterThanOrEqual(
      4.5,
    );
    await closeWithEscape(popup);
  },
};

/** Long content scrolls inside the body; the dialog stays within the gutter, head and foot in view. */
export const LongContent: Story = {
  render: () => <KeysDialog repeat={20} />,
  play: async ({ canvasElement }) => {
    await openWith(canvasElement, 'Keys');
    const dialog = await waitFor(() => must(popup()));
    const body = part(dialog, 'dialog-body');
    await expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
    const gutter = resolvePx(dialog, 'var(--gap-gutter)');
    const box = dialog.getBoundingClientRect();
    await expect(box.top).toBeGreaterThanOrEqual(gutter - 1);
    await expect(box.bottom).toBeLessThanOrEqual(
      document.documentElement.clientHeight - gutter + 1,
    );
    const foot = part(dialog, 'dialog-footer').getBoundingClientRect();
    await expect(foot.bottom).toBeLessThanOrEqual(box.bottom);
    body.scrollTop = body.scrollHeight;
    await expect(body.scrollTop).toBeGreaterThan(0);
    await closeWithEscape(popup);
  },
};

function LoadingToggle() {
  const [loading, setLoading] = useState(true);
  return (
    <KeysDialog
      loading={loading}
      foot={<Button onClick={() => setLoading((l) => !l)}>{loading ? 'Loaded' : 'Loading'}</Button>}
    />
  );
}

/** Loading reserves the dialog's final size: the rows keep their place, unseen, under a spinner. */
export const Loading: Story = {
  render: () => <LoadingToggle />,
  play: async ({ canvasElement }) => {
    await openWith(canvasElement, 'Keys');
    const dialog = await waitFor(() => must(popup()));
    const body = part(dialog, 'dialog-body');
    await expect(body.querySelector('[aria-busy="true"]')).not.toBeNull();
    await expect(within(dialog).getByRole('status')).toHaveTextContent('Loading');
    await expect(getComputedStyle(part(dialog, 'overlay-reserve')).visibility).toBe('hidden');
    const before = dialog.getBoundingClientRect();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Loaded' }));
    await waitFor(() => expect(within(dialog).queryByRole('status')).toBeNull());
    const after = dialog.getBoundingClientRect();
    await expect([after.width, after.height]).toEqual([before.width, before.height]);
    await expect(getComputedStyle(part(dialog, 'overlay-reserve')).visibility).toBe('visible');
    await closeWithEscape(popup);
  },
};

/** The viewer: a photo or a map opened large — inset `space-8` from every edge, the deep scrim. */
export const Viewer: Story = {
  render: () => (
    <Dialog>
      <DialogTrigger render={<Button />}>Open the photo</DialogTrigger>
      <DialogContent size="viewer">
        <DialogHeader>
          <DialogTitle>Photo</DialogTitle>
          <DialogDescription>Mascoma Lake · 14 Oct · Sarah Whitcomb</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="min-h-[10rem] flex-1 bg-raise" />
        </DialogBody>
        <DialogFooter>
          <DialogClose render={<Button />}>Close</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ),
  play: async ({ canvasElement }) => {
    await openWith(canvasElement, 'Open the photo');
    const dialog = await waitFor(() => must(popup()));
    await expect(dialog.dataset.size).toBe('viewer');
    const inset = resolvePx(dialog, 'var(--space-8)');
    const box = dialog.getBoundingClientRect();
    const { clientWidth, clientHeight } = document.documentElement;
    await expect([box.left, box.top, clientWidth - box.right, clientHeight - box.bottom]).toEqual([
      inset,
      inset,
      inset,
      inset,
    ]);
    const dim = must(scrim());
    await expect(getComputedStyle(dim).backgroundColor).toEqual(
      sameColor(computedColor(dim, 'var(--scrim-deep)')),
    );
    await closeWithEscape(popup);
  },
};

function ScopedDialog() {
  const [frame, setFrame] = useState<HTMLElement | null>(null);
  return (
    <div className="flex h-[26rem] gap-px bg-line">
      <div className="w-[3rem] bg-bg" data-testid="outside" />
      <div
        ref={setFrame}
        data-testid="inspector"
        className="relative flex-1 bg-bg p-gutter text-row text-fg2"
      >
        The inspector
        {frame !== null && <KeysDialog modal={false} container={frame} />}
      </div>
    </div>
  );
}

/**
 * Scoped to a container (the inspector, for an inset card): the scrim and the dialog sit inside it
 * and leave the rest of the page lit. Non-modal and confined, so the check leaves it open.
 */
export const Scoped: Story = {
  render: () => <ScopedDialog />,
  play: async ({ canvasElement }) => {
    await openWith(canvasElement, 'Keys');
    const dialog = await waitFor(() => must(popup(canvasElement)));
    const frame = within(canvasElement).getByTestId('inspector');
    const dim = must(scrim(canvasElement)).getBoundingClientRect();
    const host = frame.getBoundingClientRect();
    await expect([dim.left, dim.top, dim.width, dim.height]).toEqual([
      host.left,
      host.top,
      host.width,
      host.height,
    ]);
    const outside = within(canvasElement).getByTestId('outside').getBoundingClientRect();
    await expect(dim.left).toBeGreaterThanOrEqual(outside.right);
    const box = dialog.getBoundingClientRect();
    await expect(box.left).toBeGreaterThanOrEqual(host.left);
    await expect(box.right).toBeLessThanOrEqual(host.right);
  },
};

function QuadDialog(): ReactNode {
  const [frame, setFrame] = useState<HTMLElement | null>(null);
  const quad = useQuadOpen(frame);
  return (
    <div ref={setFrame} className="relative h-[24rem]">
      {frame !== null && <KeysDialog {...quad} modal={false} container={frame} />}
    </div>
  );
}

/**
 * Open in all four maps, each in its own quad: the console's is denser (smaller title, tighter
 * gutter) and each takes its quad's ground. Each quad's Keys opens its own, non-modal and confined
 * to the quad, so all four can stand open at once.
 */
export const FourUp: Story = {
  render: () => <QuadDialog />,
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) await userEvent.click(within(q).getByRole('button', { name: 'Keys' }));
    const measure = async (q: HTMLElement) => {
      const dialog = await waitFor(() => must(popup(q)));
      const title = part(dialog, 'dialog-title');
      return {
        type: parseFloat(getComputedStyle(title).fontSize),
        pad: parseFloat(getComputedStyle(part(dialog, 'dialog-header')).paddingLeft),
        ground: getComputedStyle(dialog).backgroundColor,
        surface: q.dataset.surface,
      };
    };
    const all = await Promise.all(quads.map(measure));
    const admin = all.filter((m) => m.surface === 'admin');
    const skater = all.filter((m) => m.surface === 'skater');
    await expect(Math.max(...admin.map((m) => m.type))).toBeLessThan(
      Math.min(...skater.map((m) => m.type)),
    );
    await expect(Math.max(...admin.map((m) => m.pad))).toBeLessThan(
      Math.min(...skater.map((m) => m.pad)),
    );
    await expect(new Set(all.map((m) => m.ground)).size).toBeGreaterThan(1);
  },
};
