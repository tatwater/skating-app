import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';

import { Button } from './button';
import { Kbd } from './kbd';
import { computedColor, JUNCTION_TOLERANCE_PX, resolvePx } from './measure';
import {
  createKeyRegistry,
  type KeyHint,
  KeyRegistryProvider,
  StatusBar,
  StatusLamp,
  StatusText,
  useClaimKey,
  visibleKeyHints,
} from './status-bar';
import { KICKER, must } from './storyKit';

const meta = {
  title: 'Kit/Status bar',
  component: StatusBar,
  tags: ['autodocs'],
  globals: { surface: 'admin' },
  decorators: [(Story) => <div className="w-full min-w-[48rem]">{Story()}</div>],
  parameters: {
    docs: {
      description: {
        component:
          'Admin only. The console’s foot: status groups split by the strong vertical rule; the keys that work here — the focused pane’s first, then the page’s — with any key a visible button already wears left out (buttons claim their keys in the registry); and the lamp, breathing on the 2400 ms lamp timing and still under reduced motion.',
      },
    },
  },
} satisfies Meta<typeof StatusBar>;

export default meta;
type Story = StoryObj<typeof meta>;

const PANE_KEYS: KeyHint[] = [
  { keys: 'Tab', label: 'panels' },
  { keys: '↑↓', label: 'move' },
  { keys: 'A–Z', label: 'type to jump' },
];
const PAGE_KEYS: KeyHint[] = [
  { keys: 'G', label: 'go to' },
  { keys: '?', label: 'keys' },
];
const SEASON_STATUS = [
  <StatusText key="a" tone="warn">
    Winter region-wide · 11 / 25 · needs 13
  </StatusText>,
  <StatusText key="b" tone="warn">
    Weather sweep late
  </StatusText>,
];
const LIVE = <StatusLamp>Convex live</StatusLamp>;

const part = (root: ParentNode, slot: string) =>
  must(root.querySelector<HTMLElement>(`[data-slot="${slot}"]`));
const all = (root: ParentNode, slot: string) => [
  ...root.querySelectorAll<HTMLElement>(`[data-slot="${slot}"]`),
];
const keysShown = (root: ParentNode) =>
  all(root, 'status-key').map((k) => must(k.querySelector('kbd')).textContent);
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The Seasons page: two amber groups split by the rule, the pane and page keys, the live lamp. */
export const Bar: Story = {
  args: { status: SEASON_STATUS, focusKeys: PANE_KEYS, pageKeys: PAGE_KEYS, lamp: LIVE },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const bar = canvas.getByRole('contentinfo');
    await expect(getComputedStyle(bar).textTransform).toBe('uppercase');
    const seps = all(bar, 'status-sep');
    await expect(seps).toHaveLength(1);
    await expect(must(seps[0])).toHaveAttribute('aria-orientation', 'vertical');
    await expect(getComputedStyle(must(seps[0])).backgroundColor).toBe(
      computedColor(bar, 'var(--line2)'),
    );
    // The focused pane's keys lead, then the page's.
    await expect(keysShown(bar)).toEqual(['Tab', '↑↓', 'A–Z', 'G', '?']);
    const list = canvas.getByRole('list', { name: 'Keys' });
    await expect(within(list).getAllByRole('listitem')).toHaveLength(5);
    // Key words keep their case; the caps are recessed.
    const label = part(bar, 'status-key-label');
    await expect(getComputedStyle(label).textTransform).toBe('none');
    await expect(part(bar, 'status-key').querySelector('kbd')).toHaveAttribute(
      'data-variant',
      'dim',
    );
    // Amber by meaning.
    const text = part(bar, 'status-text');
    await expect(getComputedStyle(text).color).toBe(computedColor(bar, 'var(--warn)'));
    await expect(canvas.getByRole('status')).toHaveTextContent('Convex live');
  },
};

/** A button on the page that wears a key claims it; the bar leaves that key out. */
function WithButtons() {
  const [editing, setEditing] = useState(true);
  return (
    <KeyRegistryProvider>
      <div className="flex flex-col gap-(--space-6)">
        <div className="flex items-center gap-(--space-2)">
          {editing && <KeyedButton keys="E">Edit</KeyedButton>}
          <KeyedButton keys="⇧⏎">Return to the queue</KeyedButton>
          <Button variant="bare" onClick={() => setEditing((on) => !on)}>
            {editing ? 'Hide Edit' : 'Show Edit'}
          </Button>
        </div>
        <StatusBar
          pageKeys={[
            { keys: 'E', label: 'edit' },
            { keys: '⇧⏎', label: 'return' },
            { keys: 'Esc', label: 'close' },
          ]}
          lamp={LIVE}
        />
      </div>
    </KeyRegistryProvider>
  );
}

function KeyedButton({ keys, children }: { keys: string; children: string }) {
  useClaimKey(keys);
  return (
    <Button aria-keyshortcuts={keys}>
      {children}
      <Kbd aria-hidden>{keys}</Kbd>
    </Button>
  );
}

export const Registry: Story = {
  render: () => <WithButtons />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const bar = canvas.getByRole('contentinfo');
    // E and ⇧⏎ are on buttons in view: only Esc is left to say.
    await expect(keysShown(bar)).toEqual(['Esc']);
    // The Edit button leaves; its key comes back to the bar.
    await userEvent.click(canvas.getByRole('button', { name: 'Hide Edit' }));
    await expect(keysShown(bar)).toEqual(['E', 'Esc']);
    await userEvent.click(canvas.getByRole('button', { name: 'Show Edit' }));
    await expect(keysShown(bar)).toEqual(['Esc']);
  },
};

/** Keys can also be passed as claimed, for a key worn outside the registry. */
export const ClaimedProp: Story = {
  args: { pageKeys: PAGE_KEYS, claimed: ['g'], lamp: LIVE },
  play: async ({ canvasElement }) => {
    await expect(keysShown(canvasElement)).toEqual(['?']);
  },
};

/** The console never binds number keys or J/K for lists; the bar drops them if they're passed. */
export const ListKeysDropped: Story = {
  args: {
    focusKeys: [
      { keys: '1–9', label: 'lanes' },
      { keys: 'J K', label: 'move' },
      { keys: '↑↓', label: 'move' },
    ],
    pageKeys: [
      { keys: '3', label: 'third lane' },
      { keys: 'J/K', label: 'move' },
      { keys: 'Esc', label: 'close' },
    ],
  },
  play: async ({ canvasElement }) => {
    await expect(keysShown(canvasElement)).toEqual(['↑↓', 'Esc']);
  },
};

/** A key both lists name is the focused pane's: per-pane keys may mean something else there. */
export const FocusWins: Story = {
  args: {
    focusKeys: [{ keys: 'L', label: 'add a lot' }],
    pageKeys: [
      { keys: 'l', label: 'layers' },
      { keys: 'Esc', label: 'close' },
    ],
  },
  play: async ({ canvasElement }) => {
    await expect(keysShown(canvasElement)).toEqual(['L', 'Esc']);
    await expect(part(canvasElement, 'status-key-label')).toHaveTextContent('add a lot');
  },
};

/** The registry's arithmetic: a key held by two buttons stays claimed until both let go. */
export const RegistryCounts: Story = {
  render: () => <p className="text-row text-fg2">The registry, without a bar.</p>,
  play: async () => {
    const registry = createKeyRegistry();
    let changes = 0;
    const stop = registry.subscribe(() => changes++);
    const first = registry.claim('E');
    const second = registry.claim(' e ');
    const before = registry.snapshot();
    await expect([...before]).toEqual(['E']);
    first();
    first(); // letting go twice is letting go once
    await expect(registry.snapshot().has('E')).toBe(true);
    second();
    await expect(registry.snapshot().size).toBe(0);
    // A new set only on a change, so a reader re-renders only then.
    await expect(registry.snapshot()).toBe(registry.snapshot());
    await expect(changes).toBe(4);
    stop();
    registry.claim('X');
    await expect(changes).toBe(4);
    // The pure filter: case and spacing don't make two keys, the first listing wins.
    await expect(
      visibleKeyHints(
        [
          { keys: 'Esc', label: 'close' },
          { keys: 'esc', label: 'again' },
          { keys: '⇧ ⏎', label: 'return' },
        ],
        ['⇧  ⏎'],
      ),
    ).toEqual([{ keys: 'Esc', label: 'close' }]);
  },
};

// ── The lamp ─────────────────────────────────────────────────────────────────────────────────

const LAMPS = [
  { state: 'live', words: 'Convex live' },
  { state: 'idle', words: 'Nothing running' },
  { state: 'warn', words: 'Reconnecting' },
  { state: 'bad', words: 'Offline' },
] as const;

/** Live breathes on the lamp timing (still under reduced motion); idle is dim and still. */
export const Lamps: Story = {
  render: () => (
    <div className="flex flex-col gap-(--space-3) text-kick leading-none font-medium tracking-label uppercase">
      {LAMPS.map((l) => (
        <StatusLamp key={l.state} state={l.state}>
          {l.words}
        </StatusLamp>
      ))}
    </div>
  ),
  decorators: [(Story) => <div>{Story()}</div>],
  play: async ({ canvasElement }) => {
    const led = (state: string) =>
      part(must(canvasElement.querySelector(`[data-state="${state}"]`)), 'status-led');
    const live = getComputedStyle(led('live'));
    await expect(live.backgroundColor).toBe(computedColor(canvasElement, 'var(--fg)'));
    await expect(live.animationName).toBe(reduced() ? 'none' : 'kit-led');
    // The pulse is the lamp token: 2400 ms (zero under reduced motion).
    await expect(live.animationDuration).toBe(reduced() ? '0s' : '2.4s');
    await expect(live.boxShadow).toMatch(/8px/);
    const idle = getComputedStyle(led('idle'));
    await expect(idle.animationName).toBe('none');
    await expect(idle.backgroundColor).toBe(computedColor(canvasElement, 'var(--fg3)'));
    await expect(getComputedStyle(led('warn')).backgroundColor).toBe(
      computedColor(canvasElement, 'var(--warn)'),
    );
    await expect(getComputedStyle(led('bad')).backgroundColor).toBe(
      computedColor(canvasElement, 'var(--bad)'),
    );
    // Square: an LED, not a dot.
    await expect(live.borderRadius).toBe('0px');
  },
};

/** A machinery page leads with the run lamp, not the page's name. */
export const MachineryRun: Story = {
  args: {
    status: [
      <StatusLamp key="run" state="live">
        Running · corpus load
      </StatusLamp>,
      <StatusText key="up">Updated 14:12</StatusText>,
    ],
    pageKeys: PAGE_KEYS,
    lamp: LIVE,
  },
  play: async ({ canvasElement }) => {
    const lamps = within(canvasElement).getAllByRole('status');
    await expect(lamps).toHaveLength(2);
    await expect(lamps[0]).toHaveTextContent('Running · corpus load');
  },
};

// ── Junctions ────────────────────────────────────────────────────────────────────────────────

/**
 * Admin: the bar is 26 px under a hairline; a cap sits 6 px from its words and a hint 12 px from the
 * next; the rule between groups is 1 × 12, 14 px clear of each side; the keys are 16 px from the
 * lamp; the content sits 12 px in from both ends; no cap makes the bar taller.
 */
export const Junction: Story = {
  args: {
    status: [
      <StatusText key="a" tone="warn">
        3 waiting
      </StatusText>,
      <StatusText key="b" tone="bad">
        1 job failed
      </StatusText>,
    ],
    focusKeys: PANE_KEYS,
    pageKeys: PAGE_KEYS,
    lamp: LIVE,
  },
  play: async ({ canvasElement }) => {
    const px = (len: string) => resolvePx(canvasElement, len);
    const near = (a: number, b: number) => Math.abs(a - b) <= JUNCTION_TOLERANCE_PX;
    const bar = part(canvasElement, 'status-bar');
    const box = bar.getBoundingClientRect();
    await expect(box.height).toBeCloseTo(px('var(--size-status)'), 1);
    await expect(box.height).toBeCloseTo(px('1.625rem'), 1);
    await expect(getComputedStyle(bar).borderTopWidth).toBe('1px');
    await expect(getComputedStyle(bar).borderTopColor).toBe(computedColor(bar, 'var(--line)'));

    const keys = all(bar, 'status-key');
    for (const key of keys) {
      const cap = must(key.querySelector('kbd')).getBoundingClientRect();
      const words = part(key, 'status-key-label').getBoundingClientRect();
      await expect(near(words.left - cap.right, px('var(--space-1_5)'))).toBe(true);
      await expect(cap.height).toBeLessThan(box.height);
    }
    for (let i = 1; i < keys.length; i++) {
      const prev = must(keys[i - 1]).getBoundingClientRect();
      const next = must(keys[i]).getBoundingClientRect();
      await expect(near(next.left - prev.right, px('var(--space-3)'))).toBe(true);
    }

    const [a, b] = all(bar, 'status-text').map((t) => t.getBoundingClientRect());
    const sep = part(bar, 'status-sep').getBoundingClientRect();
    await expect(sep.width).toBe(1);
    await expect(sep.height).toBeCloseTo(px('var(--space-3)'), 1);
    await expect(near(sep.left - must(a).right, px('var(--space-3_5)'))).toBe(true);
    await expect(near(must(b).left - sep.right, px('var(--space-3_5)'))).toBe(true);
    // Centered on the bar's type line, below the hairline.
    const inner = box.top + 1 + (box.height - 1) / 2;
    await expect(Math.abs((sep.top + sep.bottom) / 2 - inner)).toBeLessThanOrEqual(0.5);

    const lamp = part(bar, 'status-lamp').getBoundingClientRect();
    const lastKey = must(keys.at(-1)).getBoundingClientRect();
    await expect(near(lamp.left - lastKey.right, px('var(--space-4)'))).toBe(true);
    await expect(near(box.right - lamp.right, px('var(--space-3)'))).toBe(true);
    await expect(near(must(a).left - box.left, px('var(--space-3)'))).toBe(true);
    const led = part(bar, 'status-led').getBoundingClientRect();
    await expect(led.width).toBeCloseTo(px('var(--space-1_5)'), 1);
  },
};

// ── Four-up ──────────────────────────────────────────────────────────────────────────────────

/** The bar and every lamp in all four maps. Admin only: the skater quads show the same parts. */
export const FourUp: Story = {
  decorators: [(Story) => <div>{Story()}</div>],
  render: () => (
    <div className="flex flex-col gap-heading">
      <span className={KICKER}>Bar</span>
      <StatusBar status={SEASON_STATUS} focusKeys={PANE_KEYS} pageKeys={PAGE_KEYS} lamp={LIVE} />
      <span className={KICKER}>Lamps</span>
      <div className="flex flex-wrap gap-(--space-5_5) text-kick leading-none font-medium tracking-label uppercase">
        {LAMPS.map((l) => (
          <StatusLamp key={l.state} state={l.state}>
            {l.words}
          </StatusLamp>
        ))}
      </div>
    </div>
  ),
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      await expect(part(q, 'status-bar').getBoundingClientRect().height).toBeCloseTo(
        resolvePx(q, 'var(--size-status)'),
        1,
      );
    }
  },
};
