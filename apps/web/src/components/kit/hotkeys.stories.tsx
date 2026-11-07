import type { Meta, StoryObj } from '@storybook/react-vite';
import { type ReactNode, useRef, useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import {
  type GoLetter,
  KeysProvider,
  modKey,
  useGlobalKey,
  useGoMode,
  useGoTarget,
  usePaneKeys,
} from '@/lib/keys';

import { Button } from './button';
import { GoBar } from './go-bar';
import { Input } from './input';
import { Kbd } from './kbd';
import { computedColor, JUNCTION_TOLERANCE_PX, resolvePx } from './measure';
import { MiddleList, type MiddleListItem } from './middle-list';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select';
import { KICKER, must } from './storyKit';

/**
 * The console's keyboard layer (`lib/keys.ts`) on the bench: a small console with a rail, the
 * middle list and a detail pane, wired the way the shell will wire them. The go bar is the kit
 * piece; everything else here is the layer's behavior, proved in a real browser.
 */
const meta = {
  title: 'Kit/Hotkeys',
  component: GoBar,
  tags: ['autodocs'],
} satisfies Meta<typeof GoBar>;

export default meta;
type Story = StoryObj<typeof meta>;

// ── The bench console ───────────────────────────────────────────────────────────────────────

const PLACES: ReadonlyArray<{ key: GoLetter; label: string }> = [
  { key: 'I', label: 'Inbox' },
  { key: 'R', label: 'Reports' },
  { key: 'B', label: 'Bodies' },
  { key: 'A', label: 'the app' },
];

const ROWS: MiddleListItem[] = [
  { id: 'ridge', title: 'Pressure ridge off the north shore', sub: 'Mascoma Lake', meta: '4 d' },
  { id: 'inlet', title: 'Open water by the inlet', sub: 'Post Pond', meta: '5 d' },
  { id: 'reed', title: 'Reeds frozen in at the launch', sub: 'Lake Morey', meta: '6 d' },
  { id: 'crack', title: 'Crack across the bay', sub: 'Goose Pond', meta: '8 d' },
];

/** A rail item: reachable by G then its letter; in go-mode it wears the ice cap. */
function RailItem({ place, onGo }: { place: (typeof PLACES)[number]; onGo: (to: string) => void }) {
  useGoTarget({ key: place.key, label: place.label, run: () => onGo(place.label) });
  const { active } = useGoMode();
  return (
    <li className="flex h-rail-item items-center justify-between gap-(--space-2) px-(--space-3)">
      <span className="text-row text-fg2">{place.label}</span>
      {active && (
        <Kbd variant="go" spent="G" data-slot="go-chip">
          {place.key}
        </Kbd>
      )}
    </li>
  );
}

/** The detail pane: its letter keys act only while focus is inside it. */
function Detail({
  open,
  act,
  backToList,
}: {
  open: MiddleListItem | undefined;
  act: (what: string) => void;
  backToList: () => void;
}) {
  const pane = useRef<HTMLElement>(null);
  usePaneKeys(pane, [
    { key: 'R', run: () => act('Resolve'), label: 'Resolve' },
    { key: 'H', run: () => act('Hide'), label: 'Hide' },
    { key: 'Shift+Enter', run: backToList, label: 'Back to the queue' },
  ]);
  return (
    <section
      ref={pane}
      id="bench-detail"
      tabIndex={-1}
      aria-label="Detail"
      className="flex min-w-0 flex-1 flex-col gap-heading p-gutter outline-none focus-visible:shadow-[inset_0_0_0_var(--stroke-hair)_var(--fg)]"
    >
      <h2 className="m-0 text-h font-medium text-fg">{open?.title ?? 'Pick a report'}</h2>
      <div className="flex gap-(--space-2)">
        <Button aria-keyshortcuts="R" onClick={() => act('Resolve')}>
          Resolve <Kbd aria-hidden="true">R</Kbd>
        </Button>
        <Button aria-keyshortcuts="H" onClick={() => act('Hide')}>
          Hide <Kbd aria-hidden="true">H</Kbd>
        </Button>
      </div>
      <Input aria-label="Note" placeholder="Add a note" />
      <Select items={REASONS} defaultValue={null}>
        <SelectTrigger aria-label="Reason">
          <SelectValue placeholder="Choose a reason" />
        </SelectTrigger>
        <SelectContent>
          {REASONS.map((r) => (
            <SelectItem key={r.value} value={r.value}>
              {r.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </section>
  );
}

const REASONS = [
  { value: 'dupe', label: 'Duplicate' },
  { value: 'gone', label: 'Gone by now' },
  { value: 'rude', label: 'Rude' },
  { value: 'spam', label: 'Spam' },
];

/** The shell: rail, list, detail, the status bar, and the go bar over them. */
function BenchConsole() {
  const [log, setLog] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const note = (what: string) => setLog((l) => [...l, what]);
  useGlobalKey('Mod+K', () => note('Palette'));
  useGlobalKey('?', () => note('Key sheet'));
  const listRef = useRef<HTMLDivElement>(null);
  return (
    <div
      data-slot="bench-console"
      className="relative flex h-[30rem] w-[56rem] flex-col border border-solid border-line bg-bg"
    >
      <div className="flex min-h-0 flex-1">
        <ul
          aria-label="Rail"
          className="m-0 w-[10rem] shrink-0 list-none border-0 border-r border-solid border-line p-0"
        >
          {PLACES.map((p) => (
            <RailItem key={p.key} place={p} onGo={(to) => note(`Go ${to}`)} />
          ))}
        </ul>
        <div
          ref={listRef}
          className="flex w-list shrink-0 flex-col border-0 border-r border-solid border-line"
        >
          <MiddleList
            className="flex-1"
            label="Open reports"
            emptyLabel="Nothing open"
            items={ROWS}
            selectedId={selected}
            onOpen={(id) => {
              setSelected(id);
              document.getElementById('bench-detail')?.focus();
            }}
          />
        </div>
        <Detail
          open={ROWS.find((r) => r.id === selected)}
          act={note}
          backToList={() =>
            listRef.current?.querySelector<HTMLElement>('[role="listbox"]')?.focus()
          }
        />
      </div>
      <div
        data-slot="status-bar"
        className="flex h-status shrink-0 items-center border-0 border-t border-solid border-line px-gutter"
      >
        <output aria-label="Log" className={KICKER}>
          {log.join(' · ') || 'Nothing yet'}
        </output>
      </div>
      <GoBar />
    </div>
  );
}

function Bench(): ReactNode {
  return (
    <KeysProvider>
      <BenchConsole />
    </KeysProvider>
  );
}

const logOf = (root: HTMLElement) => within(root).getByRole('status', { name: 'Log' });
const goBar = (root: HTMLElement) => must(root.querySelector<HTMLElement>('[data-slot="go-bar"]'));
const list = (root: HTMLElement) => within(root).getByRole('listbox', { name: 'Open reports' });
const detail = (root: HTMLElement) => within(root).getByRole('region', { name: 'Detail' });
const activeRow = (box: HTMLElement) =>
  document.getElementById(box.getAttribute('aria-activedescendant') ?? '');
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const near = (a: number, b: number, tol = JUNCTION_TOLERANCE_PX) =>
  expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);

// ── Behavior ────────────────────────────────────────────────────────────────────────────────

/**
 * The whole layer at once: Tab into the list, ↑↓, ⏎ opens and moves focus right, R resolves
 * there, ⇧⏎ returns to the queue, G then B goes to Bodies.
 */
export const Console: Story = {
  render: () => <Bench />,
  play: async ({ canvasElement }) => {
    const box = list(canvasElement);
    box.focus();
    await userEvent.keyboard('{ArrowDown}{Enter}');
    await expect(detail(canvasElement)).toHaveFocus();
    await userEvent.keyboard('r');
    await expect(logOf(canvasElement)).toHaveTextContent('Resolve');
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}');
    await expect(box).toHaveFocus();
    await userEvent.keyboard('g');
    await waitFor(() => expect(goBar(canvasElement)).toHaveAttribute('data-open'));
    await userEvent.keyboard('b');
    await expect(logOf(canvasElement)).toHaveTextContent('Resolve · Go Bodies');
    await expect(goBar(canvasElement)).not.toHaveAttribute('data-open');
  },
};

/**
 * Letters act only in the focused pane (R3). In the list, R is type-ahead (to "Reeds…"), never
 * Resolve; in the detail pane it resolves; with focus on the rail's side of the page, nothing.
 */
export const LettersOnlyInTheFocusedPane: Story = {
  render: () => <Bench />,
  play: async ({ canvasElement }) => {
    const box = list(canvasElement);
    box.focus();
    await userEvent.keyboard('r');
    await expect(activeRow(box)).toHaveTextContent('Reeds frozen in');
    await expect(logOf(canvasElement)).toHaveTextContent('Nothing yet');
    await pause(600);
    await userEvent.keyboard('h');
    await expect(logOf(canvasElement)).toHaveTextContent('Nothing yet');
    // Focus in the pane — on the pane itself, then on one of its buttons: R and H act.
    detail(canvasElement).focus();
    await userEvent.keyboard('r');
    await expect(logOf(canvasElement)).toHaveTextContent('Resolve');
    within(canvasElement).getByRole('button', { name: /Hide/ }).focus();
    await userEvent.keyboard('h');
    await expect(logOf(canvasElement)).toHaveTextContent('Resolve · Hide');
    // A button keeps its own Enter: ⏎ on Hide presses Hide, it doesn't reach a pane key.
    await userEvent.keyboard('{Enter}');
    await expect(logOf(canvasElement)).toHaveTextContent('Resolve · Hide · Hide');
    // Outside every pane, nothing.
    (document.activeElement as HTMLElement | null)?.blur();
    await userEvent.keyboard('r');
    await expect(logOf(canvasElement)).toHaveTextContent('Resolve · Hide · Hide');
  },
};

/**
 * In a text field a letter types: R, H and G go into the note, and nothing fires. ⌘K still opens
 * the palette from inside the field; `?` types there too.
 */
export const TextFieldsTypeLetters: Story = {
  render: () => <Bench />,
  play: async ({ canvasElement }) => {
    const field = within(canvasElement).getByRole('textbox', { name: 'Note' });
    await userEvent.click(field);
    await userEvent.keyboard('rhg?');
    await expect(field).toHaveValue('rhg?');
    await expect(logOf(canvasElement)).toHaveTextContent('Nothing yet');
    await expect(goBar(canvasElement)).not.toHaveAttribute('data-open');
    const mod = modKey();
    await userEvent.keyboard(`{${mod}>}k{/${mod}}`);
    await expect(logOf(canvasElement)).toHaveTextContent('Palette');
    await expect(field).toHaveValue('rhg?');
  },
};

/** ⌘K and `?` from anywhere — the list, the pane, nowhere in particular. */
export const GlobalKeys: Story = {
  render: () => <Bench />,
  play: async ({ canvasElement }) => {
    const mod = modKey();
    list(canvasElement).focus();
    await userEvent.keyboard(`{${mod}>}k{/${mod}}`);
    await expect(logOf(canvasElement)).toHaveTextContent('Palette');
    // `?` passes through the list's type-ahead at the start of a run…
    await userEvent.keyboard('{Shift>}?{/Shift}');
    await expect(logOf(canvasElement)).toHaveTextContent('Palette · Key sheet');
    detail(canvasElement).focus();
    await userEvent.keyboard('?');
    await expect(logOf(canvasElement)).toHaveTextContent('Palette · Key sheet · Key sheet');
    // …but inside a run it's a letter of the run.
    list(canvasElement).focus();
    await userEvent.keyboard('o?');
    await expect(logOf(canvasElement)).toHaveTextContent('Palette · Key sheet · Key sheet');
  },
};

/**
 * G then a letter, from anywhere: the go bar comes up (ice, bottom center) and the rail's letters
 * light as ice caps; the letter goes and the bar leaves. Esc leaves; any other key leaves and is
 * swallowed (it doesn't land in the list's type-ahead); so does a press. While go-mode is open, a
 * pane's letters are go-mode's.
 */
export const GoMode: Story = {
  render: () => <Bench />,
  play: async ({ canvasElement }) => {
    const box = list(canvasElement);
    const bar = goBar(canvasElement);
    box.focus();
    await expect(bar).toBeEmptyDOMElement();
    await userEvent.keyboard('g');
    await waitFor(() => expect(bar).toHaveAttribute('data-open'));
    await expect(bar).toHaveTextContent(
      'GoG pressed · Select a nav item by its letter, like I to open InboxEsc',
    );
    const chips = canvasElement.querySelectorAll('[data-slot="go-chip"]');
    await expect(chips).toHaveLength(4);
    for (const chip of chips) await expect(chip).toHaveAttribute('data-variant', 'go');
    await userEvent.keyboard('i');
    await expect(logOf(canvasElement)).toHaveTextContent('Go Inbox');
    await expect(bar).not.toHaveAttribute('data-open');
    await expect(canvasElement.querySelectorAll('[data-slot="go-chip"]')).toHaveLength(0);
    await expect(box).toHaveFocus();
    // Esc leaves.
    await userEvent.keyboard('g{Escape}');
    await expect(bar).not.toHaveAttribute('data-open');
    // A stray key leaves and is swallowed: the list's cursor doesn't move to "Open water".
    const before = activeRow(box);
    await userEvent.keyboard('go');
    await expect(bar).not.toHaveAttribute('data-open');
    await expect(activeRow(box)).toBe(before);
    // G again leaves too.
    await userEvent.keyboard('gg');
    await expect(bar).not.toHaveAttribute('data-open');
    // In the detail pane, G then R is Reports — not Resolve.
    detail(canvasElement).focus();
    await userEvent.keyboard('gr');
    await expect(logOf(canvasElement)).toHaveTextContent(/^Go Inbox · Go Reports$/);
    // A press anywhere leaves.
    await userEvent.keyboard('g');
    await waitFor(() => expect(bar).toHaveAttribute('data-open'));
    await userEvent.click(within(canvasElement).getByRole('list', { name: 'Rail' }));
    await expect(bar).not.toHaveAttribute('data-open');
  },
};

/**
 * A composite keeps its own keys (#56): with the Reason select open inside the detail pane, ↑↓
 * move its highlight and letters type ahead in it — the list's cursor stays put, R doesn't
 * resolve, G doesn't open go-mode, ? doesn't open the sheet. Esc closes the select only.
 */
export const CompositeKeysStayInside: Story = {
  render: () => <Bench />,
  play: async ({ canvasElement }) => {
    const box = list(canvasElement);
    box.focus();
    await userEvent.keyboard('{ArrowDown}');
    const cursor = activeRow(box);
    await userEvent.click(within(canvasElement).getByRole('combobox', { name: 'Reason' }));
    const popup = await waitFor(() =>
      must(document.querySelector<HTMLElement>('[data-slot="select-content"][data-open]')),
    );
    const highlighted = () => popup.querySelector('[data-highlighted]');
    await userEvent.keyboard('{ArrowDown}');
    await waitFor(() => expect(highlighted()).not.toBeNull());
    const first = highlighted();
    await userEvent.keyboard('{ArrowDown}');
    await waitFor(() => expect(highlighted()).not.toBe(first));
    await userEvent.keyboard('r');
    await waitFor(() => expect(highlighted()).toHaveTextContent('Rude'));
    // A fresh run in the select (its own type-ahead window is longer than the list's).
    await pause(1200);
    await userEvent.keyboard('g');
    await waitFor(() => expect(highlighted()).toHaveTextContent('Gone by now'));
    await userEvent.keyboard('?');
    await expect(logOf(canvasElement)).toHaveTextContent('Nothing yet');
    await expect(goBar(canvasElement)).not.toHaveAttribute('data-open');
    await expect(activeRow(box)).toBe(cursor);
    await userEvent.keyboard('{Escape}');
    await waitFor(() =>
      expect(document.querySelector('[data-slot="select-content"][data-open]')).toBeNull(),
    );
    await expect(goBar(canvasElement)).not.toHaveAttribute('data-open');
    await expect(logOf(canvasElement)).toHaveTextContent('Nothing yet');
  },
};

// ── The go bar ──────────────────────────────────────────────────────────────────────────────

/** A frame the size of a console's foot: the status bar along the bottom, the bar over it. */
function Frame({ children }: { children: ReactNode }) {
  return (
    <div
      data-slot="frame"
      className="relative h-[9rem] w-[40rem] max-w-full overflow-hidden border border-solid border-line bg-bg"
    >
      <div
        data-slot="status-bar"
        className="absolute inset-x-0 bottom-0 h-status border-0 border-t border-solid border-line"
      />
      {children}
    </div>
  );
}

const EXAMPLE = { key: 'I', label: 'Inbox' } as const;

/** Open, as the boards draw it, in all four maps. */
export const GoBarFourUp: Story = {
  render: () => (
    <Frame>
      <GoBar open example={EXAMPLE} />
    </Frame>
  ),
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      const bar = must(q.querySelector<HTMLElement>('[data-slot="go-bar"]'));
      await expect(bar).toHaveRole('status');
      const acc = computedColor(bar, 'var(--acc)');
      await expect(getComputedStyle(bar).borderTopColor).toBe(acc);
      const kicker = must(bar.querySelector<HTMLElement>('[data-slot="go-bar-kicker"]'));
      await expect(getComputedStyle(kicker).color).toBe(acc);
      for (const b of bar.querySelectorAll('b')) {
        await expect(getComputedStyle(b).color).toBe(computedColor(bar, 'var(--fg)'));
      }
      await expect(getComputedStyle(bar).color).toBe(computedColor(bar, 'var(--fg2)'));
    }
  },
};

/**
 * The mock's geometry, in tokens: the status bar's height plus `space-4_5` up from the console's
 * foot (44 px on the console), centered; `space-8` (32 px) tall; `space-3_5` in from each end,
 * `space-3` between its parts; an ice hairline; over everything but toasts and sheets.
 */
async function playGeometry({ canvasElement }: { canvasElement: HTMLElement }) {
  await document.fonts.ready;
  const frame = must(canvasElement.querySelector<HTMLElement>('[data-slot="frame"]'));
  const bar = must(frame.querySelector<HTMLElement>('[data-slot="go-bar"]'));
  const px = (len: string) => resolvePx(bar, len);
  const f = frame.getBoundingClientRect();
  const b = bar.getBoundingClientRect();
  const hair = px('var(--stroke-hair)');
  // The frame's own border: the bar is placed inside it.
  await near(f.bottom - hair - b.bottom, px('calc(var(--size-status) + var(--space-4_5))'));
  await near((b.left + b.right) / 2, (f.left + f.right) / 2, 0.5);
  await near(b.height, px('var(--space-8)'));
  const s = getComputedStyle(bar);
  await near(parseFloat(s.paddingLeft), px('var(--space-3_5)'));
  await near(parseFloat(s.paddingRight), px('var(--space-3_5)'));
  await near(parseFloat(s.columnGap), px('var(--space-3)'));
  await near(parseFloat(s.borderTopWidth), hair);
  await expect(s.zIndex).toBe(getComputedStyle(bar).getPropertyValue('--z-gobar').trim());
  // The parts sit `space-3` apart, content to content.
  const parts = [...bar.children].map((c) => c.getBoundingClientRect());
  for (let i = 1; i < parts.length; i++) {
    await near(must(parts[i]).left - must(parts[i - 1]).right, px('var(--space-3)'));
  }
  // On the console that is the mock's 44 px and 32 px exactly (rem at the default root size).
  if (document.documentElement.getAttribute('data-surface') === 'admin') {
    await near(px('calc(var(--size-status) + var(--space-4_5))'), 44);
    await near(b.height, 32);
  }
}

export const GoBarGeometryAdmin: Story = {
  render: () => (
    <Frame>
      <GoBar open example={EXAMPLE} />
    </Frame>
  ),
  globals: { surface: 'admin' },
  play: playGeometry,
};

export const GoBarGeometrySkater: Story = {
  ...GoBarGeometryAdmin,
  globals: { surface: 'skater' },
};

/**
 * Closed, it's still in the page — an empty live region, invisible — so a reader hears the line
 * when go-mode opens. It fades on `duration-fast` with the standard easing: zero under reduced
 * motion, where it simply appears.
 */
export const GoBarFades: Story = {
  render: () => (
    <KeysProvider>
      <Frame>
        <GoBar example={EXAMPLE} />
      </Frame>
    </KeysProvider>
  ),
  play: async ({ canvasElement }) => {
    const bar = must(canvasElement.querySelector<HTMLElement>('[data-slot="go-bar"]'));
    await expect(bar).toHaveRole('status');
    await expect(bar).toBeEmptyDOMElement();
    await expect(getComputedStyle(bar).visibility).toBe('hidden');
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const s = getComputedStyle(bar);
    await expect(s.transitionProperty).toContain('opacity');
    await expect(s.transitionDuration.split(',')[0]?.trim()).toBe(reduced ? '0s' : '0.12s');
    document.body.focus();
    await userEvent.keyboard('g');
    await waitFor(() => expect(getComputedStyle(bar).opacity).toBe('1'));
    await expect(getComputedStyle(bar).visibility).toBe('visible');
    await userEvent.keyboard('{Escape}');
    await expect(bar).toBeEmptyDOMElement();
  },
};

/** Without a place registered, the line leaves the example off. */
export const GoBarWithoutAnExample: Story = {
  render: () => (
    <Frame>
      <GoBar open />
    </Frame>
  ),
  play: async ({ canvasElement }) => {
    const bar = must(canvasElement.querySelector<HTMLElement>('[data-slot="go-bar"]'));
    await expect(bar).toHaveTextContent('GoG pressed · Select a nav item by its letterEsc');
  },
};
