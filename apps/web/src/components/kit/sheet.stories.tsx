import type { Meta, StoryObj } from '@storybook/react-vite';
import { type ReactNode, useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import { Button } from './button';
import { Field, FieldLabel, Input } from './input';
import { computedColor, JUNCTION_TOLERANCE_PX, resolvePx } from './measure';
import {
  Sheet,
  SheetBody,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from './sheet';
import { must } from './storyKit';

const meta = {
  title: 'Kit/Sheet',
  component: Sheet,
  tags: ['autodocs'],
} satisfies Meta<typeof Sheet>;

export default meta;
type Story = StoryObj<typeof meta>;

const sheets = (root: ParentNode = document) => [
  ...root.querySelectorAll<HTMLElement>('[data-slot="sheet-content"]'),
];
const sheet = (root: ParentNode = document) => sheets(root)[0] ?? null;
const scrim = (root: ParentNode = document) =>
  root.querySelector<HTMLElement>('[data-slot="sheet-scrim"]');
const part = (root: Element, slot: string) =>
  must(root.querySelector<HTMLElement>(`[data-slot="${slot}"]`));
const near = (a: number, b: number) =>
  expect(Math.abs(a - b)).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);

/** What a motion token computes to here: zero under reduced motion. */
const motion = (ms: number) =>
  matchMedia('(prefers-reduced-motion: reduce)').matches ? '0s' : `${ms / 1000}s`;

const RATES: ReadonlyArray<[string, string, string, string]> = [
  ['Sonnet 5.5', 'Million input tokens', '$2.00', '2 Sep'],
  ['', 'Million output tokens', '$10.00', '2 Sep'],
  ['Opus 5.5', 'Million input tokens', '$4.00', '1 Oct'],
  ['', 'Million output tokens', '$20.00', '1 Oct'],
  ['Haiku 4.5', 'Million input tokens', '$1.00', '1 Jul'],
  ['', 'Million output tokens', '$5.00', '1 Jul'],
  ['shared-cpu-1x', 'Machine-minute', '$0.0032', '1 Jul'],
];

function RateRows({ repeat = 1 }: { repeat?: number }) {
  const rows = Array.from({ length: repeat }, () => RATES).flat();
  return (
    <div data-testid="rates" className="flex flex-col">
      {rows.map(([model, unit, price, since], i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: the rows repeat on purpose
          key={i}
          className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto_auto] items-center gap-(--space-4) border-0 border-b border-solid border-line py-(--space-2)"
        >
          <span className="text-fg">{model}</span>
          <span>{unit}</span>
          <span className="font-(family-name:--family-mono) text-mono-sm">{price}</span>
          <span className="text-fg3">{since}</span>
        </div>
      ))}
    </div>
  );
}

/** Change rate: the narrower sheet stacked on top of Rates. */
function ChangeRate({ container }: { container: HTMLElement | null }) {
  return (
    <Sheet>
      <SheetTrigger render={<Button size="sm" />}>Change rate</SheetTrigger>
      <SheetContent container={container} size="sm">
        <SheetHeader>
          <SheetTitle>Change rate</SheetTitle>
          <SheetDescription>Fly · shared-cpu-1x</SheetDescription>
        </SheetHeader>
        <SheetBody>
          <Field>
            <FieldLabel>Price per unit · USD</FieldLabel>
            <Input defaultValue="0.0035" inputMode="decimal" />
          </Field>
        </SheetBody>
        <SheetFooter note="Reprices 1–14 Oct">
          <SheetClose render={<Button />}>Cancel</SheetClose>
          <Button variant="primary">Save rate</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

type RatesSheetProps = {
  container: HTMLElement | null;
  defaultOpen?: boolean;
  open?: boolean;
  modal?: boolean;
  loading?: boolean;
  repeat?: number;
  foot?: ReactNode;
};

/** The reference: Rates, a sheet over the cost ledger. */
function RatesSheet({
  container,
  defaultOpen,
  open,
  modal,
  loading,
  repeat,
  foot,
}: RatesSheetProps) {
  return (
    <Sheet defaultOpen={defaultOpen} open={open} modal={modal}>
      <SheetTrigger render={<Button />}>Rates</SheetTrigger>
      <SheetContent container={container}>
        <SheetHeader>
          <SheetTitle>Rates</SheetTitle>
          <SheetDescription>What a metered unit costs, and since when</SheetDescription>
        </SheetHeader>
        <SheetBody loading={loading}>
          <RateRows repeat={repeat} />
        </SheetBody>
        <SheetFooter note="Metered daily">
          {foot}
          <ChangeRate container={container} />
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

/** The console's frame: the rail, then `main`, which the sheet docks inside. */
function Shell({ children }: { children: (main: HTMLElement) => ReactNode }) {
  const [main, setMain] = useState<HTMLElement | null>(null);
  return (
    <div className="flex h-[32rem] border border-solid border-line">
      <div
        data-testid="rail"
        className="w-rail shrink-0 border-0 border-r border-solid border-line bg-bg"
      />
      <main
        ref={setMain}
        data-testid="main"
        className="relative flex min-w-0 flex-1 flex-col gap-(--space-4) overflow-hidden bg-bg p-gutter text-row text-fg2"
      >
        <span>Cost ledger · Winter 2026–27</span>
        {main !== null && children(main)}
      </main>
    </div>
  );
}

const rectOf = (el: Element) => {
  const r = el.getBoundingClientRect();
  return [r.left, r.top, r.width, r.height];
};

/**
 * Rates over the ledger. The scrim covers `main` only — the rail stays lit; the sheet docks to
 * main's right edge, full height, at its fixed width. No ×: the head carries Close with its Esc
 * key, and Esc closes it.
 */
export const RatesOverLedger: Story = {
  render: () => <Shell>{(main) => <RatesSheet container={main} />}</Shell>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole('button', { name: 'Rates' });
    await userEvent.click(trigger);
    const panel = await waitFor(() => must(sheet()));
    const main = canvas.getByTestId('main');
    await expect(rectOf(must(scrim()))).toEqual(rectOf(main));
    await expect(must(scrim()).getBoundingClientRect().left).toBeGreaterThanOrEqual(
      canvas.getByTestId('rail').getBoundingClientRect().right,
    );
    const dim = must(scrim());
    await expect(getComputedStyle(dim).backgroundColor).toBe(computedColor(dim, 'var(--scrim)'));
    await expect(getComputedStyle(dim).backdropFilter).toBe('none');

    await waitFor(() => expect(getComputedStyle(panel).translate).toBe('none'));
    const box = panel.getBoundingClientRect();
    const host = main.getBoundingClientRect();
    await near(box.right, host.right);
    await near(box.top, host.top);
    await near(box.height, host.height);
    await near(box.width, Math.min(resolvePx(panel, 'var(--size-sheet)'), host.width));

    const style = getComputedStyle(panel);
    await expect(style.backgroundColor).toBe(computedColor(panel, 'var(--bg)'));
    await expect(style.borderLeftColor).toBe(computedColor(panel, 'var(--line2)'));
    await expect(style.borderRadius).toBe('0px');
    const head = part(panel, 'sheet-header');
    await near(head.getBoundingClientRect().height, resolvePx(panel, 'var(--size-top)'));
    const close = within(head).getByRole('button', { name: /Close/ });
    await expect(close).toHaveAttribute('aria-keyshortcuts', 'Escape');
    await expect(close).toHaveTextContent('CloseEsc');
    await expect(panel.querySelector('svg')).toBeNull();

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(sheet()).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
    await userEvent.click(trigger);
    await userEvent.click(within(must(sheet())).getByRole('button', { name: /Close/ }));
    await waitFor(() => expect(sheet()).toBeNull());
  },
};

/**
 * Stacked: Change rate opens over Rates, narrower; Rates dims under the scrim while it's covered.
 * Esc closes only the top sheet.
 */
export const Stacked: Story = {
  render: () => <Shell>{(main) => <RatesSheet container={main} defaultOpen />}</Shell>,
  play: async () => {
    const rates = await waitFor(() => must(sheet()));
    await userEvent.click(within(rates).getByRole('button', { name: 'Change rate' }));
    await waitFor(() => expect(sheets()).toHaveLength(2));
    const change = must(sheets()[1]);
    await expect(rates).toHaveAttribute('data-nested-dialog-open');
    await waitFor(() => expect(getComputedStyle(rates, '::after').opacity).toBe('1'));
    await expect(getComputedStyle(rates, '::after').backgroundColor).toBe(
      computedColor(rates, 'var(--scrim)'),
    );
    await waitFor(() => expect(getComputedStyle(change).translate).toBe('none'));
    await near(change.getBoundingClientRect().width, resolvePx(change, 'var(--size-sheet-sm)'));
    await expect(change.getBoundingClientRect().width).toBeLessThan(
      rates.getBoundingClientRect().width,
    );
    await near(change.getBoundingClientRect().right, rates.getBoundingClientRect().right);

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(sheets()).toHaveLength(1));
    await expect(rates).not.toHaveAttribute('data-nested-dialog-open');
    await waitFor(() => expect(getComputedStyle(rates, '::after').opacity).toBe('0'));
  },
};

/** It slides in from its edge on `duration-slow` (zero under reduced motion); the scrim fades. */
export const Motion: Story = {
  render: () => <Shell>{(main) => <RatesSheet container={main} open />}</Shell>,
  play: async () => {
    const panel = await waitFor(() => must(sheet()));
    const style = getComputedStyle(panel);
    await expect(style.transitionProperty).toBe('translate');
    await expect(style.transitionDuration).toBe(motion(320));
    const dim = getComputedStyle(must(scrim()));
    await expect(dim.transitionProperty).toBe('opacity');
    await expect(dim.transitionDuration).toBe(motion(320));
    await waitFor(() => expect(getComputedStyle(panel).translate).toBe('none'));
  },
};

/**
 * The junctions: the head's title and the body's content start one gutter in; the title's
 * sub-line sits `space-2_5` after it; the foot pads by the gutter and `space-3`.
 */
export const JunctionOpen: Story = {
  render: () => <Shell>{(main) => <RatesSheet container={main} open />}</Shell>,
  play: async () => {
    const panel = await waitFor(() => must(sheet()));
    await waitFor(() => expect(getComputedStyle(panel).translate).toBe('none'));
    const box = panel.getBoundingClientRect();
    const edge = resolvePx(panel, 'var(--stroke-hair)');
    const gutter = resolvePx(panel, 'var(--gap-gutter)');
    const title = part(panel, 'sheet-title').getBoundingClientRect();
    const sub = part(panel, 'sheet-description').getBoundingClientRect();
    await near(title.left - box.left - edge, gutter);
    await near(sub.left - title.right, resolvePx(panel, 'var(--space-2_5)'));
    const close = part(panel, 'sheet-close').getBoundingClientRect();
    await near(box.right - close.right, gutter);
    const rates = within(panel).getByTestId('rates').getBoundingClientRect();
    await near(rates.left - box.left - edge, gutter);
    await near(rates.top - part(panel, 'sheet-header').getBoundingClientRect().bottom, gutter);
    const foot = part(panel, 'sheet-footer');
    const note = part(foot, 'dialog-note').getBoundingClientRect();
    await near(note.left - box.left - edge, gutter);
    await expect(getComputedStyle(foot).backgroundColor).toBe(computedColor(foot, 'var(--bg)'));
    await near(parseFloat(getComputedStyle(foot).paddingTop), resolvePx(panel, 'var(--space-3)'));
  },
};

/** Long content scrolls inside the body; the head and the foot stay in view. */
export const LongContent: Story = {
  render: () => <Shell>{(main) => <RatesSheet container={main} open repeat={12} />}</Shell>,
  play: async () => {
    const panel = await waitFor(() => must(sheet()));
    const body = part(panel, 'sheet-body');
    await expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
    // A right sheet has no bottom edge: the foot sits on the sheet's bottom.
    await near(
      part(panel, 'sheet-footer').getBoundingClientRect().bottom,
      panel.getBoundingClientRect().bottom,
    );
  },
};

function LoadingToggle({ main }: { main: HTMLElement }) {
  const [loading, setLoading] = useState(true);
  return (
    <RatesSheet
      container={main}
      open
      loading={loading}
      foot={<Button onClick={() => setLoading((l) => !l)}>{loading ? 'Loaded' : 'Loading'}</Button>}
    />
  );
}

/** Loading keeps the sheet's size: its width is fixed, and the rows hold their place unseen. */
export const Loading: Story = {
  render: () => <Shell>{(main) => <LoadingToggle main={main} />}</Shell>,
  play: async () => {
    const panel = await waitFor(() => must(sheet()));
    await waitFor(() => expect(getComputedStyle(panel).translate).toBe('none'));
    await expect(within(panel).getByRole('status')).toHaveTextContent('Loading');
    const body = part(panel, 'sheet-body');
    const before = [rectOf(panel), body.scrollHeight];
    await userEvent.click(within(panel).getByRole('button', { name: 'Loaded' }));
    await waitFor(() => expect(within(panel).queryByRole('status')).toBeNull());
    await expect([rectOf(panel), body.scrollHeight]).toEqual(before);
  },
};

/** A phone's sheet docks to the bottom edge, full width, and slides up. */
export const Bottom: Story = {
  render: () => (
    <Sheet open>
      <SheetContent side="bottom">
        <SheetHeader>
          <SheetTitle>Layers</SheetTitle>
        </SheetHeader>
        <SheetBody>
          <span>Depth, hazards and put-ins.</span>
        </SheetBody>
      </SheetContent>
    </Sheet>
  ),
  play: async () => {
    const panel = await waitFor(() => must(sheet()));
    await waitFor(() => expect(getComputedStyle(panel).translate).toBe('none'));
    const box = panel.getBoundingClientRect();
    const { clientWidth, clientHeight } = document.documentElement;
    await expect([box.left, box.width]).toEqual([0, clientWidth]);
    await near(box.bottom, clientHeight);
    await expect(getComputedStyle(panel).borderTopColor).toBe(computedColor(panel, 'var(--line2)'));
    await expect(panel.dataset.side).toBe('bottom');
  },
};

function QuadSheet(): ReactNode {
  const [frame, setFrame] = useState<HTMLElement | null>(null);
  return (
    <div ref={setFrame} className="relative h-[22rem] overflow-hidden">
      {frame !== null && <RatesSheet container={frame} open modal={false} />}
    </div>
  );
}

/** Open in all four maps: the console's head is shorter and its gutter tighter. */
export const FourUp: Story = {
  render: () => <QuadSheet />,
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    const by: Record<string, Array<{ head: number; pad: number }>> = { admin: [], skater: [] };
    for (const q of quads) {
      const panel = await waitFor(() => must(sheet(q)));
      const head = part(panel, 'sheet-header');
      by[must(q.dataset.surface)]?.push({
        head: head.getBoundingClientRect().height,
        pad: parseFloat(getComputedStyle(head).paddingLeft),
      });
    }
    const admin = by.admin ?? [];
    const skater = by.skater ?? [];
    await expect(Math.max(...admin.map((m) => m.head))).toBeLessThan(
      Math.min(...skater.map((m) => m.head)),
    );
    await expect(Math.max(...admin.map((m) => m.pad))).toBeLessThan(
      Math.min(...skater.map((m) => m.pad)),
    );
  },
};
