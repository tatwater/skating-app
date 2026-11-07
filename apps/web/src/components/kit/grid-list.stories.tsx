import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import { Button } from './button';
import {
  GridList,
  GridListRow,
  HistoryList,
  HistoryRow,
  InvoiceList,
  InvoiceRow,
  KeyValueList,
  KeyValueRow,
} from './grid-list';
import { computedColor, JUNCTION_TOLERANCE_PX, resolvePx, sameColor } from './measure';
import { Section } from './section-slug';
import { must } from './storyKit';

const meta = {
  title: 'Kit/Grid list',
  component: GridList,
  tags: ['autodocs'],
  args: { columns: '5.25rem minmax(0, 1fr)' },
  decorators: [(Story) => <div className="w-full max-w-[26rem]">{Story()}</div>],
  parameters: {
    docs: {
      description: {
        component:
          'Small tables drawn as CSS grids: a key/value block, history with Undo, invoice rows. Every row is a subgrid, so its rule is the row’s own edge and runs **unbroken across the column gaps**; rows are divided by their padding, never margin, and the last row has no rule.',
      },
    },
  },
} satisfies Meta<typeof GridList>;

export default meta;
type Story = StoryObj<typeof meta>;

const rowsIn = (root: ParentNode) => [
  ...root.querySelectorAll<HTMLElement>('[data-slot="grid-list-row"], [data-slot$="-row"]'),
];

/**
 * The y of an element's first baseline: a zero-size inline-block appended to it sits on the
 * baseline of the line it lands in (for a one-line cell, its only line).
 */
function baselineOf(el: HTMLElement): number {
  const probe = document.createElement('span');
  probe.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
  const host = el.querySelector<HTMLElement>(':scope > span:not([data-slot])') ?? el;
  host.prepend(probe);
  const y = probe.getBoundingClientRect().bottom;
  probe.remove();
  return y;
}

/**
 * Every ruled row's rule runs the list's full width — across the column gaps — and rows meet edge
 * to edge, divided by padding, never margin. The last row has no rule.
 */
async function expectUnbrokenRules(list: HTMLElement) {
  const box = list.getBoundingClientRect();
  const rows = [...list.querySelectorAll<HTMLElement>(':scope > li')];
  await expect(rows.length).toBeGreaterThan(1);
  const columnGap = parseFloat(getComputedStyle(list).columnGap);
  await expect(columnGap).toBeGreaterThan(0);
  for (const [i, row] of rows.entries()) {
    const rect = row.getBoundingClientRect();
    const style = getComputedStyle(row);
    // The rule is the row's edge, and the row spans the list…
    await expect(Math.abs(rect.left - box.left)).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
    await expect(Math.abs(rect.right - box.right)).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
    // …so it crosses every gap between the row's cells: the cells stand apart, the rule doesn't.
    const cells = [...row.children].filter((c) => c.getBoundingClientRect().width > 0);
    for (let c = 1; c < cells.length; c++) {
      const prev = must(cells[c - 1]).getBoundingClientRect();
      const next = must(cells[c]).getBoundingClientRect();
      if (Math.abs(next.top - prev.top) > 1) continue; // a cell on its own line (a note)
      const gap = next.left - prev.right;
      if (gap <= 0) continue;
      await expect(rect.left).toBeLessThanOrEqual(prev.right);
      await expect(rect.right).toBeGreaterThanOrEqual(next.left);
    }
    await expect(style.marginTop).toBe('0px');
    await expect(style.marginBottom).toBe('0px');
    const next = rows[i + 1];
    if (next !== undefined) {
      // Rows meet edge to edge: the spacing between rules is the rows' own padding.
      await expect(Math.abs(next.getBoundingClientRect().top - rect.bottom)).toBeLessThanOrEqual(
        JUNCTION_TOLERANCE_PX,
      );
      await expect(style.borderBottomWidth).toBe('1px');
      await expect(style.borderBottomStyle).toBe('dotted');
      await expect(style.borderBottomColor).toEqual(sameColor(computedColor(row, 'var(--line)')));
      await expect(parseFloat(style.paddingBottom)).toBeGreaterThan(0);
    } else {
      // A list ends on its spacing, never a rule.
      await expect(style.borderBottomWidth).toBe('0px');
    }
    await expect(style.borderTopWidth).toBe('0px');
  }
}

// ── Key / value ──────────────────────────────────────────────────────────────────────────────

function Facts({ ruled = false }: { ruled?: boolean }) {
  return (
    <KeyValueList ruled={ruled}>
      <KeyValueRow label="Source">National Hydrography Dataset</KeyValueRow>
      <KeyValueRow label="Area">1,120 acres</KeyValueRow>
      <KeyValueRow label="Id" mono>
        nhd:01780386
      </KeyValueRow>
      <KeyValueRow label="Since">17 Sep 2026</KeyValueRow>
    </KeyValueList>
  );
}

/**
 * The key/value block: kicker keys in an 84 px column, values beside them on one baseline, rows on
 * the row gap (no rules).
 */
export const KeyValue: Story = {
  render: () => <Facts />,
  play: async ({ canvasElement }) => {
    const list = must(canvasElement.querySelector<HTMLElement>('[data-slot="grid-list"]'));
    await expect(within(canvasElement).getAllByRole('listitem')).toHaveLength(4);
    // Unruled: rows on the row gap, no rules.
    await expect(getComputedStyle(list).rowGap).toBe(`${resolvePx(list, 'var(--space-1_5)')}px`);
    const rows = [...list.querySelectorAll<HTMLElement>('[data-slot="key-value-row"]')];
    for (const row of rows) {
      await expect(getComputedStyle(row).borderBottomWidth).toBe('0px');
      const key = must(row.querySelector<HTMLElement>('[data-slot="key"]'));
      const value = must(row.querySelector<HTMLElement>('[data-slot="value"]'));
      // One baseline per row, whatever the two type steps.
      await expect(Math.abs(baselineOf(key) - baselineOf(value))).toBeLessThanOrEqual(0.5);
      // The key column is 84 px at the 16 px base, in rem.
      await expect(
        value.getBoundingClientRect().left - key.getBoundingClientRect().left,
      ).toBeCloseTo(resolvePx(list, '5.25rem') + parseFloat(getComputedStyle(list).columnGap), 1);
    }
    const mono = must(rows[2]?.querySelector<HTMLElement>('[data-slot="value"]'));
    await expect(getComputedStyle(mono).fontFamily).toMatch(/Martian Mono/);
    const key = must(rows[0]?.querySelector<HTMLElement>('[data-slot="key"]'));
    await expect(getComputedStyle(key).textTransform).toBe('uppercase');
    await expect(getComputedStyle(key).color).toEqual(sameColor(computedColor(key, 'var(--fg3)')));
  },
};

/** The same block ruled: every rule unbroken across the key–value gap. */
export const KeyValueRuled: Story = {
  render: () => <Facts ruled />,
  play: async ({ canvasElement }) => {
    const list = must(canvasElement.querySelector<HTMLElement>('[data-slot="grid-list"]'));
    await expect(getComputedStyle(list).rowGap).toBe('0px');
    await expectUnbrokenRules(list);
    // Rule → content is the row's padding.
    const rows = rowsIn(list);
    const second = must(rows[1]);
    await expect(parseFloat(getComputedStyle(second).paddingTop)).toBeCloseTo(
      resolvePx(list, 'var(--space-2)'),
      2,
    );
  },
};

// ── History with Undo ────────────────────────────────────────────────────────────────────────

const onUndo = fn();

function History() {
  const undo = (label = 'Undo') => (
    <Button size="xs" onClick={onUndo}>
      {label}
    </Button>
  );
  return (
    <Section title="History" count={6}>
      <HistoryList>
        <HistoryRow when="14:41" who="Teagan" action={undo()}>
          Hidden · reason kept
        </HistoryRow>
        <HistoryRow when="13:02" who="Teagan" action={undo()}>
          Rate updated · $25.00 → $30.00
        </HistoryRow>
        <HistoryRow when="Sat" who="Matt" action={undo()}>
          Moved Black Point · 140 m
        </HistoryRow>
        <HistoryRow when="Sat" who="Matt" action={undo('Unmerge')}>
          Merged a hazard into the ridge
        </HistoryRow>
        <HistoryRow when="3 Oct" who="Teagan" action={undo('Restore')}>
          Rejected the OSM depth · max 22 m
        </HistoryRow>
        <HistoryRow when="2 Sep" who="System">
          Seeded Mascoma North and South
        </HistoryRow>
      </HistoryList>
    </Section>
  );
}

/**
 * History: when, what (who on its own line under it), and the row's way back. Time and what share
 * a baseline; the button centers on the row; a row with no way back keeps the column.
 */
export const HistoryWithUndo: Story = {
  render: () => <History />,
  play: async ({ canvasElement }) => {
    const list = must(canvasElement.querySelector<HTMLElement>('[data-variant="history"]'));
    await expectUnbrokenRules(list);
    const rows = [...list.querySelectorAll<HTMLElement>('[data-slot="history-row"]')];
    await expect(rows).toHaveLength(6);
    for (const row of rows) {
      const when = must(row.querySelector<HTMLElement>('[data-slot="history-when"]'));
      const what = must(row.querySelector<HTMLElement>('[data-slot="history-what"]'));
      await expect(Math.abs(baselineOf(when) - baselineOf(what))).toBeLessThanOrEqual(0.5);
      await expect(getComputedStyle(when).fontFamily).toMatch(/Martian Mono/);
      // Who is on its own line, under what — never after a "·".
      const who = must(row.querySelector<HTMLElement>('[data-slot="history-who"]'));
      await expect(who.getBoundingClientRect().top).toBeGreaterThanOrEqual(
        must(what.firstElementChild).getBoundingClientRect().bottom,
      );
      // At least the surface's row height.
      await expect(row.getBoundingClientRect().height).toBeGreaterThanOrEqual(
        resolvePx(row, 'var(--size-td)') - JUNCTION_TOLERANCE_PX,
      );
    }
    // The action centers on its row; the actions share one right edge, the list's.
    const listRight = list.getBoundingClientRect().right;
    for (const row of rows.slice(0, 5)) {
      const button = must(
        row.querySelector<HTMLElement>('[data-slot="button"]'),
      ).getBoundingClientRect();
      const r = row.getBoundingClientRect();
      const pt = parseFloat(getComputedStyle(row).paddingTop);
      const pb = parseFloat(getComputedStyle(row).paddingBottom);
      const mid = r.top + pt + (r.height - pt - pb) / 2;
      // Centering rounds to the device pixel, so within a pixel (a junction is a quarter).
      await expect(Math.abs(button.top + button.height / 2 - mid)).toBeLessThanOrEqual(1);
      await expect(Math.abs(button.right - listRight)).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
    }
    // The System row has no way back, and its text keeps the same column as the rest.
    await expect(must(rows[5]).querySelector('[data-slot="button"]')).toBeNull();
    const whatLeft = (row: HTMLElement) =>
      must(row.querySelector('[data-slot="history-what"]')).getBoundingClientRect().left;
    await expect(whatLeft(must(rows[5]))).toBeCloseTo(whatLeft(must(rows[0])), 1);
    // Undo works.
    onUndo.mockClear();
    await userEvent.click(within(must(rows[0])).getByRole('button', { name: 'Undo' }));
    await expect(onUndo).toHaveBeenCalledTimes(1);
    // The heading sits the heading gap over the list's first row.
    const chip = must(
      canvasElement.querySelector('[data-slot="section-chip"]'),
    ).getBoundingClientRect();
    await expect(
      Math.abs(
        list.getBoundingClientRect().top - chip.bottom - resolvePx(list, 'var(--gap-heading)'),
      ),
    ).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
  },
};

// ── Invoices ─────────────────────────────────────────────────────────────────────────────────

function Invoices() {
  const bill = (
    <Button variant="link" size="xs" external>
      Bill
    </Button>
  );
  return (
    <InvoiceList>
      <InvoiceRow vendor="Convex" period="Sep 2026" amount="$25.00" action={bill}>
        Pro plan · 1 seat · First full month on Pro
      </InvoiceRow>
      <InvoiceRow vendor="Vercel" period="Sep 2026" amount="$20.00" action={bill}>
        Pro · 1 seat
      </InvoiceRow>
      <InvoiceRow vendor="Convex" period="Aug 2026" amount="$25.00" action={bill}>
        Pro plan · 1 seat
      </InvoiceRow>
    </InvoiceList>
  );
}

/**
 * Invoices: vendor and period, the amount at the right on the same baseline, and the note across
 * the row under them with the bill's link at its end.
 */
export const Invoice: Story = {
  render: () => <Invoices />,
  play: async ({ canvasElement }) => {
    const list = must(canvasElement.querySelector<HTMLElement>('[data-variant="invoice"]'));
    await expectUnbrokenRules(list);
    const listBox = list.getBoundingClientRect();
    for (const row of list.querySelectorAll<HTMLElement>('[data-slot="invoice-row"]')) {
      const vendor = must(row.querySelector<HTMLElement>('[data-slot="invoice-vendor"]'));
      const amount = must(row.querySelector<HTMLElement>('[data-slot="invoice-amount"]'));
      const note = must(row.querySelector<HTMLElement>('[data-slot="invoice-note"]'));
      await expect(Math.abs(baselineOf(vendor) - baselineOf(amount))).toBeLessThanOrEqual(0.5);
      await expect(getComputedStyle(amount).fontFamily).toMatch(/Martian Mono/);
      await expect(
        Math.abs(amount.getBoundingClientRect().right - listBox.right),
      ).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
      // The note spans the row, under the vendor line, with the bill's link at its end.
      const n = note.getBoundingClientRect();
      await expect(Math.abs(n.left - listBox.left)).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
      await expect(Math.abs(n.right - listBox.right)).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
      await expect(n.top).toBeGreaterThanOrEqual(vendor.getBoundingClientRect().bottom);
      const link = within(note).getByRole('button', { name: /Bill/ }).getBoundingClientRect();
      await expect(Math.abs(link.right - listBox.right)).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
    }
  },
};

/**
 * The note and the link are optional: a row with neither is one line (vendor and amount), a row
 * with a note and no bill keeps the note across the row with nothing at its end.
 */
export const InvoiceBare: Story = {
  render: () => (
    <InvoiceList>
      <InvoiceRow vendor="Cloudflare" amount="$0.00" />
      <InvoiceRow vendor="Resend" period="Sep 2026" amount="$0.00">
        Free tier
      </InvoiceRow>
    </InvoiceList>
  ),
  play: async ({ canvasElement }) => {
    const list = must(canvasElement.querySelector<HTMLElement>('[data-variant="invoice"]'));
    await expectUnbrokenRules(list);
    const [bare, noted] = [...list.querySelectorAll<HTMLElement>('[data-slot="invoice-row"]')];
    await expect(must(bare).querySelector('[data-slot="invoice-note"]')).toBeNull();
    await expect(must(bare).querySelector('[data-slot="invoice-period"]')).toBeNull();
    const note = must(must(noted).querySelector<HTMLElement>('[data-slot="invoice-note"]'));
    await expect(note).toHaveTextContent('Free tier');
    await expect(within(note).queryByRole('button')).toBeNull();
  },
};

// ── Junction: a rule across a wide gap ───────────────────────────────────────────────────────

/**
 * The instrument: a three-column list with a wide column gap. Each row's dotted rule is measured
 * continuous from the list's left edge to its right, straight across both gaps.
 */
export const RuleAcrossTheGap: Story = {
  render: () => (
    <GridList columns="minmax(0, 1fr) auto auto" className="gap-x-(--space-10)">
      {[
        ['Open-Meteo', '7,600', '10,000'],
        ['OpenRouteService', '18', '2,000'],
        ['Resend', '2,950', '3,000'],
      ].map(([name, used, of]) => (
        <GridListRow key={name}>
          <span className="text-row leading-list text-fg1">{name}</span>
          <span className="font-(family-name:--family-mono) text-mono-sm text-fg">{used}</span>
          <span className="font-(family-name:--family-mono) text-mono-sm text-fg3">{of}</span>
        </GridListRow>
      ))}
    </GridList>
  ),
  play: async ({ canvasElement }) => {
    const list = must(canvasElement.querySelector<HTMLElement>('[data-slot="grid-list"]'));
    const gap = parseFloat(getComputedStyle(list).columnGap);
    await expect(gap).toBeCloseTo(resolvePx(list, 'var(--space-10)'), 1);
    await expectUnbrokenRules(list);
    // The cells do stand a full gap apart — the rule under them is still one line.
    const row = must(list.querySelector<HTMLElement>('li'));
    const [a, b] = [...row.children].map((c) => c.getBoundingClientRect());
    await expect(must(b).left - must(a).right).toBeGreaterThanOrEqual(gap - JUNCTION_TOLERANCE_PX);
    const r = row.getBoundingClientRect();
    await expect(r.width).toBeCloseTo(list.getBoundingClientRect().width, 1);
  },
};

// ── Four-up ──────────────────────────────────────────────────────────────────────────────────

/** All three lists in all four maps; the rules hold on every surface. */
export const FourUp: Story = {
  render: () => (
    <div className="flex flex-col gap-(--space-6)">
      <Facts ruled />
      <History />
      <Invoices />
    </div>
  ),
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      for (const list of q.querySelectorAll<HTMLElement>('[data-slot="grid-list"]')) {
        await expectUnbrokenRules(list);
      }
    }
  },
};
