import type { Meta, StoryObj } from '@storybook/react-vite';
import { type ReactNode, useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { computedColor, contrastBetween, JUNCTION_TOLERANCE_PX, resolvePx } from './measure';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectNote,
  SelectSeparator,
  SelectTrigger,
  type SelectTriggerProps,
  SelectValue,
} from './select';
import { KICKER, must, PSEUDO_STATES, StateMatrix } from './storyKit';

const meta = {
  title: 'Kit/Select',
  component: SelectTrigger,
  tags: ['autodocs'],
  // Room under the trigger for the list.
  decorators: [(Story) => <div className="w-[20rem] pb-[16rem]">{Story()}</div>],
} satisfies Meta<typeof SelectTrigger>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The open list, wherever it was portaled (the document, or a four-up quad). Base UI keeps a
 * closed list mounted (hidden) once it has opened, so "open" is its `data-open`.
 */
const popup = (root: ParentNode = document) =>
  root.querySelector<HTMLElement>('[data-slot="select-content"][data-open]');
const option = (name: string) => within(must(popup())).getByRole('option', { name });

const KINDS = {
  town: 'Town',
  camp: 'Camp',
  river: 'River',
  island: 'Island',
  dam: 'Dam',
} as const;

/** A landmark's kind: the form select, two groups under kickers, one kind not open yet. */
function KindSelect({
  onValueChange,
  defaultValue,
  open,
  container,
  onOpenChangeComplete,
}: {
  onValueChange?: (value: string | null) => void;
  defaultValue?: string;
  open?: boolean;
  container?: HTMLElement | null;
  onOpenChangeComplete?: (open: boolean) => void;
}) {
  return (
    <Select
      items={KINDS}
      defaultValue={defaultValue ?? null}
      onValueChange={onValueChange}
      open={open}
      onOpenChangeComplete={onOpenChangeComplete}
    >
      <SelectTrigger aria-label="Kind">
        <SelectValue placeholder="Choose a kind" />
      </SelectTrigger>
      <SelectContent container={container}>
        <SelectGroup>
          <SelectGroupLabel>On the shore</SelectGroupLabel>
          <SelectItem value="town">Town</SelectItem>
          <SelectItem value="camp">Camp</SelectItem>
        </SelectGroup>
        <SelectSeparator />
        <SelectGroup>
          <SelectGroupLabel>On the water</SelectGroupLabel>
          <SelectItem value="river">River</SelectItem>
          <SelectItem value="island">Island</SelectItem>
          <SelectItem value="dam" disabled>
            Dam
          </SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

const SOURCES = {
  s2true: 'Sentinel-2 true color',
  s2false: 'Sentinel-2 false color',
  naip: 'NAIP aerial',
} as const;

/** The imagery toolbar's source picker: caps on a hairline box. */
function SourceSelect({ variant = 'boxed', ...props }: Partial<SelectTriggerProps>) {
  return (
    <Select items={SOURCES} defaultValue="s2true">
      <SelectTrigger variant={variant} aria-label="Imagery source" {...props}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {Object.entries(SOURCES).map(([value, label]) => (
          <SelectItem key={value} value={value}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const changed = fn();
/** Called once the list has finished opening (or closing). */
const settled = fn();

/** Waits for the open list's highlight to land on `name` (and says where it is if not). */
const highlighted = (name: string) =>
  waitFor(() =>
    expect(popup()?.querySelector('[data-highlighted]')?.textContent ?? 'nothing').toBe(name),
  );

/**
 * The form select (`.sel3`): the placeholder in the faint ink until a kind is chosen; the list
 * drops below on a square plate; the chosen kind carries the inset bar when it opens again.
 */
export const Underline: Story = {
  render: () => <KindSelect onValueChange={changed} />,
  beforeEach: () => changed.mockClear(),
  play: async ({ canvasElement }) => {
    const trigger = within(canvasElement).getByRole('combobox', { name: 'Kind' });
    const value = must(trigger.querySelector<HTMLElement>('[data-slot="select-value"]'));
    await expect(value).toHaveTextContent('Choose a kind');
    await expect(getComputedStyle(value).color).toBe(computedColor(value, 'var(--fg3)'));
    // One rule, no box, no corner.
    const style = getComputedStyle(trigger);
    await expect(style.borderBottomColor).toBe(computedColor(trigger, 'var(--line2)'));
    await expect(style.borderTopWidth).toBe('0px');
    await expect(style.borderRadius).toBe('0px');
    // The caret is FontAwesome's angle-down.
    await expect(trigger.querySelector('svg')).toHaveClass('fa-angle-down');

    await userEvent.click(trigger);
    const plate = await waitFor(() => must(popup()));
    const p = getComputedStyle(plate);
    await expect(p.borderRadius).toBe('0px');
    await expect(p.backgroundColor).toBe(computedColor(plate, 'var(--plate-solid)'));
    await expect(p.borderTopColor).toBe(computedColor(plate, 'var(--line2)'));
    // Below the trigger, never over it.
    await waitFor(() =>
      expect(plate.getBoundingClientRect().top).toBeGreaterThanOrEqual(
        trigger.getBoundingClientRect().bottom,
      ),
    );
    await userEvent.click(option('River'));
    await expect(changed).toHaveBeenCalledWith('river', expect.anything());
    await waitFor(() => expect(popup()).toBeNull());
    await expect(value).toHaveTextContent('River');
    await expect(getComputedStyle(value).color).toBe(computedColor(value, 'var(--fg)'));

    // Open again: the chosen kind wears the inset bar, the others don't.
    await userEvent.click(trigger);
    await waitFor(() => expect(popup()).not.toBeNull());
    const river = option('River');
    await expect(river).toHaveAttribute('data-selected');
    await expect(getComputedStyle(river).boxShadow).toMatch(/inset/);
    await expect(getComputedStyle(option('Town')).boxShadow).toBe('none');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(popup()).toBeNull());
  },
};

/** The toolbar select (`.sel2`): caps on a hairline box, the control corner. */
export const Boxed: Story = {
  render: () => <SourceSelect />,
  play: async ({ canvasElement }) => {
    const trigger = within(canvasElement).getByRole('combobox', { name: 'Imagery source' });
    const style = getComputedStyle(trigger);
    await expect(style.textTransform).toBe('uppercase');
    await expect(style.boxShadow).toMatch(/inset/);
    await expect(style.borderRadius).toBe(
      getComputedStyle(document.documentElement).getPropertyValue('--corner-control').trim(),
    );
    await expect(trigger).toHaveTextContent('Sentinel-2 true color');
    await userEvent.click(trigger);
    await waitFor(() => expect(popup()).not.toBeNull());
    // Its options are sentence case, like every list's.
    await expect(getComputedStyle(option('NAIP aerial')).textTransform).toBe('none');
    await userEvent.click(option('NAIP aerial'));
    await waitFor(() => expect(trigger).toHaveTextContent('NAIP aerial'));
  },
};

/**
 * The keyboard: ↓ opens the list on the chosen option, ↑↓ move the highlight (a disabled kind can
 * be reached, so it can be read, but ⏎ on it does nothing), typing jumps to a match, ⏎ chooses
 * and gives focus back.
 */
export const Keyboard: Story = {
  render: () => (
    <KindSelect defaultValue="river" onValueChange={changed} onOpenChangeComplete={settled} />
  ),
  beforeEach: () => {
    changed.mockClear();
    settled.mockClear();
  },
  play: async ({ canvasElement }) => {
    const trigger = within(canvasElement).getByRole('combobox', { name: 'Kind' });
    trigger.focus();
    await userEvent.keyboard('{ArrowDown}');
    // Navigate once the list has opened, as a person would; keys sent mid-transition race it.
    await waitFor(() => expect(settled).toHaveBeenCalledWith(true));
    await highlighted('River');
    await userEvent.keyboard('{ArrowDown}');
    await highlighted('Island');
    await userEvent.keyboard('{ArrowDown}');
    await highlighted('Dam');
    await userEvent.keyboard('{Enter}');
    await expect(changed).not.toHaveBeenCalled();
    await expect(popup()).not.toBeNull();
    // Type-ahead.
    await userEvent.keyboard('c');
    await highlighted('Camp');
    await userEvent.keyboard('{Enter}');
    await expect(changed).toHaveBeenCalledWith('camp', expect.anything());
    await waitFor(() => expect(popup()).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
  },
};

/** A disabled option keeps its place, dimmed; pressing it changes nothing. */
export const DisabledOption: Story = {
  render: () => <KindSelect open onValueChange={changed} />,
  beforeEach: () => changed.mockClear(),
  play: async () => {
    const dam = await waitFor(() => option('Dam'));
    await expect(dam).toHaveAttribute('aria-disabled', 'true');
    await expect(getComputedStyle(dam).color).toBe(computedColor(dam, 'var(--fg-disabled)'));
    await userEvent.click(dam, { pointerEventsCheck: 0 });
    await expect(changed).not.toHaveBeenCalled();
  },
};

/** A select that can't be changed: the disabled ink and rule; pressing doesn't open it. */
export const Disabled: Story = {
  render: () => (
    <div className="flex flex-col gap-heading">
      <Select items={KINDS} defaultValue="town" disabled>
        <SelectTrigger aria-label="Kind">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="town">Town</SelectItem>
        </SelectContent>
      </Select>
      <Select items={SOURCES} defaultValue="naip" disabled>
        <SelectTrigger variant="boxed" aria-label="Imagery source">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="naip">NAIP aerial</SelectItem>
        </SelectContent>
      </Select>
    </div>
  ),
  play: async ({ canvasElement }) => {
    for (const trigger of within(canvasElement).getAllByRole('combobox')) {
      await expect(getComputedStyle(trigger).color).toBe(
        computedColor(trigger, 'var(--fg-disabled)'),
      );
      await userEvent.click(trigger, { pointerEventsCheck: 0 });
      await expect(popup()).toBeNull();
    }
  },
};

/** A field that has to be chosen and isn't: the red rule (or rim). */
export const Invalid: Story = {
  render: () => (
    <div className="flex flex-col gap-heading">
      <Select items={KINDS}>
        <SelectTrigger aria-label="Kind" aria-invalid>
          <SelectValue placeholder="Choose a kind" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="town">Town</SelectItem>
        </SelectContent>
      </Select>
      <SourceSelect aria-invalid />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const [underline, boxed] = within(canvasElement).getAllByRole('combobox');
    const u = must(underline);
    await expect(getComputedStyle(u).borderBottomColor).toBe(computedColor(u, 'var(--bad)'));
    const b = must(boxed);
    await expect(getComputedStyle(b).boxShadow).toContain(computedColor(b, 'var(--bad)'));
  },
};

/** Nothing to choose yet: one note row an option tall, so the plate never collapses. */
export const Empty: Story = {
  render: () => (
    <Select open>
      <SelectTrigger variant="boxed" aria-label="Provider">
        <SelectValue placeholder="Provider" />
      </SelectTrigger>
      <SelectContent>
        <SelectNote>No providers yet</SelectNote>
      </SelectContent>
    </Select>
  ),
  play: async () => {
    const plate = await waitFor(() => must(popup()));
    const note = must(plate.querySelector<HTMLElement>('[data-slot="select-note"]'));
    await expect(note.getBoundingClientRect().height).toBeCloseTo(
      resolvePx(plate, 'var(--size-td)'),
      1,
    );
    await expect(getComputedStyle(note).color).toBe(computedColor(note, 'var(--fg3)'));
  },
};

// ── Matrix and four-up ────────────────────────────────────────────────────────────────────────

const ROWS = [
  { key: 'underline', label: 'Underline' },
  { key: 'boxed', label: 'Boxed' },
] as const;
const STATES = [
  { key: 'rest', label: 'Rest' },
  { key: 'hover', label: 'Hover' },
  { key: 'focus', label: 'Focus' },
  { key: 'active', label: 'Pressed' },
  { key: 'disabled', label: 'Disabled' },
] as const;

/** Both triggers in each state; the open list is the next story. */
export const States: Story = {
  decorators: [(Story) => Story()],
  render: () => (
    <StateMatrix
      rows={ROWS}
      states={STATES}
      cell={(variant, state) => (
        <div className="w-[12rem]">
          <Select items={SOURCES} defaultValue="s2true" disabled={state === 'disabled'}>
            <SelectTrigger variant={variant} data-state={state} aria-label={`${variant} ${state}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="s2true">Sentinel-2 true color</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}
    />
  ),
  parameters: PSEUDO_STATES,
  play: async ({ canvasElement }) => {
    // Every live trigger's value passes AA on its ground.
    for (const t of canvasElement.querySelectorAll<HTMLElement>('[data-slot="select-trigger"]')) {
      if (t.hasAttribute('data-disabled')) continue;
      const bg = getComputedStyle(t).backgroundColor;
      const ground = bg === 'rgba(0, 0, 0, 0)' ? ['var(--bg)'] : ['var(--bg)', bg];
      const ratio = contrastBetween(t, ground, [...ground, getComputedStyle(t).color]);
      await expect(ratio).toBeGreaterThanOrEqual(4.5);
    }
  },
};

/** The list open as a board draws it: a kicker, the chosen option's bar, a dimmed option. */
export const Open: Story = {
  render: () => <KindSelect open defaultValue="river" />,
  play: async () => {
    const plate = await waitFor(() => must(popup()));
    // Every live option, the chosen one and the kicker pass AA on the plate.
    const ground = ['var(--bg)', 'var(--plate-solid)'];
    for (const el of plate.querySelectorAll<HTMLElement>(
      '[data-slot="select-item"]:not([data-disabled]), [data-slot="select-group-label"]',
    )) {
      const ratio = contrastBetween(el, ground, [...ground, getComputedStyle(el).color]);
      await expect(ratio).toBeGreaterThanOrEqual(4.5);
    }
  },
};

function QuadSelect(): ReactNode {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  return (
    <div ref={setContainer} className="relative w-[14rem] pb-[15rem]">
      {container !== null && <KindSelect open defaultValue="river" container={container} />}
    </div>
  );
}

/** Open in all four maps — each list portaled into its own quad, so it takes that quad's theme. */
export const FourUp: Story = {
  render: () => <QuadSelect />,
  parameters: { fourUp: true },
  decorators: [(Story) => Story()],
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    const plates = new Set<string>();
    for (const q of quads) {
      const plate = await waitFor(() => must(popup(q)));
      plates.add(getComputedStyle(plate).backgroundColor);
      const trigger = must(q.querySelector('[data-slot="select-trigger"]')).getBoundingClientRect();
      await expect(trigger.height).toBeCloseTo(resolvePx(q, 'var(--size-btn)'), 1);
      const row = must(q.querySelector('[data-slot="select-item"]')).getBoundingClientRect();
      await expect(row.height).toBeCloseTo(resolvePx(q, 'var(--size-td)'), 1);
    }
    await expect(plates.size).toBeGreaterThan(1);
  },
};

// ── Junctions ─────────────────────────────────────────────────────────────────────────────────

/**
 * Both triggers stand the surface's button height (so they line up with buttons and inputs in a
 * bar); the plate drops 4 px under the trigger, at least its width; rows are a table row tall
 * and inset 1.15 em; a group's kicker starts where its options' words start.
 */
function OpenJunction() {
  return (
    // Clear of the frame's edge, so the plate isn't nudged by collision padding.
    <div className="m-(--space-8) flex flex-col gap-heading">
      <SourceSelect />
      <KindSelect open defaultValue="river" />
      <p className={KICKER}>Triggers a button tall; rows a table row tall</p>
    </div>
  );
}

async function playOpenJunction({ canvasElement }: { canvasElement: HTMLElement }) {
  const btn = resolvePx(canvasElement, 'var(--size-btn)');
  const [boxed, underline] = [
    ...canvasElement.querySelectorAll<HTMLElement>('[data-slot="select-trigger"]'),
  ];
  await expect(must(boxed).getBoundingClientRect().height).toBeCloseTo(btn, 1);
  const t = must(underline).getBoundingClientRect();
  await expect(t.height).toBeCloseTo(btn, 1);
  const plate = await waitFor(() => must(popup()));
  await waitFor(() =>
    expect(Math.abs(plate.getBoundingClientRect().top - t.bottom - 4)).toBeLessThanOrEqual(1),
  );
  const p = plate.getBoundingClientRect();
  await expect(p.width).toBeGreaterThanOrEqual(t.width - JUNCTION_TOLERANCE_PX);
  await expect(Math.abs(p.left - t.left)).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
  const td = resolvePx(plate, 'var(--size-td)');
  const items = [...plate.querySelectorAll<HTMLElement>('[data-slot="select-item"]')];
  for (const item of items) await expect(item.getBoundingClientRect().height).toBeCloseTo(td, 1);
  // The word sits 1.15 em in from the plate's inner edge.
  const first = must(items[0]);
  const em = parseFloat(getComputedStyle(first).fontSize);
  const textLeft = (el: Element) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return range.getBoundingClientRect().left;
  };
  const word = textLeft(must(first.querySelector('[data-slot="select-item"] > *')));
  await expect(word - first.getBoundingClientRect().left).toBeCloseTo(1.15 * em, 0);
  // The kicker starts where the words do.
  const kicker = must(plate.querySelector('[data-slot="select-group-label"]'));
  await expect(Math.abs(textLeft(kicker) - word)).toBeLessThanOrEqual(1);
}

export const JunctionOpenAdmin: Story = {
  render: () => <OpenJunction />,
  globals: { surface: 'admin' },
  play: playOpenJunction,
};

export const JunctionOpenSkater: Story = {
  render: () => <OpenJunction />,
  globals: { surface: 'skater' },
  play: playOpenJunction,
};
