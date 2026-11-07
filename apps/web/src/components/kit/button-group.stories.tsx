import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCopy, faMinus, faPlus } from '@fortawesome/sharp-regular-svg-icons';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { Button } from './button';
import { ButtonGroup } from './button-group';
import {
  DropdownMenu,
  DropdownMenuCaret,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './dropdown-menu';
import { JUNCTION_TOLERANCE_PX, resolvePx } from './measure';
import { closeWithEscape, KICKER, must, openWith, PSEUDO_STATES, StateMatrix } from './storyKit';
import { Toolbar, ToolbarButton } from './toolbar';

const meta = {
  title: 'Kit/ButtonGroup',
  component: ButtonGroup,
  tags: ['autodocs'],
} satisfies Meta<typeof ButtonGroup>;

export default meta;
type Story = StoryObj<typeof meta>;

const button = (canvasElement: HTMLElement, name: string | RegExp) =>
  within(canvasElement).getByRole('button', { name });

const membersOf = (group: Element) => [...group.children] as HTMLElement[];

/** Each member after the first starts a hair before the last one ends (horizontal or stacked). */
async function expectSharedEdges(group: HTMLElement, orientation: 'horizontal' | 'vertical') {
  const hair = resolvePx(group, 'var(--stroke-hair)');
  const rects = membersOf(group).map((el) => el.getBoundingClientRect());
  for (let i = 1; i < rects.length; i++) {
    const prev = must(rects[i - 1]);
    const next = must(rects[i]);
    const overlap = orientation === 'horizontal' ? prev.right - next.left : prev.bottom - next.top;
    await expect(Math.abs(overlap - hair)).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
    // One line: the same height side by side, the same width stacked.
    const cross =
      orientation === 'horizontal' ? [prev.height, next.height] : [prev.width, next.width];
    await expect(Math.abs(must(cross[0]) - must(cross[1]))).toBeLessThanOrEqual(
      JUNCTION_TOLERANCE_PX,
    );
  }
  // The group is the members less one hair per shared edge.
  const g = group.getBoundingClientRect();
  const sum = rects.reduce((n, r) => n + (orientation === 'horizontal' ? r.width : r.height), 0);
  const along = orientation === 'horizontal' ? g.width : g.height;
  await expect(Math.abs(along - (sum - hair * (rects.length - 1)))).toBeLessThanOrEqual(
    JUNCTION_TOLERANCE_PX * rects.length,
  );
}

function SplitButton({ onCopy }: { onCopy?: (how: string) => void }) {
  return (
    <ButtonGroup aria-label="Copy the log">
      <Button variant="outline" size="sm" onClick={() => onCopy?.('text')}>
        <FontAwesomeIcon icon={faCopy} />
        Copy log
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="outline" size="sm" className="px-[0.6em]" />}
          aria-label="More ways to copy"
        >
          <DropdownMenuCaret />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => onCopy?.('json')}>Copy as JSON</DropdownMenuItem>
          <DropdownMenuItem onClick={() => onCopy?.('last')}>Copy the last run</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </ButtonGroup>
  );
}

/**
 * A split button: the action and its caret, one shared edge. The caret opens the menu (on a press,
 * never on its own); Esc closes it and gives focus back. While the menu is up its trigger stays
 * risen over the action's edge.
 */
const copied = fn();

export const Split: Story = {
  render: () => <SplitButton onCopy={copied} />,
  play: async ({ canvasElement }) => {
    copied.mockClear();
    const group = within(canvasElement).getByRole('group', { name: 'Copy the log' });
    await expectSharedEdges(group, 'horizontal');
    await userEvent.click(button(canvasElement, 'Copy log'));
    await expect(copied).toHaveBeenCalledWith('text');
    const caret = await openWith(canvasElement, 'More ways to copy');
    const menu = await within(document.body).findByRole('menu');
    await waitFor(() => expect(menu).toBeVisible());
    await waitFor(() => expect(getComputedStyle(caret).zIndex).toBe('1'));
    await closeWithEscape(() => document.querySelector('[role="menu"]'));
    await waitFor(() => expect(caret).toHaveFocus());
    // Focus came back to the caret, so it is now the group's tab stop.
    await expect(caret).toHaveAttribute('tabindex', '0');
    await expect(button(canvasElement, 'Copy log')).toHaveAttribute('tabindex', '-1');
  },
};

function CronRow() {
  return (
    <div className="flex items-center gap-(--space-3)">
      <button type="button" className="text-row text-fg2">
        Before
      </button>
      <ButtonGroup aria-label="Weather refresh">
        <Button size="xs">Run now</Button>
        <Button size="xs">Pause</Button>
        <Button size="xs">Logs</Button>
      </ButtonGroup>
      <button type="button" className="text-row text-fg2">
        After
      </button>
    </div>
  );
}

/**
 * A cron's buttons: one joined group. One tab stop — Tab lands on the first, the arrows move along
 * and wrap, Home and End go to the ends, and Tab leaves the group.
 */
export const Cron: Story = {
  render: () => <CronRow />,
  play: async ({ canvasElement }) => {
    const group = within(canvasElement).getByRole('group', { name: 'Weather refresh' });
    await expectSharedEdges(group, 'horizontal');
    const [run, pause, logs] = ['Run now', 'Pause', 'Logs'].map((n) => button(canvasElement, n));
    button(canvasElement, 'Before').focus();
    await userEvent.tab();
    await expect(run).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}');
    await expect(pause).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}{ArrowRight}');
    await expect(run).toHaveFocus(); // wrapped
    await userEvent.keyboard('{ArrowLeft}');
    await expect(logs).toHaveFocus(); // wrapped back
    await userEvent.keyboard('{Home}');
    await expect(run).toHaveFocus();
    await userEvent.keyboard('{End}');
    await expect(logs).toHaveFocus();
    // Keys that aren't the group's do nothing to focus.
    await userEvent.keyboard('{ArrowDown}');
    await expect(logs).toHaveFocus();
    await userEvent.tab();
    await expect(button(canvasElement, 'After')).toHaveFocus();
    // Coming back lands on the member focused last.
    await userEvent.tab({ shift: true });
    await expect(logs).toHaveFocus();
    // A focused member rises over its neighbors' edges.
    await expect(getComputedStyle(must(logs)).zIndex).toBe('1');
  },
};

/** The map's zoom pair: stacked icon buttons on the map plate, one shared edge. ↑↓ move. */
export const ZoomPair: Story = {
  render: () => (
    <ButtonGroup orientation="vertical" aria-label="Zoom">
      <Button size="icon-sm" aria-label="Zoom in" className="bg-map-plate">
        <FontAwesomeIcon icon={faPlus} />
      </Button>
      <Button size="icon-sm" aria-label="Zoom out" className="bg-map-plate">
        <FontAwesomeIcon icon={faMinus} />
      </Button>
    </ButtonGroup>
  ),
  play: async ({ canvasElement }) => {
    const group = within(canvasElement).getByRole('group', { name: 'Zoom' });
    await expect(group).toHaveAttribute('data-orientation', 'vertical');
    await expectSharedEdges(group, 'vertical');
    const zoomIn = button(canvasElement, 'Zoom in');
    zoomIn.focus();
    await userEvent.keyboard('{ArrowDown}');
    await expect(button(canvasElement, 'Zoom out')).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}'); // not this orientation's key
    await expect(button(canvasElement, 'Zoom out')).toHaveFocus();
    await userEvent.keyboard('{ArrowUp}');
    await expect(zoomIn).toHaveFocus();
  },
};

/** A disabled member is skipped by the arrows; one that stays focusable is not. */
export const DisabledMember: Story = {
  render: () => (
    <ButtonGroup aria-label="Imagery pager">
      <Button size="sm">Older</Button>
      <Button size="sm" disabled>
        Newer
      </Button>
      <Button size="sm" disabled focusableWhenDisabled>
        Latest
      </Button>
    </ButtonGroup>
  ),
  play: async ({ canvasElement }) => {
    const older = button(canvasElement, 'Older');
    older.focus();
    await userEvent.keyboard('{ArrowRight}');
    await expect(button(canvasElement, 'Latest')).toHaveFocus();
    await expect(button(canvasElement, 'Newer')).toHaveAttribute('tabindex', '-1');
  },
};

/** The first member is the tab stop until another is focused; then that one is. */
function Runs() {
  return (
    <ButtonGroup aria-label="Runs">
      <Button size="sm">Run now</Button>
      <Button size="sm">Pause</Button>
    </ButtonGroup>
  );
}

export const TabStop: Story = {
  render: () => <Runs />,
  play: async ({ canvasElement }) => {
    const [run, pause] = ['Run now', 'Pause'].map((n) => button(canvasElement, n));
    await expect(run).toHaveAttribute('tabindex', '0');
    await expect(pause).toHaveAttribute('tabindex', '-1');
    await userEvent.click(must(pause));
    await expect(pause).toHaveAttribute('tabindex', '0');
    await expect(run).toHaveAttribute('tabindex', '-1');
    // A press on the group itself (not a member) changes nothing.
    const group = within(canvasElement).getByRole('group');
    group.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    await expect(pause).toHaveAttribute('tabindex', '0');
    // Nor does an arrow from the group itself rather than a member.
    pause?.focus();
    group.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await expect(pause).toHaveFocus();
  },
};

/**
 * Inside a kit Toolbar the bar roves, not the group: members are `ToolbarButton`s, and the group
 * only joins them (it leaves their tab stops and the arrows to the bar).
 */
export const InToolbar: Story = {
  render: () => (
    <Toolbar aria-label="Log">
      <ToolbarButton>Refresh</ToolbarButton>
      <ButtonGroup aria-label="Copy">
        <ToolbarButton>Copy log</ToolbarButton>
        <ToolbarButton>Copy run</ToolbarButton>
      </ButtonGroup>
    </Toolbar>
  ),
  play: async ({ canvasElement }) => {
    const group = within(canvasElement).getByRole('group', { name: 'Copy' });
    await expectSharedEdges(group, 'horizontal');
    button(canvasElement, 'Refresh').focus();
    await userEvent.keyboard('{ArrowRight}');
    await expect(button(canvasElement, 'Copy log')).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}');
    await expect(button(canvasElement, 'Copy run')).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}');
    // The bar's own roving wraps to the bar's start, not the group's.
    await expect(button(canvasElement, 'Refresh')).toHaveFocus();
  },
};

/** A forwarded ref reaches the group's element, whether an object or a callback. */
export const Ref: Story = {
  render: () => {
    const seen = { el: null as HTMLDivElement | null };
    return (
      <div className="flex flex-col gap-heading">
        <ButtonGroup aria-label="Object ref" ref={{ current: null }}>
          <Button size="sm">One</Button>
        </ButtonGroup>
        <ButtonGroup
          aria-label="Callback ref"
          ref={(el) => {
            seen.el = el;
            el?.setAttribute('data-seen', '');
          }}
        >
          <Button size="sm">Two</Button>
        </ButtonGroup>
      </div>
    );
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole('group', { name: 'Callback ref' }),
    ).toHaveAttribute('data-seen');
  },
};

// ── Corners, states and four-up ───────────────────────────────────────────────────────────────

function Corners() {
  return (
    <div className="flex flex-col gap-heading">
      <ButtonGroup aria-label="Row" data-junction="row">
        <Button size="sm">Run now</Button>
        <Button size="sm">Pause</Button>
        <Button size="sm">Logs</Button>
      </ButtonGroup>
      <ButtonGroup aria-label="Stack" orientation="vertical" data-junction="stack">
        <Button size="icon-sm" aria-label="Zoom in">
          <FontAwesomeIcon icon={faPlus} />
        </Button>
        <Button size="icon-sm" aria-label="Zoom out">
          <FontAwesomeIcon icon={faMinus} />
        </Button>
      </ButtonGroup>
    </div>
  );
}

async function playCorners({ canvasElement }: { canvasElement: HTMLElement }) {
  const radius = `${resolvePx(canvasElement, 'var(--corner-control)')}px`;
  const r = (el: Element) => {
    const s = getComputedStyle(el);
    return [
      s.borderTopLeftRadius,
      s.borderTopRightRadius,
      s.borderBottomRightRadius,
      s.borderBottomLeftRadius,
    ];
  };
  const [first, middle, last] = membersOf(
    must(canvasElement.querySelector('[data-junction="row"]')),
  );
  await expect(r(must(first))).toEqual([radius, '0px', '0px', radius]);
  await expect(r(must(middle))).toEqual(['0px', '0px', '0px', '0px']);
  await expect(r(must(last))).toEqual(['0px', radius, radius, '0px']);
  const [top, bottom] = membersOf(must(canvasElement.querySelector('[data-junction="stack"]')));
  await expect(r(must(top))).toEqual([radius, radius, '0px', '0px']);
  await expect(r(must(bottom))).toEqual(['0px', '0px', radius, radius]);
}

/** Square where they meet; the outer corners take the surface's control radius (0 on admin). */
export const CornersAdmin: Story = {
  render: () => <Corners />,
  globals: { surface: 'admin' },
  play: playCorners,
};

export const CornersSkater: Story = {
  render: () => <Corners />,
  globals: { surface: 'skater' },
  play: async (ctx) => {
    await expect(resolvePx(ctx.canvasElement, 'var(--corner-control)')).toBeGreaterThan(0);
    await playCorners(ctx);
  },
};

const ROWS = [
  { key: 'outline', label: 'Outline' },
  { key: 'primary', label: 'Primary first' },
] as const;
const STATES = [
  { key: 'rest', label: 'Rest' },
  { key: 'hover', label: 'Hover' },
  { key: 'focus', label: 'Focus' },
  { key: 'active', label: 'Pressed' },
  { key: 'disabled', label: 'Disabled' },
] as const;

/** The middle member in each state, between two resting neighbors. */
export const States: Story = {
  render: () => (
    <StateMatrix
      rows={ROWS}
      states={STATES}
      cell={(row, state) => (
        <ButtonGroup aria-label={`${row} ${state}`}>
          <Button size="sm" variant={row === 'primary' ? 'primary' : 'outline'}>
            Run now
          </Button>
          <Button size="sm" data-state={state} disabled={state === 'disabled'}>
            Pause
          </Button>
          <Button size="sm">Logs</Button>
        </ButtonGroup>
      )}
    />
  ),
  parameters: PSEUDO_STATES,
  play: async ({ canvasElement }) => {
    for (const group of within(canvasElement).getAllByRole('group')) {
      await expectSharedEdges(group, 'horizontal');
    }
  },
};

export const FourUp: Story = {
  render: () => (
    <div className="flex items-start gap-gutter">
      <div className="flex flex-col gap-heading">
        <SplitButton />
        <ButtonGroup aria-label="Weather refresh">
          <Button size="xs">Run now</Button>
          <Button size="xs">Pause</Button>
          <Button size="xs">Logs</Button>
        </ButtonGroup>
      </div>
      <ButtonGroup orientation="vertical" aria-label="Zoom">
        <Button size="icon-sm" aria-label="Zoom in" className="bg-map-plate">
          <FontAwesomeIcon icon={faPlus} />
        </Button>
        <Button size="icon-sm" aria-label="Zoom out" className="bg-map-plate">
          <FontAwesomeIcon icon={faMinus} />
        </Button>
      </ButtonGroup>
    </div>
  ),
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      const groups = [...q.querySelectorAll<HTMLElement>('[data-slot="button-group"]')];
      await expect(groups).toHaveLength(3);
      for (const g of groups) {
        await expectSharedEdges(
          g,
          g.dataset.orientation === 'vertical' ? 'vertical' : 'horizontal',
        );
      }
    }
  },
};

// ── Junctions ─────────────────────────────────────────────────────────────────────────────────

/**
 * Every shared edge is one hair: each member starts `stroke-hair` before the last one ends, all
 * stand one height (one width stacked), and the group is the members less a hair per edge.
 */
function EdgeJunction() {
  return (
    <div className="flex items-start gap-gutter">
      <div className="flex flex-col gap-heading">
        <SplitButton />
        <ButtonGroup aria-label="Weather refresh" data-junction="cron">
          <Button size="xs">Run now</Button>
          <Button size="xs">Pause</Button>
          <Button size="xs">Logs</Button>
        </ButtonGroup>
        <p className={KICKER}>One hair between members</p>
      </div>
      <ButtonGroup orientation="vertical" aria-label="Zoom" data-junction="zoom">
        <Button size="icon-sm" aria-label="Zoom in">
          <FontAwesomeIcon icon={faPlus} />
        </Button>
        <Button size="icon-sm" aria-label="Zoom out">
          <FontAwesomeIcon icon={faMinus} />
        </Button>
      </ButtonGroup>
    </div>
  );
}

async function playEdgeJunction({ canvasElement }: { canvasElement: HTMLElement }) {
  await expectSharedEdges(
    within(canvasElement).getByRole('group', { name: 'Copy the log' }),
    'horizontal',
  );
  const cron = must(canvasElement.querySelector<HTMLElement>('[data-junction="cron"]'));
  await expectSharedEdges(cron, 'horizontal');
  // A cron's buttons stand the surface's extra-small height.
  await expect(cron.getBoundingClientRect().height).toBeCloseTo(
    resolvePx(cron, 'var(--size-btn-xs)'),
    1,
  );
  const zoom = must(canvasElement.querySelector<HTMLElement>('[data-junction="zoom"]'));
  await expectSharedEdges(zoom, 'vertical');
  const sq = resolvePx(zoom, 'var(--size-btn-sm)');
  const hair = resolvePx(zoom, 'var(--stroke-hair)');
  await expect(zoom.getBoundingClientRect().height).toBeCloseTo(2 * sq - hair, 1);
}

export const JunctionEdgesAdmin: Story = {
  render: () => <EdgeJunction />,
  globals: { surface: 'admin' },
  play: playEdgeJunction,
};

export const JunctionEdgesSkater: Story = {
  render: () => <EdgeJunction />,
  globals: { surface: 'skater' },
  play: playEdgeJunction,
};
