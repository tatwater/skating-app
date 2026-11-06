import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCopy, faEllipsis, faTrash } from '@fortawesome/sharp-regular-svg-icons';
import { tokens } from '@skating/design';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { type ComponentProps, useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { Button } from './button';
import {
  contentRect,
  horizontalGaps,
  JUNCTION_TOLERANCE_PX,
  resolvePx,
  verticalGaps,
} from './measure';

const meta = {
  title: 'Kit/Button',
  component: Button,
  tags: ['autodocs'],
  args: { children: 'Promote', onClick: fn() },
  argTypes: {
    variant: { control: 'inline-radio', options: ['outline', 'primary', 'danger', 'link', 'bare'] },
    size: {
      control: 'inline-radio',
      options: ['default', 'sm', 'xs', 'icon', 'icon-sm', 'icon-xs'],
    },
    armed: { control: 'boolean', if: { arg: 'variant', eq: 'danger' } },
    external: { control: 'boolean', if: { arg: 'variant', eq: 'link' } },
  },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

const button = (canvasElement: HTMLElement, name?: string | RegExp) =>
  within(canvasElement).getByRole('button', name === undefined ? undefined : { name });

// ── One story per variant (the controls play with these) ─────────────────────────────────────

/** How every button in an action bar rests: outlined, kicker label. Lights on hover and focus. */
export const Outline: Story = {
  play: async ({ canvasElement, args, globals }) => {
    const el = button(canvasElement, 'Promote');
    await userEvent.click(el);
    await expect(args.onClick).toHaveBeenCalledOnce();
    // The surface's control radius (square on the console) and kicker type: the register's two
    // most visible breaks from shadcn.
    const surface = globals.surface as tokens.Surface;
    const style = getComputedStyle(el);
    await expect(style.borderRadius).toBe(`${tokens.controlRadius[surface].control.value}px`);
    await expect(style.textTransform).toBe('uppercase');
  },
};

/** The one default action of a view: the filled face with its corner dots, at rest. */
export const Primary: Story = { args: { variant: 'primary', children: 'Approve' } };

/** Destructive, at rest: outlined like any action — never red until armed. */
export const Danger: Story = {
  args: { variant: 'danger', children: 'Remove' },
  play: async ({ canvasElement }) => {
    const el = button(canvasElement, 'Remove');
    const bad = resolveColor(el, 'var(--bad)');
    await expect(getComputedStyle(el).color).not.toBe(bad);
  },
};

/** The confirm step: red label and red corner dots on the face. */
export const DangerArmed: Story = {
  args: { variant: 'danger', armed: true, children: 'Remove' },
  play: async ({ canvasElement }) => {
    const el = button(canvasElement, 'Remove');
    await expect(el).toHaveAttribute('data-armed');
    await expect(getComputedStyle(el).color).toBe(resolveColor(el, 'var(--bad)'));
  },
};

/** Armed but waiting for something (a reason): the label dims to `bad-dim`, and it can't fire. */
export const DangerWaiting: Story = {
  args: { variant: 'danger', armed: true, disabled: true, children: 'Remove' },
  play: async ({ canvasElement, args }) => {
    const el = button(canvasElement, 'Remove');
    await expect(getComputedStyle(el).color).toBe(resolveColor(el, 'var(--bad-dim)'));
    await userEvent.click(el, { pointerEventsCheck: 0 });
    await expect(args.onClick).not.toHaveBeenCalled();
  },
};

/** Navigation to another view: the outlined chip that ends in "→". Never underlined. */
export const Link: Story = {
  args: { variant: 'link', size: 'xs', children: 'History' },
  play: async ({ canvasElement }) => {
    const el = button(canvasElement, 'History');
    await expect(getComputedStyle(el).textDecorationLine).toBe('none');
    await expect(el).toHaveTextContent('History→');
  },
};

/** A link out of the console: the new-tab glyph replaces the arrow, and says so to a reader. */
export const LinkExternal: Story = {
  args: { variant: 'link', size: 'xs', external: true, children: 'Open in Gli' },
  play: async ({ canvasElement }) => {
    await expect(button(canvasElement, 'Open in Gli (opens in a new tab)')).toBeVisible();
  },
};

/** No face, no rule — a clickable row label. Row type; bleeds so it lines up with plain text. */
export const Bare: Story = { args: { variant: 'bare', children: 'Lake Mascoma' } };

/** A bare icon: the box is the glyph's square, and the pointer area grows past it. */
export const BareIcon: Story = {
  args: { variant: 'bare', size: 'icon', 'aria-label': 'More', children: <Icon of={faEllipsis} /> },
};

/** An icon leads the label; the gap is in `em`, so it tracks the label's size. */
export const WithIcon: Story = {
  args: {
    children: (
      <>
        <Icon of={faCopy} /> Copy log
      </>
    ),
  },
};

export const Disabled: Story = {
  args: { disabled: true },
  play: async ({ canvasElement, args }) => {
    const el = button(canvasElement, 'Promote');
    await expect(el).toBeDisabled();
    await userEvent.click(el, { pointerEventsCheck: 0 });
    await expect(args.onClick).not.toHaveBeenCalled();
  },
};

/** Busy: a spinner over the label. The label keeps its place, so the box doesn't move. */
export const Loading: Story = {
  args: { loading: true },
  play: async ({ canvasElement, args }) => {
    const el = button(canvasElement, 'Promote');
    await expect(el).toHaveAttribute('aria-busy', 'true');
    await userEvent.click(el, { pointerEventsCheck: 0 });
    await expect(args.onClick).not.toHaveBeenCalled();
  },
};

// ── Matrices ──────────────────────────────────────────────────────────────────────────────────

const ROWS: ReadonlyArray<{ label: string; props: ComponentProps<typeof Button> }> = [
  { label: 'Outline', props: { variant: 'outline', children: 'Promote' } },
  { label: 'Primary', props: { variant: 'primary', children: 'Approve' } },
  { label: 'Danger', props: { variant: 'danger', children: 'Remove' } },
  { label: 'Danger, armed', props: { variant: 'danger', armed: true, children: 'Remove' } },
  { label: 'Link', props: { variant: 'link', children: 'History' } },
  { label: 'Bare', props: { variant: 'bare', children: 'Lake Mascoma' } },
  {
    label: 'Bare icon',
    props: {
      variant: 'bare',
      size: 'icon',
      'aria-label': 'More',
      children: <Icon of={faEllipsis} />,
    },
  },
];

const STATES = ['rest', 'hover', 'focus', 'active', 'disabled', 'loading'] as const;
type State = (typeof STATES)[number];
const STATE_LABEL: Record<State, string> = {
  rest: 'Rest',
  hover: 'Hover',
  focus: 'Focus',
  active: 'Pressed',
  disabled: 'Disabled',
  loading: 'Loading',
};

function StateMatrix() {
  return (
    <table className="border-separate border-spacing-x-6 border-spacing-y-4 text-left">
      <thead>
        <tr>
          <th />
          {STATES.map((state) => (
            <th key={state} scope="col" className={KICKER}>
              {STATE_LABEL[state]}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {ROWS.map(({ label, props }) => (
          <tr key={label}>
            <th scope="row" className={KICKER}>
              {label}
            </th>
            {STATES.map((state) => (
              <td key={state}>
                <Button
                  {...props}
                  data-state={state}
                  disabled={state === 'disabled'}
                  loading={state === 'loading'}
                />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Every variant in every state. Hover, focus and pressed are forced with the pseudo-states addon,
 * so the matrix is a static board — the same states the Paper boards draw.
 */
export const States: Story = {
  render: () => <StateMatrix />,
  parameters: {
    pseudo: {
      hover: ['[data-state="hover"]'],
      focusVisible: ['[data-state="focus"]'],
      active: ['[data-state="active"]'],
    },
  },
  play: async ({ canvasElement }) => {
    // The forced states are for the eye (the pseudo-states addon runs in Storybook, not under
    // Vitest); the real hover/focus behavior is tested by `FocusLights`. Here: the cells that
    // don't depend on forcing.
    const cell = (row: number, state: State) =>
      must(canvasElement.querySelectorAll<HTMLElement>(`[data-state="${state}"]`)[row]);
    const dots = (el: HTMLElement) => getComputedStyle(el).getPropertyValue('--dot-opacity').trim();
    for (const row of [0, 2]) {
      await expect(dots(cell(row, 'rest'))).not.toBe('1');
      await expect(dots(cell(row, 'disabled'))).not.toBe('1');
    }
    await expect(dots(cell(1, 'rest'))).toBe('1'); // the primary wears its dots at rest
    await expect(dots(cell(1, 'disabled'))).toBe('0'); // …and drops them when disabled
    await expect(dots(cell(3, 'rest'))).toBe('1'); // an armed danger button too
    for (const el of canvasElement.querySelectorAll('[data-state="loading"]')) {
      await expect(el).toHaveAttribute('aria-busy', 'true');
    }
  },
};

/**
 * Keyboard focus lights an action exactly as hover does — one `lit:` look — and draws the focus
 * ring. Disabled controls never light.
 */
export const FocusLights: Story = {
  render: () => (
    <div className="flex items-center gap-(--space-2)">
      <Button>Promote</Button>
      <Button variant="danger">Remove</Button>
      <Button disabled>Demote</Button>
      <Button variant="bare">Lake Mascoma</Button>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const dots = (el: HTMLElement) => getComputedStyle(el).getPropertyValue('--dot-opacity').trim();
    const promote = canvas.getByRole('button', { name: 'Promote' });
    const remove = canvas.getByRole('button', { name: 'Remove' });
    const demote = canvas.getByRole('button', { name: 'Demote' });
    const bare = canvas.getByRole('button', { name: 'Lake Mascoma' });
    await expect(dots(promote)).not.toBe('1');

    // Script focus with no pointer history is keyboard-like focus (`:focus-visible`). (user-event's
    // `tab()` hangs under the Vitest browser runner, so focus is moved directly.)
    promote.focus();
    await expect(dots(promote)).toBe('1');
    await waitFor(() => expect(getComputedStyle(promote).boxShadow).toMatch(/3px/));

    remove.focus();
    await expect(dots(remove)).toBe('1');
    await expect(dots(promote)).not.toBe('1');

    // A disabled action can't take focus at all, so it never lights.
    await expect(demote).toBeDisabled();
    await expect(dots(demote)).not.toBe('1');

    // The bare row lights with a wash, not dots.
    // (Resolve the color outside `waitFor`: its probe mutates the DOM, which re-runs `waitFor`.)
    const wash = resolveColor(bare, 'var(--lift-08)');
    bare.focus();
    await waitFor(() => expect(getComputedStyle(bare).backgroundColor).toBe(wash));
  },
};

function Sizes() {
  return (
    <div className="flex flex-col gap-heading">
      {(
        [
          ['default', 'icon'],
          ['sm', 'icon-sm'],
          ['xs', 'icon-xs'],
        ] as const
      ).map(([size, iconSize]) => (
        <div key={size} className="flex items-center gap-(--space-2)">
          <Button size={size} variant="primary">
            Approve
          </Button>
          <Button size={size}>Promote</Button>
          <Button size={size} variant="danger">
            Remove
          </Button>
          <Button size={size} variant="link">
            Ledger
          </Button>
          <Button size={iconSize} aria-label="Delete">
            <Icon of={faTrash} />
          </Button>
        </div>
      ))}
    </div>
  );
}

/** The three heights. Each is a surface token: switch the toolbar to Skater and they all grow. */
export const SizeLadder: Story = {
  render: () => <Sizes />,
  play: async ({ canvasElement, globals }) => {
    const surface = globals.surface as tokens.Surface;
    const rows = canvasElement.querySelectorAll(':scope > div > div');
    const rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize);
    for (const [i, key] of (['btn', 'btn-sm', 'btn-xs'] as const).entries()) {
      const expected = tokens.size[surface][key].value * rootPx;
      for (const el of must(rows[i]).querySelectorAll('[data-slot="button"]')) {
        await expect(el.getBoundingClientRect().height).toBeCloseTo(expected, 1);
      }
    }
  },
};

/** The kit in all four maps at once. */
export const FourUp: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-(--space-2)">
      {ROWS.map(({ label, props }) => (
        <Button key={label} {...props} />
      ))}
    </div>
  ),
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    // Four themes, four copies — and each resolves its own map: admin buttons are shorter.
    const quads = canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]');
    await expect(quads).toHaveLength(4);
    const height = (q: HTMLElement) =>
      (q.querySelector('[data-variant="primary"]') as HTMLElement).getBoundingClientRect().height;
    const admin = [...quads].filter((q) => q.dataset.surface === 'admin').map(height);
    const skater = [...quads].filter((q) => q.dataset.surface === 'skater').map(height);
    await expect(Math.max(...admin)).toBeLessThan(Math.min(...skater));
    // …and takes its surface's control radius: rounded on skater, square on the console.
    for (const q of quads) {
      const primary = q.querySelector('[data-variant="primary"]') as HTMLElement;
      const surface = q.dataset.surface as tokens.Surface;
      await expect(getComputedStyle(primary).borderRadius).toBe(
        `${tokens.controlRadius[surface].control.value}px`,
      );
    }
    const field = (q: HTMLElement) => getComputedStyle(q).backgroundColor;
    await expect(new Set([...quads].map(field)).size).toBeGreaterThan(1);
  },
};

// ── Loading reserves its size ─────────────────────────────────────────────────────────────────

function LoadingToggle() {
  const [loading, setLoading] = useState(false);
  return (
    <Button variant="primary" loading={loading} onClick={() => setLoading(true)}>
      Run the import
    </Button>
  );
}

/** Pressing starts the work: the spinner appears, the box doesn't move, focus stays put. */
export const LoadingKeepsItsSize: Story = {
  render: () => <LoadingToggle />,
  play: async ({ canvasElement }) => {
    const el = button(canvasElement, 'Run the import');
    const before = el.getBoundingClientRect();
    await userEvent.click(el);
    await expect(el).toHaveAttribute('aria-busy', 'true');
    const after = el.getBoundingClientRect();
    await expect([after.width, after.height, after.left, after.top]).toEqual([
      before.width,
      before.height,
      before.left,
      before.top,
    ]);
    await expect(el).toHaveFocus();
  },
};

// ── Junctions: the optical-spacing instrument ─────────────────────────────────────────────────

/**
 * A heading-gap stack of plain text and bare buttons. The bleed gives each button's padding back,
 * so text-to-text distance equals the gap token everywhere; the right column drops the bleed to
 * show what it prevents (each bare row would add its hit pad above and below).
 */
function RowJunction() {
  return (
    <div className="grid grid-cols-2 gap-(--space-14)">
      <Column label="With the bleed" junction="bleed" />
      <Column label="Without (what the bleed prevents)" junction="naked" naked />
    </div>
  );
}

function Column({ label, junction, naked }: { label: string; junction: string; naked?: boolean }) {
  const strip = naked ? 'm-0!' : undefined;
  return (
    <div className="flex flex-col gap-heading">
      <p className={KICKER}>{label}</p>
      <div data-junction={junction} className="flex flex-col gap-heading">
        <p className="text-row leading-none text-fg2">Lake Sunapee</p>
        <Button variant="bare" className={strip}>
          Lake Mascoma
        </Button>
        <Button variant="bare" className={strip}>
          Post Pond
        </Button>
        <p className="text-row leading-none text-fg2">Crystal Lake</p>
      </div>
    </div>
  );
}

async function playRowJunction({
  canvasElement,
  globals,
}: {
  canvasElement: HTMLElement;
  globals: Record<string, unknown>;
}) {
  const surface = globals.surface as tokens.Surface;
  const rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize);
  const column = canvasElement.querySelector('[data-junction="bleed"]') as HTMLElement;
  const items = [...column.children];
  const gap = resolvePx(column, 'var(--gap-heading)');
  const hitY = resolvePx(column, 'var(--gap-hit-y)');
  const hitX = resolvePx(column, 'var(--gap-hit-x)');
  // The CSS tracks the token source.
  await expect(gap).toBeCloseTo(tokens.gap[surface].heading.value * rootPx, 2);
  await expect(hitY).toBeCloseTo(tokens.gap[surface]['hit-y'].value * rootPx, 2);
  await expect(hitX).toBeCloseTo(tokens.gap[surface]['hit-x'].value * rootPx, 2);

  // Content to content: every junction in the stack is exactly the gap token…
  for (const g of verticalGaps(items)) {
    await expect(Math.abs(g - gap)).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
  }
  // …and every label starts on the text's left edge.
  const left = contentRect(must(items[0])).left;
  for (const el of items) {
    await expect(Math.abs(contentRect(el).left - left)).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
  }
  // Not a cheat: the buttons really do carry the hit pad (their wash paints beyond the label).
  for (const el of items.slice(1, 3)) {
    const box = el.getBoundingClientRect();
    const label = contentRect(el);
    await expect(label.top - box.top).toBeCloseTo(hitY, 1);
    await expect(box.bottom - label.bottom).toBeCloseTo(hitY, 1);
    await expect(label.left - box.left).toBeCloseTo(hitX, 1);
  }
  // The control column: without the bleed, a text → bare-row junction grows by the hit pad.
  const naked = [
    ...(canvasElement.querySelector('[data-junction="naked"]') as HTMLElement).children,
  ];
  const [first] = verticalGaps(naked);
  await expect(first).toBeCloseTo(gap + hitY, 1);
}

/** Text → bare row → bare row → text, at the heading gap, on the admin surface. */
export const JunctionRowsAdmin: Story = {
  render: () => <RowJunction />,
  globals: { surface: 'admin' },
  play: playRowJunction,
};

/** The same junctions on the skater surface: a larger hit pad, the same visual gap. */
export const JunctionRowsSkater: Story = {
  render: () => <RowJunction />,
  globals: { surface: 'skater' },
  play: playRowJunction,
};

/**
 * Bare icons in a row of text at the `space-2` gap. The hit target doesn't touch layout: box to box
 * is the gap, the box is the icon's square — yet a pointer a hit pad outside the box still lands.
 */
function IconJunction() {
  return (
    // Room around the row, so the probes above and below land on the page.
    <div data-junction="icons" className="m-(--space-8) flex items-center gap-(--space-2)">
      <span className="text-row leading-none text-fg2">Lake Mascoma</span>
      <Button variant="bare" size="icon-sm" aria-label="Copy">
        <Icon of={faCopy} />
      </Button>
      <Button variant="bare" size="icon-sm" aria-label="More">
        <Icon of={faEllipsis} />
      </Button>
      <span className="text-row leading-none text-fg2">4 d</span>
    </div>
  );
}

async function playIconJunction({ canvasElement }: { canvasElement: HTMLElement }) {
  const row = canvasElement.querySelector('[data-junction="icons"]') as HTMLElement;
  const items = [...row.children];
  const gap = resolvePx(row, 'var(--space-2)');
  const hitX = resolvePx(row, 'var(--gap-hit-x)');
  const hitY = resolvePx(row, 'var(--gap-hit-y)');
  const square = resolvePx(row, 'var(--size-btn-sm)');
  for (const g of horizontalGaps(items)) {
    await expect(Math.abs(g - gap)).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
  }
  const copy = items[1] as HTMLElement;
  const box = copy.getBoundingClientRect();
  await expect(box.width).toBeCloseTo(square, 1);
  await expect(box.height).toBeCloseTo(square, 1);
  // Inside the grown area (just under a hit pad above the box), the pointer finds the button…
  const cx = box.left + box.width / 2;
  const hits = (x: number, y: number) =>
    document.elementFromPoint(x, y)?.closest('[data-slot="button"]') === copy;
  await expect(hits(cx, box.top - hitY + 1)).toBe(true);
  await expect(hits(cx, box.bottom + hitY - 1)).toBe(true);
  // …and just beyond it, it doesn't.
  await expect(hits(cx, box.top - hitY - 1)).toBe(false);
  await expect(hits(cx, box.bottom + hitY + 1)).toBe(false);
  // Sideways too — even where the grown area reaches over the neighboring text.
  const cy = box.top + box.height / 2;
  await expect(hits(box.left - hitX + 1, cy)).toBe(true);
  await expect(hits(box.left - hitX - 1, cy)).toBe(false);
}

export const JunctionIconsAdmin: Story = {
  render: () => <IconJunction />,
  globals: { surface: 'admin' },
  play: playIconJunction,
};

export const JunctionIconsSkater: Story = {
  render: () => <IconJunction />,
  globals: { surface: 'skater' },
  play: playIconJunction,
};

/** Buttons side by side are one height and sit at the gap — an icon never makes one taller. */
export const JunctionBar: Story = {
  render: () => (
    <div data-junction="bar" className="flex items-center gap-(--space-2)">
      <Button variant="primary">Approve</Button>
      <Button>
        <Icon of={faCopy} /> Copy log
      </Button>
      <Button variant="danger">Remove</Button>
      <Button variant="link">Ledger</Button>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const bar = canvasElement.querySelector('[data-junction="bar"]') as HTMLElement;
    const items = [...bar.children];
    const gap = resolvePx(bar, 'var(--space-2)');
    for (const g of horizontalGaps(items)) {
      await expect(Math.abs(g - gap)).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
    }
    const heights = new Set(items.map((el) => el.getBoundingClientRect().height));
    await expect(heights.size).toBe(1);
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────────────────────

const KICKER = 'text-kick leading-none font-semibold tracking-kick text-fg3 uppercase';

function Icon({ of }: { of: ComponentProps<typeof FontAwesomeIcon>['icon'] }) {
  return <FontAwesomeIcon icon={of} />;
}

/** The element a story rendered, or a failed test that says it's missing. */
function must<T>(el: T | null | undefined): T {
  if (el == null) throw new Error('The story did not render the element under test.');
  return el;
}

/** A token color as the browser computes it, in `el`'s theme. */
function resolveColor(el: Element, color: string): string {
  const probe = document.createElement('span');
  probe.style.color = color;
  el.parentElement?.append(probe);
  const value = getComputedStyle(probe).color;
  probe.remove();
  return value;
}
