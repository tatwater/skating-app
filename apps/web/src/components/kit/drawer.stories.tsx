import type { Meta, StoryObj } from '@storybook/react-vite';
import { type ReactNode, useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import { Button } from './button';
import {
  DRAWER_SNAP_POINTS,
  Drawer,
  DrawerBody,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  type DrawerProps,
  DrawerTitle,
  DrawerTrigger,
} from './drawer';
import { computedColor, JUNCTION_TOLERANCE_PX, resolvePx, sameColor } from './measure';
import { closeWithEscape, must, openWith, useQuadOpen } from './storyKit';

const meta = {
  title: 'Kit/Drawer',
  component: Drawer,
  tags: ['autodocs'],
  // A phone's sheet: the skater surface.
  globals: { surface: 'skater' },
} satisfies Meta<typeof Drawer>;

export default meta;
type Story = StoryObj<typeof meta>;

const drawer = (root: ParentNode = document) =>
  root.querySelector<HTMLElement>('[data-slot="drawer-content"]');
const scrim = (root: ParentNode = document) =>
  root.querySelector<HTMLElement>('[data-slot="drawer-scrim"]');
const part = (root: Element, slot: string) =>
  must(root.querySelector<HTMLElement>(`[data-slot="${slot}"]`));
const near = (a: number, b: number, tol = JUNCTION_TOLERANCE_PX) =>
  expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Settled: no transition under way, so a rectangle is where the sheet rests. */
async function settled(panel: HTMLElement) {
  await waitFor(() => expect(panel).not.toHaveAttribute('data-starting-style'));
  await pause(16);
  await waitFor(() => expect(panel.getAnimations()).toHaveLength(0));
}

/**
 * A mouse drag from the grab region by `dy` px, in steps with a pause between them so the release
 * carries a walking pace, not a flick (a flick skips snap points by design). Raw pointer events:
 * user-event's pointer API doesn't reach Base UI's swipe start.
 */
async function drag(panel: HTMLElement, dy: number) {
  const grab = part(panel, 'drawer-grab');
  const r = grab.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const fire = (type: string, clientY: number, buttons: number) =>
    grab.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        button: 0,
        buttons,
        clientX: x,
        clientY,
      }),
    );
  fire('pointerdown', y, 1);
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    await pause(24);
    fire('pointermove', y + (dy * i) / steps, 1);
  }
  await pause(120);
  fire('pointerup', y + dy, 0);
}

const MENU = ['Your profile', 'Settings', 'About Gli', 'Sign out'];

function MenuRows() {
  return (
    <ul data-testid="menu" className="m-0 flex list-none flex-col p-0">
      {MENU.map((item) => (
        <li
          key={item}
          className="flex h-(--space-10) items-center border-0 border-b border-dotted border-line text-body text-fg1"
        >
          {item}
        </li>
      ))}
    </ul>
  );
}

type MenuSheetProps = Pick<DrawerProps, 'open' | 'onOpenChange' | 'modal'> & {
  container?: HTMLElement | null;
  loading?: boolean;
  foot?: ReactNode;
};

/** The avatar's menu on a phone: a content-sized sheet over a scrim. */
function MenuSheet({ open, onOpenChange, modal, container, loading, foot }: MenuSheetProps) {
  return (
    <Drawer open={open} onOpenChange={onOpenChange} modal={modal}>
      <DrawerTrigger render={<Button />}>Account</DrawerTrigger>
      <DrawerContent container={container}>
        <DrawerHeader>
          <DrawerTitle>Account</DrawerTitle>
          <DrawerDescription>Kate Donovan</DrawerDescription>
        </DrawerHeader>
        <DrawerBody loading={loading}>
          <MenuRows />
        </DrawerBody>
        <DrawerFooter>
          {foot}
          <DrawerClose render={<Button />}>Done</DrawerClose>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

/** What the lake sheet holds: enough rows that the body scrolls at full height. */
function LakeRows() {
  return (
    <div data-testid="reports" className="flex flex-col gap-(--space-4)">
      {Array.from({ length: 14 }, (_, i) => (
        <p
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholder rows
          key={i}
          className="m-0 border-0 border-b border-dotted border-line pb-(--space-4) text-body text-fg1"
        >
          Report {i + 1} · Mascoma South · from the Shaker Bridge launch
        </p>
      ))}
    </div>
  );
}

/** The lake sheet: half, then full under the top bar. */
function LakeSheet({ modal, scrim: withScrim }: { modal?: boolean; scrim?: boolean }) {
  const [snap, setSnap] = useState<DrawerProps['snapPoint']>(DRAWER_SNAP_POINTS[0]);
  const [closed, setClosed] = useState('');
  return (
    <>
      <Drawer
        snapPoints={DRAWER_SNAP_POINTS}
        snapPoint={snap}
        onSnapPointChange={setSnap}
        modal={modal}
        onOpenChange={(open, details) => {
          if (!open) setClosed(details.reason);
          else setSnap(DRAWER_SNAP_POINTS[0]);
        }}
      >
        <DrawerTrigger render={<Button />}>Mascoma Lake</DrawerTrigger>
        <DrawerContent scrim={withScrim}>
          <DrawerHeader>
            <DrawerTitle>Mascoma Lake</DrawerTitle>
            <DrawerDescription>Reservoir · Enfield, NH</DrawerDescription>
          </DrawerHeader>
          <DrawerBody>
            <LakeRows />
          </DrawerBody>
        </DrawerContent>
      </Drawer>
      <output data-testid="snap" className="sr-only">
        {String(snap)}
      </output>
      <output data-testid="closed" className="sr-only">
        {closed}
      </output>
    </>
  );
}

const viewportHeight = () => document.documentElement.clientHeight;

/**
 * The menu sheet: docked to the bottom, the screen's width, a square top edge with a `line2`
 * rule, and the grab bar centered at its top. Esc closes it and gives focus back to the trigger;
 * so does the head's Close.
 */
export const Menu: Story = {
  render: () => <MenuSheet />,
  play: async ({ canvasElement }) => {
    const trigger = await openWith(canvasElement, 'Account');
    const panel = await waitFor(() => must(drawer()));
    await settled(panel);
    const box = panel.getBoundingClientRect();
    await expect([box.left, box.width]).toEqual([0, document.documentElement.clientWidth]);
    await near(box.bottom, viewportHeight());
    const style = getComputedStyle(panel);
    await expect(style.borderTopColor).toEqual(sameColor(computedColor(panel, 'var(--line2)')));
    await expect(style.borderTopLeftRadius).toBe('0px');
    await expect(style.borderTopRightRadius).toBe('0px');
    await expect(style.backgroundColor).toEqual(sameColor(computedColor(panel, 'var(--bg)')));
    // Content-sized: shorter than full.
    await expect(box.height).toBeLessThan(viewportHeight() - resolvePx(panel, 'var(--size-top)'));

    // The grab: a strip `space-4_5` tall, the bar `space-10` by `space-1` centered in it.
    const grab = part(panel, 'drawer-grab').getBoundingClientRect();
    const handle = part(panel, 'drawer-handle');
    const bar = handle.getBoundingClientRect();
    await near(grab.top, box.top + resolvePx(panel, 'var(--stroke-hair)'));
    await near(grab.height, resolvePx(panel, 'var(--space-4_5)'));
    await near(bar.width, resolvePx(panel, 'var(--space-10)'));
    await near(bar.height, resolvePx(panel, 'var(--space-1)'));
    await near(bar.left + bar.width / 2, box.left + box.width / 2);
    await near(bar.top + bar.height / 2, grab.top + grab.height / 2);
    await expect(getComputedStyle(handle).backgroundColor).toEqual(
      sameColor(computedColor(handle, 'var(--line2)')),
    );
    await expect(part(panel, 'drawer-grab')).toHaveAttribute('aria-hidden', 'true');
    // The head sits right under the grab; the head is the Sheet's, with Close and its Esc key.
    await near(part(panel, 'sheet-header').getBoundingClientRect().top, grab.bottom);
    const close = within(panel).getByRole('button', { name: /Close/ });
    await expect(close).toHaveAttribute('aria-keyshortcuts', 'Escape');

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(drawer()).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
    await userEvent.click(trigger);
    await userEvent.click(within(must(drawer())).getByRole('button', { name: /Close/ }));
    await waitFor(() => expect(drawer()).toBeNull());
    // The foot's own way out.
    await userEvent.click(trigger);
    await userEvent.click(within(must(drawer())).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(drawer()).toBeNull());
  },
};

/** The scrim token under the sheet, no blur; a press on it closes the sheet. */
export const ScrimPress: Story = {
  render: () => <MenuSheet />,
  play: async ({ canvasElement }) => {
    await openWith(canvasElement, 'Account');
    const panel = await waitFor(() => must(drawer()));
    await settled(panel);
    const dim = must(scrim());
    await expect(getComputedStyle(dim).backgroundColor).toEqual(
      sameColor(computedColor(dim, 'var(--scrim)')),
    );
    await expect(getComputedStyle(dim).backdropFilter).toBe('none');
    await expect(dim.getBoundingClientRect().height).toBe(viewportHeight());
    await userEvent.pointer({
      keys: '[MouseLeft]',
      target: dim,
      coords: { clientX: 10, clientY: 10 },
    });
    await waitFor(() => expect(drawer()).toBeNull());
  },
};

function SwipeLog() {
  const [reason, setReason] = useState('');
  return (
    <>
      <MenuSheet
        onOpenChange={(open, details) => {
          if (!open) setReason(details.reason);
        }}
      />
      <output data-testid="closed">{reason}</output>
    </>
  );
}

/** Swipe down to dismiss: a drag down from the grab closes it, and says it was a swipe. */
export const SwipeDown: Story = {
  render: () => <SwipeLog />,
  play: async ({ canvasElement }) => {
    await openWith(canvasElement, 'Account');
    const panel = await waitFor(() => must(drawer()));
    await settled(panel);
    // A short drag springs back.
    await drag(panel, 12);
    await settled(panel);
    await expect(drawer()).not.toBeNull();
    await near(panel.getBoundingClientRect().bottom, viewportHeight());
    // A long one dismisses.
    await drag(panel, panel.getBoundingClientRect().height * 0.8);
    await waitFor(() => expect(drawer()).toBeNull());
    await expect(within(canvasElement).getByTestId('closed')).toHaveTextContent('swipe');
  },
};

/**
 * Snap points — the mocks' half and full. It opens at half (its top at half the screen), drags up
 * to full (its top under the top bar, `data-expanded`), back down to half, and down again to close.
 */
export const SnapPoints: Story = {
  render: () => <LakeSheet />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await openWith(canvasElement, 'Mascoma Lake');
    const panel = await waitFor(() => must(drawer()));
    await settled(panel);
    const H = viewportHeight();
    const top = resolvePx(panel, 'var(--size-top)');
    // The sheet is full height (less the top bar); half shows its upper half of the screen.
    await near(panel.offsetHeight, H - top, 1);
    await near(panel.getBoundingClientRect().top, H / 2, 1);
    await expect(panel).not.toHaveAttribute('data-expanded');
    // The body's foot is padded back into view at half: its scroll height reaches the screen's end.
    const body = part(panel, 'sheet-body');
    await near(body.getBoundingClientRect().bottom, H, 1);

    await drag(panel, -(H / 2 - top));
    await settled(panel);
    await waitFor(() => expect(canvas.getByTestId('snap')).toHaveTextContent('1'));
    await near(panel.getBoundingClientRect().top, top, 1);
    await expect(panel).toHaveAttribute('data-expanded');

    await drag(panel, H / 2 - top);
    await settled(panel);
    await waitFor(() => expect(canvas.getByTestId('snap')).toHaveTextContent('0.5'));
    await near(panel.getBoundingClientRect().top, H / 2, 1);

    await drag(panel, H / 2 - resolvePx(panel, 'var(--space-8)'));
    await waitFor(() => expect(drawer()).toBeNull());
    await expect(canvas.getByTestId('closed')).toHaveTextContent('swipe');
  },
};

/**
 * Over the map: the lake sheet leaves the page behind it live — no scrim, not modal, so a press
 * on the map lands. Esc still closes it.
 */
export const OverTheMap: Story = {
  render: function Render() {
    const [pressed, setPressed] = useState(0);
    return (
      <div className="flex flex-col gap-(--space-4)">
        <button
          type="button"
          data-testid="map"
          onClick={() => setPressed((n) => n + 1)}
          className="h-(--space-20) w-full border border-solid border-line bg-panel text-fg3"
        >
          Map · pressed {pressed}
        </button>
        <LakeSheet modal={false} scrim={false} />
      </div>
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await openWith(canvasElement, 'Mascoma Lake');
    const panel = await waitFor(() => must(drawer()));
    await settled(panel);
    await expect(scrim()).toBeNull();
    await userEvent.click(canvas.getByTestId('map'));
    await expect(canvas.getByTestId('map')).toHaveTextContent('pressed 1');
    // A press outside a non-modal sheet doesn't close it either.
    await expect(drawer()).not.toBeNull();
    await closeWithEscape(drawer);
  },
};

function LoadingToggle() {
  const [loading, setLoading] = useState(true);
  return (
    <MenuSheet
      loading={loading}
      foot={<Button onClick={() => setLoading((l) => !l)}>{loading ? 'Loaded' : 'Loading'}</Button>}
    />
  );
}

/** Loading keeps the sheet's size: the rows hold their place, unseen, under the spinner. */
export const Loading: Story = {
  render: () => <LoadingToggle />,
  play: async ({ canvasElement }) => {
    await openWith(canvasElement, 'Account');
    const panel = await waitFor(() => must(drawer()));
    await settled(panel);
    await expect(within(panel).getByRole('status')).toHaveTextContent('Loading');
    const rect = () => {
      const r = panel.getBoundingClientRect();
      return [r.top, r.height];
    };
    const before = rect();
    await userEvent.click(within(panel).getByRole('button', { name: 'Loaded' }));
    await waitFor(() => expect(within(panel).queryByRole('status')).toBeNull());
    await expect(rect()).toEqual(before);
    await closeWithEscape(drawer);
  },
};

/**
 * It slides up on `duration-slow` and leaves on `duration-base`; the scrim fades with it. Under
 * reduced motion every duration is zero and it doesn't move — it fades in place.
 */
export const Motion: Story = {
  render: () => <MenuSheet />,
  play: async ({ canvasElement }) => {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const ms = (n: number) => (reduced ? '0s' : `${n / 1000}s`);
    await openWith(canvasElement, 'Account');
    const panel = await waitFor(() => must(drawer()));
    const style = getComputedStyle(panel);
    await expect(style.transitionProperty).toBe('transform, opacity');
    await expect(style.transitionDuration.split(', ')[0]).toBe(ms(320));
    await expect(getComputedStyle(must(scrim())).transitionDuration).toBe(ms(320));
    await settled(panel);
    await expect(getComputedStyle(panel).opacity).toBe('1');
    await closeWithEscape(drawer);
  },
};

function QuadDrawer(): ReactNode {
  const [frame, setFrame] = useState<HTMLElement | null>(null);
  const quad = useQuadOpen(frame);
  return (
    <div ref={setFrame} className="relative h-[24rem] overflow-hidden">
      {frame !== null && <MenuSheet {...quad} container={frame} modal={false} />}
    </div>
  );
}

/**
 * Open in all four maps, each confined to its quad: the same square edge and grab bar; the
 * skater head is taller and its gutter wider than the console's.
 */
export const FourUp: Story = {
  render: () => <QuadDrawer />,
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads)
      await userEvent.click(within(q).getByRole('button', { name: 'Account' }));
    const by: Record<string, number[]> = { admin: [], skater: [] };
    for (const q of quads) {
      const panel = await waitFor(() => must(drawer(q)));
      await settled(panel);
      const frame = must(panel.closest('[data-theme-scope] .relative'));
      await near(panel.getBoundingClientRect().bottom, frame.getBoundingClientRect().bottom);
      await expect(getComputedStyle(panel).borderTopLeftRadius).toBe('0px');
      await expect(getComputedStyle(panel).borderTopColor).toEqual(
        sameColor(computedColor(panel, 'var(--line2)')),
      );
      by[must(q.dataset.surface)]?.push(part(panel, 'sheet-header').getBoundingClientRect().height);
    }
    await expect(Math.max(...(by.admin ?? []))).toBeLessThan(Math.min(...(by.skater ?? [])));
  },
};
