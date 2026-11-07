import type { Meta, StoryObj } from '@storybook/react-vite';
import { type ReactNode, useState } from 'react';
import { type GroupProps, type Layout, useGroupRef, usePanelRef } from 'react-resizable-panels';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { Button } from './button';
import { computedColor, resolvePx, sameColor } from './measure';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from './resizable';
import { ScrollArea } from './scroll-area';
import { KICKER, must } from './storyKit';

const meta = {
  title: 'Kit/Resizable',
  component: ResizablePanelGroup,
  tags: ['autodocs'],
} satisfies Meta<typeof ResizablePanelGroup>;

export default meta;
type Story = StoryObj<typeof meta>;

const QUEUE = [
  'Mascoma Lake',
  'Goose Pond',
  'Post Pond',
  'Crystal Lake',
  'Lake Sunapee',
  'Little Sunapee',
  'Pleasant Lake',
  'Kezar Lake',
  'Eastman Lake',
  'Lake Morey',
  'Lake Fairlee',
  'Silver Lake',
];

function Pane({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex size-full min-h-0 flex-col">
      <div
        className={`${KICKER} flex h-td shrink-0 items-center border-0 border-b border-solid border-line px-gutter`}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function Queue() {
  return (
    <ScrollArea className="min-h-0 flex-1">
      <ul className="m-0 list-none px-gutter py-0">
        {QUEUE.map((name, i) => (
          <li
            key={name}
            className="flex h-td items-center justify-between border-0 border-b border-dotted border-line text-row text-fg1"
          >
            <span>{name}</span>
            <span className="font-(family-name:--family-mono) text-mono-sm text-fg3">
              {i + 2} d
            </span>
          </li>
        ))}
      </ul>
    </ScrollArea>
  );
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <div data-frame="" className="h-[18rem] w-[56rem] border border-solid border-line bg-bg">
      {children}
    </div>
  );
}

const panel = (scope: Element, id: string) =>
  must(scope.querySelector<HTMLElement>(`[data-panel][id="${id}"]`));
const handles = (scope: Element) => [
  ...scope.querySelectorAll<HTMLElement>('[data-slot="resizable-handle"]'),
];
const width = (el: Element) => el.getBoundingClientRect().width;

/** The console's three panes: the queue, the record, the map. Sizes in px, with limits. */
function Shell() {
  const map = usePanelRef();
  return (
    <div className="flex flex-col gap-heading">
      <Frame>
        <ResizablePanelGroup id="shell">
          <ResizablePanel id="queue" defaultSize={280} minSize={220} maxSize={420}>
            <Pane title="Inbox">
              <Queue />
            </Pane>
          </ResizablePanel>
          <ResizableHandle aria-label="Resize the queue" />
          <ResizablePanel id="record" minSize={320}>
            <Pane title="Report" />
          </ResizablePanel>
          <ResizableHandle aria-label="Resize the map" />
          <ResizablePanel
            id="map"
            panelRef={map}
            defaultSize={260}
            minSize={200}
            collapsible
            collapsedSize={0}
          >
            <Pane title="Map" />
          </ResizablePanel>
        </ResizablePanelGroup>
      </Frame>
      <div className="flex gap-(--space-2)">
        <Button size="sm" onClick={() => map.current?.collapse()}>
          Hide map
        </Button>
        <Button size="sm" onClick={() => map.current?.expand()}>
          Show map
        </Button>
      </div>
    </div>
  );
}

/**
 * The shell's panes start at their px sizes; the edges between them are hairlines in the panes'
 * own `line`.
 */
export const Panes: Story = {
  render: () => <Shell />,
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(width(panel(canvasElement, 'queue'))).toBeCloseTo(280, 0));
    await expect(width(panel(canvasElement, 'map'))).toBeCloseTo(260, 0);
    for (const h of handles(canvasElement)) {
      await expect(h).toHaveAttribute('role', 'separator');
      await expect(h).toHaveAttribute('aria-orientation', 'vertical');
      await expect(width(h)).toBe(1);
      await expect(getComputedStyle(h).backgroundColor).toEqual(
        sameColor(computedColor(h, 'var(--line)')),
      );
    }
  },
};

/**
 * From the keyboard: Tab reaches the edge; the arrows resize, Home and End stop at the pane's
 * limits; focus doubles the hairline in the bright ink.
 */
export const Keyboard: Story = {
  render: () => <Shell />,
  play: async ({ canvasElement }) => {
    const queue = panel(canvasElement, 'queue');
    await waitFor(() => expect(width(queue)).toBeCloseTo(280, 0));
    const [edge] = handles(canvasElement);
    must(edge).focus();
    await waitFor(() => expect(edge).toHaveAttribute('data-separator', 'focus'));
    const bright = computedColor(must(edge), 'var(--fg)');
    await waitFor(() =>
      expect(getComputedStyle(must(edge)).backgroundColor).toEqual(sameColor(bright)),
    );
    await waitFor(() => expect(getComputedStyle(must(edge)).boxShadow).toMatch(/1px 0px 0px 0px/));
    const before = width(queue);
    await userEvent.keyboard('{ArrowRight}');
    await waitFor(() => expect(width(queue)).toBeGreaterThan(before));
    // End stops at the queue's maximum — or sooner, where the panes after it reach theirs.
    const frame = must(canvasElement.querySelector('[data-frame]'));
    const room = frame.clientWidth - 2 - 320 - 200; // less two edges, the record's and the map's minimums
    await userEvent.keyboard('{End}');
    await waitFor(() => expect(width(queue)).toBeCloseTo(Math.min(420, room), 0));
    await userEvent.keyboard('{Home}');
    await waitFor(() => expect(width(queue)).toBeCloseTo(220, 0));
    await expect(Number(edge?.getAttribute('aria-valuenow'))).toBeGreaterThan(0);
    must(edge).blur();
  },
};

/**
 * Collapse: the map folds away and comes back to its size — from a button here, and from the
 * keyboard (Enter on the edge before it folds the pane before that edge, when it's collapsible).
 */
export const Collapse: Story = {
  render: () => <Shell />,
  play: async ({ canvasElement }) => {
    const map = panel(canvasElement, 'map');
    await waitFor(() => expect(width(map)).toBeCloseTo(260, 0));
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Hide map' }));
    await waitFor(() => expect(width(map)).toBe(0));
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Show map' }));
    await waitFor(() => expect(width(map)).toBeCloseTo(260, 0));
    // Dragging the map's edge past its minimum folds it too.
    const [, edge] = handles(canvasElement);
    must(edge).focus();
    await userEvent.keyboard('{End}');
    await waitFor(() => expect(width(map)).toBe(0));
    must(edge).blur();
  },
};

/** A collapsible pane before its edge folds on Enter, and unfolds on Enter again. */
export const EnterFolds: Story = {
  render: () => (
    <Frame>
      <ResizablePanelGroup id="lanes-shell">
        <ResizablePanel id="lanes" defaultSize={200} minSize={160} collapsible>
          <Pane title="Lanes" />
        </ResizablePanel>
        <ResizableHandle aria-label="Resize the lanes" />
        <ResizablePanel id="list" minSize={320}>
          <Pane title="Weather" />
        </ResizablePanel>
      </ResizablePanelGroup>
    </Frame>
  ),
  play: async ({ canvasElement }) => {
    const lanes = panel(canvasElement, 'lanes');
    await waitFor(() => expect(width(lanes)).toBeCloseTo(200, 0));
    const [edge] = handles(canvasElement);
    must(edge).focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(width(lanes)).toBe(0));
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(width(lanes)).toBeCloseTo(200, 0));
    must(edge).blur();
  },
};

/**
 * Sizes as props: a persisted layout seeds the group, and a controlled `layout` follows its
 * owner — here two buttons set it, and a drag or a key reports back through `onLayoutChanged`.
 */
function Controlled({ onLayoutChanged }: Pick<GroupProps, 'onLayoutChanged'>) {
  const [layout, setLayout] = useState<Layout>({ list: 40, inspector: 60 });
  return (
    <div className="flex flex-col gap-heading">
      <Frame>
        <ResizablePanelGroup
          id="controlled"
          layout={layout}
          onLayoutChanged={(next, changed) => {
            setLayout(next);
            onLayoutChanged?.(next, changed);
          }}
        >
          <ResizablePanel id="list" minSize={200}>
            <Pane title="Weather" />
          </ResizablePanel>
          <ResizableHandle aria-label="Resize the list" />
          <ResizablePanel id="inspector" minSize={320}>
            <Pane title="Run" />
          </ResizablePanel>
        </ResizablePanelGroup>
      </Frame>
      <div className="flex items-center gap-(--space-2)">
        <Button size="sm" onClick={() => setLayout({ list: 30, inspector: 70 })}>
          Narrow list
        </Button>
        <Button size="sm" onClick={() => setLayout({ list: 50, inspector: 50 })}>
          Wide list
        </Button>
        <span data-readout="" className="font-(family-name:--family-mono) text-mono-sm text-fg3">
          {`List ${Math.round(layout.list ?? 0)}%`}
        </span>
      </div>
    </div>
  );
}

export const ControlledLayout: Story = {
  args: { onLayoutChanged: fn() },
  render: (args) => <Controlled onLayoutChanged={args.onLayoutChanged} />,
  play: async ({ canvasElement, args }) => {
    const frame = must(canvasElement.querySelector('[data-frame]'));
    const inner = frame.clientWidth - 1; // less the one separator
    const list = panel(canvasElement, 'list');
    await waitFor(() => expect(width(list)).toBeCloseTo(inner * 0.4, 0));
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Wide list' }));
    await waitFor(() => expect(width(list)).toBeCloseTo(inner * 0.5, 0));
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Narrow list' }));
    await waitFor(() => expect(width(list)).toBeCloseTo(inner * 0.3, 0));
    // A key press reports the user's layout, once.
    const [edge] = handles(canvasElement);
    must(edge).focus();
    await userEvent.keyboard('{ArrowRight}');
    await waitFor(() => expect(args.onLayoutChanged).toHaveBeenCalled());
    await waitFor(() =>
      expect(must(canvasElement.querySelector('[data-readout]'))).toHaveTextContent('List 35%'),
    );
    must(edge).blur();
  },
};

/** The group's handle and element pass through, for the shell's own controls. */
function GroupHandles({ onElement }: { onElement: (el: HTMLDivElement | null) => void }) {
  const group = useGroupRef();
  return (
    <div className="flex flex-col gap-heading">
      <Frame>
        <ResizablePanelGroup id="imperative" groupRef={group} elementRef={onElement}>
          <ResizablePanel id="list" defaultSize={300} minSize={200}>
            <Pane title="People" />
          </ResizablePanel>
          <ResizableHandle aria-label="Resize the list" />
          <ResizablePanel id="profile" minSize={320}>
            <Pane title="Profile" />
          </ResizablePanel>
        </ResizablePanelGroup>
      </Frame>
      <div>
        <Button size="sm" onClick={() => group.current?.setLayout({ list: 50, profile: 50 })}>
          Even split
        </Button>
      </div>
    </div>
  );
}

/** Receives the group's element. */
const onElement = fn();

export const Imperative: Story = {
  beforeEach: () => {
    onElement.mockClear();
  },
  render: () => <GroupHandles onElement={onElement} />,
  play: async ({ canvasElement }) => {
    await expect(onElement).toHaveBeenCalledWith(
      canvasElement.querySelector('[data-slot="resizable-panel-group"]'),
    );
    const frame = must(canvasElement.querySelector('[data-frame]'));
    const list = panel(canvasElement, 'list');
    await waitFor(() => expect(width(list)).toBeCloseTo(300, 0));
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Even split' }));
    await waitFor(() => expect(width(list)).toBeCloseTo((frame.clientWidth - 1) / 2, 0));
  },
};

/** A persisted layout (what the shell reads from its cookie) is where the group starts. */
export const PersistedLayout: Story = {
  render: () => (
    <Frame>
      <ResizablePanelGroup id="persisted" defaultLayout={{ list: 35, inspector: 65 }}>
        <ResizablePanel id="list" minSize={200}>
          <Pane title="Corpus" />
        </ResizablePanel>
        <ResizableHandle aria-label="Resize the list" />
        <ResizablePanel id="inspector" minSize={320}>
          <Pane title="Body" />
        </ResizablePanel>
      </ResizablePanelGroup>
    </Frame>
  ),
  play: async ({ canvasElement }) => {
    const frame = must(canvasElement.querySelector('[data-frame]'));
    await waitFor(() =>
      expect(width(panel(canvasElement, 'list'))).toBeCloseTo((frame.clientWidth - 1) * 0.35, 0),
    );
  },
};

/** A column of panes (a log under its run): the edge is a row hairline; ↑↓ resize. */
export const Vertical: Story = {
  render: () => (
    <Frame>
      <ResizablePanelGroup id="run" orientation="vertical">
        <ResizablePanel id="summary" minSize={80}>
          <Pane title="Run" />
        </ResizablePanel>
        <ResizableHandle aria-label="Resize the log" />
        <ResizablePanel id="log" defaultSize={140} minSize={80}>
          <Pane title="Log" />
        </ResizablePanel>
      </ResizablePanelGroup>
    </Frame>
  ),
  play: async ({ canvasElement }) => {
    const [edge] = handles(canvasElement);
    await expect(edge).toHaveAttribute('aria-orientation', 'horizontal');
    await expect(must(edge).getBoundingClientRect().height).toBe(1);
    const log = panel(canvasElement, 'log');
    await waitFor(() => expect(log.getBoundingClientRect().height).toBeCloseTo(140, 0));
    must(edge).focus();
    await userEvent.keyboard('{ArrowUp}');
    await waitFor(() => expect(log.getBoundingClientRect().height).toBeGreaterThan(140));
    await waitFor(() => expect(getComputedStyle(must(edge)).boxShadow).toMatch(/0px 1px 0px 0px/));
    must(edge).blur();
  },
};

/** A fixed edge: the hairline stays, nothing moves it. */
export const DisabledEdge: Story = {
  render: () => (
    <Frame>
      <ResizablePanelGroup id="fixed">
        <ResizablePanel id="rail" defaultSize={240}>
          <Pane title="Lanes" />
        </ResizablePanel>
        <ResizableHandle disabled aria-label="Lanes edge" />
        <ResizablePanel id="main">
          <Pane title="Season" />
        </ResizablePanel>
      </ResizablePanelGroup>
    </Frame>
  ),
  play: async ({ canvasElement }) => {
    const [edge] = handles(canvasElement);
    await expect(edge).toHaveAttribute('aria-disabled', 'true');
    await expect(edge).toHaveAttribute('data-separator', 'disabled');
    const rail = panel(canvasElement, 'rail');
    await waitFor(() => expect(width(rail)).toBeCloseTo(240, 0));
    must(edge).focus();
    await userEvent.keyboard('{ArrowRight}');
    await expect(width(rail)).toBeCloseTo(240, 0);
    must(edge).blur();
  },
};

export const FourUp: Story = {
  render: () => (
    <div className="h-[8rem] w-[22rem] border border-solid border-line">
      <ResizablePanelGroup>
        <ResizablePanel id="a" minSize={80}>
          <Pane title="Inbox" />
        </ResizablePanel>
        <ResizableHandle aria-label="Resize" />
        <ResizablePanel id="b" minSize={80}>
          <Pane title="Report" />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  ),
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      const [edge] = handles(q);
      await expect(getComputedStyle(must(edge)).backgroundColor).toEqual(
        sameColor(computedColor(q, 'var(--line)')),
      );
      await expect(width(must(edge))).toBe(1);
    }
  },
};

// ── Hit area ──────────────────────────────────────────────────────────────────────────────────

/**
 * The edge draws one pixel but catches the pointer a hit pad to either side — and the drag starts
 * exactly where the cursor said it would: just inside the pad drags, just outside doesn't.
 */
async function playHit({ canvasElement }: { canvasElement: HTMLElement }) {
  const queue = panel(canvasElement, 'queue');
  await waitFor(() => expect(width(queue)).toBeCloseTo(280, 0));
  const [edge] = handles(canvasElement);
  const e = must(edge).getBoundingClientRect();
  const pad = resolvePx(must(edge), 'var(--gap-hit-x)');
  const y = e.top + e.height / 2;
  const at = (x: number) => document.elementFromPoint(x, y);
  // The drawn pointer area: the line plus the pad each side, no further.
  await expect(at(e.left - pad + 1)).toBe(edge);
  await expect(at(e.right + pad - 1)).toBe(edge);
  await expect(at(e.left - pad - 1)).not.toBe(edge);
  await expect(at(e.right + pad + 1)).not.toBe(edge);
  // A drag that starts inside the pad resizes by the distance moved…
  const start = e.left - pad + 2;
  const drag = async (from: number, by: number) => {
    const target = must(at(from));
    await userEvent.pointer([
      { keys: '[MouseLeft>]', target, coords: { clientX: from, clientY: y } },
      { target, coords: { clientX: from + by / 2, clientY: y } },
      { target, coords: { clientX: from + by, clientY: y } },
      { keys: '[/MouseLeft]', target, coords: { clientX: from + by, clientY: y } },
    ]);
  };
  const before = width(queue);
  await drag(start, 40);
  await waitFor(() => expect(width(queue)).toBeCloseTo(before + 40, 0));
  // …and one that starts just outside it does nothing.
  const e2 = must(edge).getBoundingClientRect();
  const after = width(queue);
  await drag(e2.left - pad - 2, 40);
  await expect(width(queue)).toBeCloseTo(after, 0);
}

export const HitAdmin: Story = {
  render: () => <Shell />,
  globals: { surface: 'admin' },
  play: playHit,
};

export const HitSkater: Story = {
  render: () => <Shell />,
  globals: { surface: 'skater' },
  play: playHit,
};
