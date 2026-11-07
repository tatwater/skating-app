import type { Meta, StoryObj } from '@storybook/react-vite';
import { type ReactNode, useEffect, useState } from 'react';
import { expect, fn, spyOn, userEvent, waitFor, within } from 'storybook/test';

import { Button } from './button';
import { computedColor, contrastBetween, JUNCTION_TOLERANCE_PX, resolvePx } from './measure';
import { must, openWith } from './storyKit';
import {
  createToastManager,
  Toaster,
  type ToasterProps,
  type ToastManager,
  type ToastOptions,
  toast,
} from './toast';

const meta = {
  title: 'Kit/Toast',
  component: Toaster,
  tags: ['autodocs'],
} satisfies Meta<typeof Toaster>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A story's `beforeEach`: the page's script sees `prefers-reduced-motion: reduce`. */
function reduceMotion() {
  const real = window.matchMedia.bind(window);
  const spy = spyOn(window, 'matchMedia').mockImplementation((query: string) => {
    const list = real(query);
    if (!query.includes('prefers-reduced-motion')) return list;
    return {
      matches: true,
      media: query,
      onchange: null,
      addEventListener: list.addEventListener.bind(list),
      removeEventListener: list.removeEventListener.bind(list),
      addListener: list.addListener.bind(list),
      removeListener: list.removeListener.bind(list),
      dispatchEvent: list.dispatchEvent.bind(list),
    } satisfies MediaQueryList;
  });
  return () => spy.mockRestore();
}

/**
 * A frame the size of the dock, with its own queue, drawing its toasts inside it (so a story never
 * reaches the app's queue and a four-up quad keeps its toast in its own theme). `seed` toasts are
 * queued once it mounts; `children` gets the queue, to queue more.
 */
function Frame({
  seed = [],
  children,
  ...toaster
}: Omit<ToasterProps, 'manager' | 'contained' | 'container' | 'children'> & {
  seed?: ToastOptions[];
  children?: (manager: ToastManager) => ReactNode;
}) {
  const [manager] = useState(createToastManager);
  // Seeded once, after the Toaster is listening (a queue drops what it's given before then).
  const [initial] = useState(seed);
  const [box, setBox] = useState<HTMLElement | null>(null);
  const ready = box !== null;
  useEffect(() => {
    if (ready) for (const options of initial) toast(options, manager);
  }, [manager, initial, ready]);
  return (
    <div className="flex flex-col gap-heading">
      {children?.(manager)}
      <div ref={setBox} data-frame="" className="relative h-[9rem] w-full max-w-(--size-sheet-sm)">
        {box !== null && <Toaster {...toaster} manager={manager} contained container={box} />}
      </div>
    </div>
  );
}

const toastIn = (root: ParentNode = document) =>
  root.querySelector<HTMLElement>('[data-slot="toast"]');
const toastsIn = (root: ParentNode = document) => [
  ...root.querySelectorAll<HTMLElement>('[data-slot="toast"]'),
];
const slot = (root: ParentNode, name: string) =>
  must(root.querySelector<HTMLElement>(`[data-slot="${name}"]`));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const onUndo = fn();

/**
 * The canonical toast: an operator action's receipt with its Undo. The stripe is white (done), the
 * seconds count down beside the action, and pressing Undo runs it and closes the toast.
 */
export const WithUndo: Story = {
  render: () => (
    <Frame>
      {(manager) => (
        <Button
          className="self-start"
          onClick={() =>
            toast(
              {
                title: 'Photo hidden · Mascoma Lake',
                description: 'It leaves the lake page · the author is told',
                tone: 'lit',
                action: { label: 'Undo', kbd: '⌘Z', onAction: onUndo },
              },
              manager,
            )
          }
        >
          Hide photo
        </Button>
      )}
    </Frame>
  ),
  beforeEach: () => onUndo.mockClear(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Hide photo' }));
    const t = await waitFor(() => must(toastIn(canvasElement)));
    await expect(t).toHaveTextContent('Photo hidden · Mascoma Lake');
    await expect(t).toHaveTextContent('It leaves the lake page · the author is told');
    // The plate: square, the solid plate ground, a strong-rule edge.
    const style = getComputedStyle(t);
    await expect(style.borderRadius).toBe('0px');
    await expect(style.backgroundColor).toBe(computedColor(t, 'var(--plate-solid)'));
    await expect(style.borderTopColor).toBe(computedColor(t, 'var(--line2)'));
    // The stripe: 6 px, white for done.
    const stripe = slot(t, 'toast-stripe');
    await expect(stripe.getBoundingClientRect().width).toBeCloseTo(
      resolvePx(t, 'var(--stroke-tick)'),
      2,
    );
    await expect(getComputedStyle(stripe).backgroundColor).toBe(computedColor(stripe, 'var(--fg)'));
    // The window and the key.
    await expect(slot(t, 'toast-countdown')).toHaveTextContent(/^(10|9) s$/);
    const undo = within(t).getByRole('button', { name: /Undo/ });
    await expect(undo).toHaveAttribute('aria-keyshortcuts', '⌘Z');
    await expect(within(undo).getByText('⌘Z')).toBeInTheDocument();
    await userEvent.click(undo);
    await expect(onUndo).toHaveBeenCalledOnce();
    await waitFor(() => expect(toastIn(canvasElement)).toBeNull());
  },
};

/**
 * The toast's insets: its words start a stripe and a row gap in from the left edge and `space-2_5`
 * down from the top; the action ends `space-3` from the right. The title sits `space-0_5` over its
 * sub-line. The words pass AA on the plate.
 */
export const Insets: Story = {
  render: () => (
    <Frame
      seed={[
        {
          title: 'Rate updated · Open-Meteo',
          description: 'New calls are costed at the new rate',
          action: { label: 'Undo', kbd: '⌘Z', onAction: () => {} },
          timeout: 0,
        },
      ]}
    />
  ),
  play: async ({ canvasElement }) => {
    const t = await waitFor(() => must(toastIn(canvasElement)));
    const box = t.getBoundingClientRect();
    const edge = resolvePx(t, 'var(--stroke-hair)');
    const title = slot(t, 'toast-title').getBoundingClientRect();
    const sub = slot(t, 'toast-description').getBoundingClientRect();
    const action = slot(t, 'toast-action').getBoundingClientRect();
    const near = async (got: number, want: number, what: string) =>
      expect(Math.abs(got - want), what).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
    await near(
      title.left - box.left - edge,
      resolvePx(t, 'var(--stroke-tick)') + resolvePx(t, 'var(--space-3)'),
      'words from the left edge',
    );
    await near(title.top - box.top - edge, resolvePx(t, 'var(--space-2_5)'), 'title from the top');
    await near(
      box.right - edge - action.right,
      resolvePx(t, 'var(--space-3)'),
      'action from the right',
    );
    await near(sub.top - title.bottom, resolvePx(t, 'var(--space-0_5)'), 'title over its sub-line');
    const plate = ['var(--bg)', 'var(--plate-solid)'];
    await expect(contrastBetween(t, plate, [...plate, 'var(--fg3)'])).toBeGreaterThanOrEqual(4.5);
    await expect(contrastBetween(t, plate, [...plate, 'var(--fg)'])).toBeGreaterThanOrEqual(4.5);
  },
};

/**
 * The dock on the console: past the rail by the bar's side gutter, over the status bar by a
 * heading gap — 86 px in and 38 px up on the console — and a small sheet wide.
 */
export const DockedAtTheRail: Story = {
  render: () => <DockedToaster placement="rail" />,
  play: async ({ canvasElement }) => {
    await openWith(canvasElement, 'Save the bay');
    const dock = await waitFor(() =>
      must(document.querySelector<HTMLElement>('[data-placement="rail"]')),
    );
    await waitFor(() => expect(toastIn(dock)).not.toBeNull());
    const box = dock.getBoundingClientRect();
    await expect(box.left).toBeCloseTo(
      resolvePx(dock, 'calc(var(--size-rail) + var(--gap-bar-x))'),
      1,
    );
    await expect(window.innerHeight - box.bottom).toBeCloseTo(
      resolvePx(dock, 'calc(var(--size-status) + var(--gap-heading))'),
      1,
    );
    const rail = resolvePx(dock, 'var(--size-rail)');
    const barX = resolvePx(dock, 'var(--gap-bar-x)');
    await expect(box.width).toBeCloseTo(
      Math.min(resolvePx(dock, 'var(--size-sheet-sm)'), window.innerWidth - rail - 2 * barX),
      1,
    );
    await expect(getComputedStyle(dock).position).toBe('fixed');
    await expect(getComputedStyle(dock).zIndex).toBe('20');
  },
};

/** The dock on skater (no rail, no status bar): the gutter in from the bottom-left corner. */
export const DockedAtTheEdge: Story = {
  render: () => <DockedToaster placement="edge" />,
  play: async ({ canvasElement }) => {
    await openWith(canvasElement, 'Save the bay');
    const dock = await waitFor(() =>
      must(document.querySelector<HTMLElement>('[data-placement="edge"]')),
    );
    await waitFor(() => expect(toastIn(dock)).not.toBeNull());
    const box = dock.getBoundingClientRect();
    const gutter = resolvePx(dock, 'var(--gap-gutter)');
    await expect(box.left).toBeCloseTo(gutter, 1);
    await expect(window.innerHeight - box.bottom).toBeCloseTo(gutter, 1);
  },
};

/**
 * The page's own dock, fixed over the viewport like the app's, so it shows only on a press (never
 * on mount, where it would sit over the page), and leaves on its own time.
 */
function DockedToaster({ placement }: { placement: 'rail' | 'edge' }) {
  const [manager] = useState(createToastManager);
  return (
    <>
      <Button
        onClick={() =>
          toast({ title: 'Bay saved · Shaker cove', description: 'Mascoma Lake' }, manager)
        }
      >
        Save the bay
      </Button>
      <Toaster manager={manager} placement={placement} />
    </>
  );
}

/** Without an action it dismisses on its own: the time bar runs, no countdown. */
export const DismissesOnItsOwn: Story = {
  render: () => <Frame timeout={900} seed={[{ title: 'Rate updated · Open-Meteo' }]} />,
  play: async ({ canvasElement }) => {
    const t = await waitFor(() => must(toastIn(canvasElement)));
    await expect(t.querySelector('[data-slot="toast-countdown"]')).toBeNull();
    await expect(t.querySelector('[data-slot="toast-description"]')).toBeNull();
    const bar = slot(t, 'toast-timebar');
    await expect(bar.getBoundingClientRect().height).toBeCloseTo(
      resolvePx(bar, 'var(--stroke-note)'),
      2,
    );
    await expect(getComputedStyle(bar).backgroundColor).toBe(computedColor(bar, 'var(--fg3)'));
    await waitFor(() => expect(toastIn(canvasElement)).toBeNull(), { timeout: 3000 });
  },
};

/** The seconds count down beside the action, read off the bar — and the bar shrinks with them. */
export const CountsDown: Story = {
  render: () => (
    <Frame
      timeout={3000}
      seed={[{ title: 'Report hidden', action: { label: 'Undo', onAction: () => {} } }]}
    />
  ),
  play: async ({ canvasElement }) => {
    const t = await waitFor(() => must(toastIn(canvasElement)));
    const count = slot(t, 'toast-countdown');
    await expect(count).toHaveTextContent(/^3 s$/);
    await waitFor(() => expect(count).toHaveTextContent(/^2 s$/), { timeout: 2000 });
    const bar = slot(t, 'toast-timebar').getBoundingClientRect();
    await expect(bar.width).toBeLessThan(t.getBoundingClientRect().width * 0.75);
  },
};

/**
 * Hovering the toasts holds the time: the toast stays past its timeout, and the bar and countdown
 * hold with it. Moving away lets it run out.
 */
export const PausesOnHover: Story = {
  render: () => (
    <Frame
      timeout={1200}
      seed={[{ title: 'Report hidden', action: { label: 'Undo', onAction: () => {} } }]}
    />
  ),
  play: async ({ canvasElement }) => {
    const t = await waitFor(() => must(toastIn(canvasElement)));
    await userEvent.hover(t);
    await waitFor(() => expect(t).toHaveAttribute('data-expanded'));
    const bar = slot(t, 'toast-timebar');
    await waitFor(() => expect(bar).toHaveAttribute('data-paused'));
    await expect(must(bar.getAnimations()[0]).playState).toBe('paused');
    const held = slot(t, 'toast-countdown').textContent;
    await sleep(1600);
    // Past its timeout, still here, and the count hasn't moved.
    await expect(toastIn(canvasElement)).toBe(t);
    await expect(slot(t, 'toast-countdown').textContent).toBe(held);
    await userEvent.unhover(t);
    await waitFor(() => expect(toastIn(canvasElement)).toBeNull(), { timeout: 4000 });
  },
};

/** The window in the background holds the time too (Base UI's timer pauses; so does the bar). */
export const PausesInTheBackground: Story = {
  render: () => <Frame timeout={5000} seed={[{ title: 'Report hidden' }]} />,
  play: async ({ canvasElement }) => {
    const t = await waitFor(() => must(toastIn(canvasElement)));
    const bar = slot(t, 'toast-timebar');
    await expect(bar).not.toHaveAttribute('data-paused');
    window.dispatchEvent(new FocusEvent('blur'));
    await waitFor(() => expect(bar).toHaveAttribute('data-paused'));
    await expect(must(bar.getAnimations()[0]).playState).toBe('paused');
    window.dispatchEvent(new FocusEvent('focus'));
    await waitFor(() => expect(bar).not.toHaveAttribute('data-paused'));
    await expect(must(bar.getAnimations()[0]).playState).toBe('running');
  },
};

/**
 * One at a time: a newer toast takes the place of the older, which is hidden and inert until its
 * own time ends (History keeps the action either way).
 */
export const OneAtATime: Story = {
  render: () => (
    <Frame>
      {(manager) => (
        <Button
          className="self-start"
          onClick={() => {
            toast({ title: 'Photo hidden', timeout: 0 }, manager);
            toast({ title: 'Report dismissed', timeout: 0 }, manager);
          }}
        >
          Act twice
        </Button>
      )}
    </Frame>
  ),
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Act twice' }));
    await waitFor(() => expect(toastsIn(canvasElement)).toHaveLength(2));
    const [front, older] = toastsIn(canvasElement);
    await expect(front).toHaveTextContent('Report dismissed');
    await expect(front).not.toHaveAttribute('data-limited');
    await expect(older).toHaveAttribute('data-limited');
    await expect(older).toHaveAttribute('inert');
    await waitFor(() => expect(getComputedStyle(must(older)).opacity).toBe('0'));
  },
};

/** A taller limit stacks them, each peeking above the one in front; a hover fans them out. */
export const Stacked: Story = {
  render: () => (
    <Frame
      limit={3}
      seed={[
        { title: 'Photo hidden', timeout: 0 },
        { title: 'Report dismissed', timeout: 0 },
        { title: 'Rate updated', timeout: 0 },
      ]}
    />
  ),
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(toastsIn(canvasElement)).toHaveLength(3));
    const peek = resolvePx(canvasElement, 'var(--space-1_5)');
    const tops = () => toastsIn(canvasElement).map((t) => t.getBoundingClientRect().top);
    // Collapsed: each one behind sits a peek higher than the one in front.
    await waitFor(() => {
      const [a, b, c] = tops();
      expect(Math.abs(must(a) - must(b) - peek)).toBeLessThanOrEqual(1);
      expect(Math.abs(must(b) - must(c) - peek)).toBeLessThanOrEqual(1);
    });
    await userEvent.hover(must(toastIn(canvasElement)));
    // Fanned out: whole toasts apart.
    await waitFor(() => {
      const [a, b] = toastsIn(canvasElement).map((t) => t.getBoundingClientRect());
      expect(must(a).top - must(b).bottom).toBeGreaterThan(0);
    });
  },
};

/** Queuing with a toast's id updates it in place and restarts its time. */
export const UpdatesInPlace: Story = {
  render: () => (
    <Frame timeout={4000}>
      {(manager) => (
        <Button
          className="self-start"
          onClick={() => {
            toast(
              { id: 'save', title: 'Saving…', action: { label: 'Undo', onAction: () => {} } },
              manager,
            );
            setTimeout(
              () =>
                toast(
                  { id: 'save', title: 'Saved', action: { label: 'Undo', onAction: () => {} } },
                  manager,
                ),
              2200,
            );
          }}
        >
          Save
        </Button>
      )}
    </Frame>
  ),
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Save' }));
    const t = await waitFor(() => must(toastIn(canvasElement)));
    await waitFor(() => expect(slot(t, 'toast-countdown')).toHaveTextContent('3 s'), {
      timeout: 2000,
    });
    await waitFor(() => expect(toastIn(canvasElement)).toHaveTextContent('Saved'), {
      timeout: 2000,
    });
    await expect(toastsIn(canvasElement)).toHaveLength(1);
    // Its time restarted.
    await waitFor(() =>
      expect(slot(must(toastIn(canvasElement)), 'toast-countdown')).toHaveTextContent('4 s'),
    );
  },
};

/** A toast that waits (timeout 0) has no time bar and no countdown. */
export const Persistent: Story = {
  render: () => (
    <Frame
      seed={[
        {
          title: 'Not hidden · the connection dropped',
          description: 'Nothing changed · your reason is kept',
          tone: 'bad',
          action: { label: 'Retry', kbd: '⏎', onAction: () => {} },
          timeout: 0,
        },
      ]}
    />
  ),
  play: async ({ canvasElement }) => {
    const t = await waitFor(() => must(toastIn(canvasElement)));
    await expect(t.querySelector('[data-slot="toast-timebar"]')).toBeNull();
    await expect(t.querySelector('[data-slot="toast-countdown"]')).toBeNull();
    await expect(t).toHaveAttribute('data-type', 'bad');
    const stripe = slot(t, 'toast-stripe');
    await expect(getComputedStyle(stripe).backgroundColor).toBe(
      computedColor(stripe, 'var(--bad)'),
    );
  },
};

/** Under reduced motion the bar ticks once a second instead of gliding. */
export const ReducedMotion: Story = {
  render: () => <Frame timeout={4000} seed={[{ title: 'Rate updated' }]} />,
  beforeEach: reduceMotion,
  play: async ({ canvasElement }) => {
    const t = await waitFor(() => must(toastIn(canvasElement)));
    const anim = must(slot(t, 'toast-timebar').getAnimations()[0]);
    // One step a second (Chromium writes `steps(4, end)` as `steps(4)`).
    await expect(anim.effect?.getTiming().easing).toMatch(/^steps\(4(, end)?\)$/);
  },
};

// ── The tones, and four-up ───────────────────────────────────────────────────────────────────

const TONES: ToastOptions[] = [
  {
    title: 'Photo hidden · Mascoma Lake',
    description: 'It leaves the lake page · the author is told',
    tone: 'lit',
    action: { label: 'Undo', kbd: '⌘Z', onAction: () => {} },
    timeout: 0,
  },
  {
    title: 'Undone · the report is visible again',
    description: 'Both rows stay in the audit log',
    timeout: 0,
  },
  {
    title: 'Bay saved · Shaker cove · back to the inbox',
    description: 'Mascoma Lake',
    tone: 'warn',
    action: { label: 'Stay', kbd: 'Esc', onAction: () => {} },
    timeout: 0,
  },
  {
    title: 'Not hidden · the connection dropped',
    description: 'Nothing changed · your reason is kept',
    tone: 'bad',
    action: { label: 'Retry', kbd: '⏎', onAction: () => {} },
    timeout: 0,
  },
];

function ToneBoard() {
  return (
    <div className="flex flex-col gap-(--space-3)">
      {TONES.map((t) => (
        <Frame key={String(t.title)} seed={[t]} />
      ))}
    </div>
  );
}

/** Done (white), plain (gray), waiting (amber) and failed (red): the stripe carries the tone. */
export const Tones: Story = {
  render: () => <ToneBoard />,
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(toastsIn(canvasElement)).toHaveLength(4));
    const inks = toastsIn(canvasElement).map((t) => {
      const stripe = slot(t, 'toast-stripe');
      return getComputedStyle(stripe).backgroundColor;
    });
    const s = slot(canvasElement, 'toast-stripe');
    await expect(inks).toEqual(
      ['var(--fg)', 'var(--fg2)', 'var(--warn)', 'var(--bad)'].map((c) => computedColor(s, c)),
    );
  },
};

/** All four tones in all four maps. */
export const FourUp: Story = {
  render: () => <ToneBoard />,
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    const plates = new Set<string>();
    for (const q of quads) {
      await waitFor(() => expect(toastsIn(q)).toHaveLength(4));
      plates.add(getComputedStyle(must(toastIn(q))).backgroundColor);
    }
    await expect(plates.size).toBeGreaterThan(1);
  },
};
