import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import { ListEnd } from './list-end';
import { computedColor, JUNCTION_TOLERANCE_PX, resolvePx, sameColor } from './measure';
import { KICKER, must } from './storyKit';

const meta = {
  title: 'Kit/ListEnd',
  component: ListEnd,
  tags: ['autodocs'],
  args: { children: 'All 4' },
} satisfies Meta<typeof ListEnd>;

export default meta;
type Story = StoryObj<typeof meta>;

const REPORTS = [
  ['Mascoma Lake', 'Pressure ridge', '4 d'],
  ['Post Pond', 'Open water', '5 d'],
  ['Lake Morey', 'Thin ice', '6 d'],
  ['Goose Pond', 'Crack', '8 d'],
] as const;

/** A list's rows, each over a `line` rule — the rule the end tab continues. */
function Rows({ rows = REPORTS }: { rows?: ReadonlyArray<readonly [string, string, string]> }) {
  return (
    <ul className="m-0 flex list-none flex-col p-0">
      {rows.map(([place, what, age]) => (
        <li
          key={place}
          data-slot="row"
          className="flex items-baseline gap-(--space-2) border-0 border-b border-solid border-line py-(--space-2_5) text-row leading-none"
        >
          <span className="text-fg1">{place}</span>
          <span className="text-fg3">{what}</span>
          <span className="ml-auto font-(family-name:--family-mono) text-mono-sm text-fg3">
            {age}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The bar a list's filters sit in, ruled under. */
function Bar() {
  return (
    <div
      data-slot="bar"
      className="flex h-(--size-btn) items-center border-0 border-b border-solid border-line text-kick font-semibold tracking-head text-fg2 uppercase"
    >
      Open
    </div>
  );
}

/** The parts of a drawn tab, read back out of the page. */
async function readTab(root: HTMLElement) {
  const end = must(root.querySelector<HTMLElement>('[data-slot="list-end"]'));
  const path = await waitFor(() => must(end.querySelector<SVGPathElement>('path')));
  const d = must(path.getAttribute('d'));
  const [x0, rule, shoulderL, left, floor, right, shoulderR, rule2, width] = (
    d.match(/-?\d+(\.\d+)?/g) ?? []
  ).map(Number);
  const terminals = [...end.querySelectorAll<SVGRectElement>('[data-slot="list-end-terminal"]')];
  const label = must(end.querySelector<HTMLElement>('[data-slot="list-end-label"]'));
  return {
    end,
    path,
    terminals,
    label,
    x0: must(x0),
    rule: must(rule),
    rule2: must(rule2),
    shoulderL: must(shoulderL),
    left: must(left),
    floor: must(floor),
    right: must(right),
    shoulderR: must(shoulderR),
    width: must(width),
  };
}

const near = (a: number, b: number, tol = JUNCTION_TOLERANCE_PX) =>
  expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);

/**
 * The tab's own geometry: the rule runs edge to edge, drops a 45° shoulder each side of the label
 * to a floor under it, and the square terminals sit centered on the outer bends.
 */
async function expectTabGeometry(root: HTMLElement) {
  // The label re-lays out when the web font lands, and the refit follows a frame later: wait for
  // the drawing to have caught up (plain reads only — nothing here adds to the page).
  await document.fonts.ready;
  await waitFor(async () => {
    const now = await readTab(root);
    const b = now.end.getBoundingClientRect();
    const l = now.label.getBoundingClientRect();
    await near(b.left + now.left, l.left);
    await near(b.left + now.right, l.right);
    await near(now.width, b.width);
  });
  const t = await readTab(root);
  const box = t.end.getBoundingClientRect();
  await expect(t.x0).toBe(0);
  await near(t.width, box.width);
  await expect(t.rule2).toBe(t.rule);
  // 45°: each shoulder runs as far across as it drops.
  const depth = t.floor - t.rule;
  await near(t.left - t.shoulderL, depth);
  await near(t.shoulderR - t.right, depth);
  // The floor is the label's padded box: `space-3` clear of the text each side, `space-0_5` under.
  const lab = t.label.getBoundingClientRect();
  await near(box.left + t.left, lab.left);
  await near(box.left + t.right, lab.right);
  const hair = resolvePx(t.end, 'var(--stroke-hair)');
  await near(box.top + t.floor, lab.bottom + hair / 2, 0.75);
  await near(box.top + t.rule, lab.top + hair * 1.5, 0.75);
  // Centered: the label's middle is the tab's middle.
  await near((lab.left + lab.right) / 2, box.left + box.width / 2, 0.75);
  // Terminals: `stroke-run` squares on the outer bends, in `line2`; the rule in `line`.
  const run = resolvePx(t.end, 'var(--stroke-run)');
  await expect(t.terminals).toHaveLength(2);
  const centers = t.terminals.map((r) => {
    const x = Number(r.getAttribute('x'));
    const y = Number(r.getAttribute('y'));
    return [x + run / 2, y + run / 2];
  });
  await near(must(centers[0])[0] ?? NaN, t.shoulderL);
  await near(must(centers[1])[0] ?? NaN, t.shoulderR);
  for (const c of centers) await near(c[1] ?? NaN, t.rule);
  for (const r of t.terminals) {
    await expect(Number(r.getAttribute('width'))).toBe(run);
    await expect(getComputedStyle(r).fill).toEqual(sameColor(computedColor(t.end, 'var(--line2)')));
  }
  const stroke = getComputedStyle(t.path);
  await expect(stroke.stroke).toEqual(sameColor(computedColor(t.end, 'var(--line)')));
  await expect(parseFloat(stroke.strokeWidth)).toBe(hair);
  await expect(stroke.fill).toBe('none');
  return t;
}

/**
 * Under a list: the rule the rows sit on carries on into the end tab, `space-0_5` under the last
 * row, in the same gray, edge to edge.
 */
export const UnderAList: Story = {
  render: () => (
    <div className="w-[26rem]">
      <Rows />
      <ListEnd>All 4</ListEnd>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const t = await expectTabGeometry(canvasElement);
    await expect(t.label).toHaveTextContent('All 4');
    const rows = [...canvasElement.querySelectorAll<HTMLElement>('[data-slot="row"]')];
    const last = must(rows.at(-1));
    const lr = last.getBoundingClientRect();
    const box = t.end.getBoundingClientRect();
    await near(box.top - lr.bottom, resolvePx(t.end, 'var(--space-0_5)'));
    // The same rule: the rows' gray, the rows' span.
    await expect(getComputedStyle(last).borderBottomColor).toEqual(
      sameColor(getComputedStyle(t.path).stroke),
    );
    await near(box.left, lr.left);
    await near(box.right, lr.right);
    // The drawing is hidden from readers; the label is the text.
    await expect(must(t.end.querySelector('svg'))).toHaveAttribute('aria-hidden', 'true');
  },
};

/**
 * An empty list still says what it is: the same tab, `space-0_5` under the bar above it, saying
 * "Nothing open" — never a blank pane or an illustration.
 */
export const Empty: Story = {
  render: () => (
    <div className="w-[26rem]">
      <Bar />
      <ListEnd>Nothing open</ListEnd>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const t = await expectTabGeometry(canvasElement);
    await expect(within(canvasElement).getByText('Nothing open')).toBeVisible();
    const bar = must(canvasElement.querySelector('[data-slot="bar"]')).getBoundingClientRect();
    await near(
      t.end.getBoundingClientRect().top - bar.bottom,
      resolvePx(t.end, 'var(--space-0_5)'),
    );
  },
};

/** The label is a kicker in the quiet ink, its trailing tracking added back on the left. */
export const Label: Story = {
  render: () => (
    <div className="w-[20rem]">
      <ListEnd>All 4</ListEnd>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const { label } = await readTab(canvasElement);
    const style = getComputedStyle(label);
    await expect(style.textTransform).toBe('uppercase');
    await expect(style.color).toEqual(sameColor(computedColor(label, 'var(--fg3)')));
    await expect(parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)).toBeCloseTo(
      parseFloat(style.letterSpacing),
      1,
    );
  },
};

function Refit() {
  const [wide, setWide] = useState(false);
  const [count, setCount] = useState(4);
  return (
    <div className="flex flex-col gap-heading">
      <div data-junction="frame" style={{ width: wide ? '30rem' : '18rem' }}>
        <ListEnd>{count === 0 ? 'Nothing open' : `All ${count}`}</ListEnd>
      </div>
      <div className="flex gap-(--space-2)">
        <button type="button" className="text-row text-fg2" onClick={() => setWide(!wide)}>
          Widen
        </button>
        <button type="button" className="text-row text-fg2" onClick={() => setCount(0)}>
          Empty it
        </button>
      </div>
    </div>
  );
}

/** The tab re-fits when its list changes width or its label changes: it is measured, not fixed. */
export const Refits: Story = {
  render: () => <Refit />,
  play: async ({ canvasElement }) => {
    const before = await readTab(canvasElement);
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Widen' }));
    await waitFor(() =>
      expect(
        Number(must(before.path.getAttribute('d')).match(/H(\d+(\.\d+)?)$/)?.[1]),
      ).toBeGreaterThan(before.width),
    );
    await expectTabGeometry(canvasElement);
    const wide = await readTab(canvasElement);
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Empty it' }));
    await waitFor(async () => {
      const now = await readTab(canvasElement);
      await expect(now.right - now.left).toBeGreaterThan(wide.right - wide.left);
    });
    await expectTabGeometry(canvasElement);
  },
};

export const FourUp: Story = {
  render: () => (
    <div className="flex w-[18rem] flex-col gap-gutter">
      <div>
        <Rows rows={REPORTS.slice(0, 2)} />
        <ListEnd>All 2</ListEnd>
      </div>
      <div>
        <Bar />
        <ListEnd>Nothing open</ListEnd>
      </div>
    </div>
  ),
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      for (const end of q.querySelectorAll<HTMLElement>('[data-slot="list-end"]')) {
        const wrap = must(end.parentElement);
        await expectTabGeometry(wrap);
      }
    }
  },
};

// ── Junctions ─────────────────────────────────────────────────────────────────────────────────

/**
 * Last row → tab: `space-0_5`, and the tab's rule is the rows' rule carried on. Bar → empty tab:
 * the same `space-0_5`. In rem, so the whole mark grows with the user's font size.
 */
function EndJunction() {
  return (
    <div className="flex w-[24rem] flex-col gap-(--space-8)">
      <div data-junction="list">
        <Rows />
        <ListEnd>All 4</ListEnd>
      </div>
      <div data-junction="empty">
        <Bar />
        <ListEnd>Nothing open</ListEnd>
      </div>
      <p className={KICKER}>The rows' rule runs on into the tab</p>
    </div>
  );
}

async function playEndJunction({ canvasElement }: { canvasElement: HTMLElement }) {
  const list = must(canvasElement.querySelector<HTMLElement>('[data-junction="list"]'));
  const t = await expectTabGeometry(list);
  const gap = resolvePx(list, 'var(--space-0_5)');
  const last = must([...list.querySelectorAll('[data-slot="row"]')].at(-1)).getBoundingClientRect();
  await near(t.end.getBoundingClientRect().top - last.bottom, gap);
  // The label box: `space-3` tall plus its `space-0_5` floor, `space-2` down from the tab's top.
  const box = t.end.getBoundingClientRect();
  const lab = t.label.getBoundingClientRect();
  await near(lab.top - box.top, resolvePx(list, 'var(--space-2)'));
  await near(lab.height, resolvePx(list, 'calc(var(--space-3) + var(--space-0_5))'));
  // The tab's own box: label room plus `space-1` under the floor.
  await near(box.height, lab.bottom - box.top + resolvePx(list, 'var(--space-1)'));
  const empty = must(canvasElement.querySelector<HTMLElement>('[data-junction="empty"]'));
  const e = await expectTabGeometry(empty);
  const bar = must(empty.querySelector('[data-slot="bar"]')).getBoundingClientRect();
  await near(e.end.getBoundingClientRect().top - bar.bottom, gap);
}

export const JunctionEndAdmin: Story = {
  render: () => <EndJunction />,
  globals: { surface: 'admin' },
  play: playEndJunction,
};

export const JunctionEndSkater: Story = {
  render: () => <EndJunction />,
  globals: { surface: 'skater' },
  play: playEndJunction,
};
