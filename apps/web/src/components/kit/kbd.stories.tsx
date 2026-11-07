import * as tokens from '@skating/design/tokens';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { Button } from './button';
import { Kbd, KbdGroup } from './kbd';
import { computedColor, JUNCTION_TOLERANCE_PX, resolvePx, sameColor } from './measure';
import { KICKER, must, rootPx, StateMatrix } from './storyKit';

const meta = {
  title: 'Kit/Kbd',
  component: Kbd,
  tags: ['autodocs'],
  args: { children: 'P' },
  argTypes: {
    variant: { control: 'inline-radio', options: ['lit', 'dim', 'go'] },
    disabled: { control: 'boolean' },
  },
} satisfies Meta<typeof Kbd>;

export default meta;
type Story = StoryObj<typeof meta>;

const kbd = (canvasElement: HTMLElement) =>
  must(canvasElement.querySelector<HTMLElement>('[data-slot="kbd"]'));

/** The light cap a button or the status bar wears: mono caps, rounded like a key. */
export const Lit: Story = {
  play: async ({ canvasElement, globals }) => {
    const el = kbd(canvasElement);
    const style = getComputedStyle(el);
    await expect(el.tagName).toBe('KBD');
    await expect(style.borderRadius).toBe(`${tokens.radius.key.value}px`);
    await expect(style.textTransform).toBe('uppercase');
    await expect(style.fontFamily).toMatch(/Martian Mono/);
    const surface = globals.surface as tokens.Surface;
    await expect(el.getBoundingClientRect().height).toBeCloseTo(
      tokens.size[surface].key.value * rootPx(),
      1,
    );
  },
};

/** The recessed cap. */
export const Dim: Story = { args: { variant: 'dim', children: '⇧⏎' } };

/** Go-mode: G already pressed (grayed), the finishing letter lit, on ice. */
export const Go: Story = {
  args: { variant: 'go', spent: 'G', children: 'I' },
  play: async ({ canvasElement }) => {
    const el = kbd(canvasElement);
    await expect(el).toHaveTextContent('GI');
    await expect(getComputedStyle(el).backgroundColor).toEqual(
      sameColor(computedColor(el, 'var(--acc)')),
    );
    const spent = must(el.querySelector<HTMLElement>('[data-slot="kbd-spent"]'));
    await expect(Number(getComputedStyle(spent).opacity)).toBeLessThan(1);
  },
};

/** `spent` belongs to go-mode only; on any other cap it is ignored. */
export const SpentOnlyInGo: Story = {
  args: { variant: 'lit', spent: 'G', children: 'I' },
  play: async ({ canvasElement }) => {
    await expect(kbd(canvasElement)).toHaveTextContent(/^I$/);
  },
};

/** A key nothing listens for (a layer with nothing to draw): kept, faded, a hairline, no fill. */
export const Disabled: Story = {
  args: { disabled: true, children: 'B' },
  play: async ({ canvasElement }) => {
    const el = kbd(canvasElement);
    await expect(el).toHaveAttribute('data-disabled');
    await expect(getComputedStyle(el).backgroundColor).toEqual(sameColor('rgba(0, 0, 0, 0)'));
    await expect(getComputedStyle(el).color).toEqual(
      sameColor(computedColor(el, 'var(--fg-disabled)')),
    );
  },
};

/** Keys pressed together or in turn: separate caps, a hair apart. */
export const Group: Story = {
  render: () => (
    <KbdGroup>
      <Kbd>⌘</Kbd>
      <Kbd>K</Kbd>
    </KbdGroup>
  ),
  play: async ({ canvasElement }) => {
    const [a, b] = [...canvasElement.querySelectorAll('[data-slot="kbd"]')];
    const gap = must(b).getBoundingClientRect().left - must(a).getBoundingClientRect().right;
    const expected = resolvePx(canvasElement, 'var(--space-0_5)');
    await expect(Math.abs(gap - expected)).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
  },
};

// ── Matrix and four-up ────────────────────────────────────────────────────────────────────────

const ROWS = [
  { key: 'lit', label: 'Lit' },
  { key: 'dim', label: 'Dim' },
  { key: 'go', label: 'Go' },
] as const;
const STATES = [
  { key: 'rest', label: 'Rest' },
  { key: 'disabled', label: 'Disabled' },
] as const;

/** Every look, live and inert. A key is never hovered or focused itself — its control is. */
export const States: Story = {
  render: () => (
    <StateMatrix
      rows={ROWS}
      states={STATES}
      cell={(variant, state) => (
        <KbdGroup>
          <Kbd variant={variant} disabled={state === 'disabled'} spent="G">
            A
          </Kbd>
          <Kbd variant={variant} disabled={state === 'disabled'}>
            ⇧⏎
          </Kbd>
        </KbdGroup>
      )}
    />
  ),
  play: async ({ canvasElement }) => {
    const disabled = canvasElement.querySelectorAll('[data-slot="kbd"][data-disabled]');
    await expect(disabled).toHaveLength(6);
  },
};

export const FourUp: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-(--space-3)">
      <Kbd>P</Kbd>
      <Kbd variant="dim">⇧⏎</Kbd>
      <Kbd variant="go" spent="G">
        I
      </Kbd>
      <Kbd disabled>B</Kbd>
      <Button size="sm">
        Promote <Kbd aria-hidden>P</Kbd>
      </Button>
    </div>
  ),
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    // Each quad's caps take its surface's key height: the console's are shorter.
    for (const q of quads) {
      const surface = q.dataset.surface as tokens.Surface;
      const cap = must(q.querySelector('[data-slot="kbd"]'));
      await expect(cap.getBoundingClientRect().height).toBeCloseTo(
        tokens.size[surface].key.value * rootPx(),
        1,
      );
    }
  },
};

// ── Junctions: a key never makes its button taller (and sits centered in it) ──────────────────

function KeyedButtons() {
  return (
    <div className="flex flex-col gap-heading">
      {(['default', 'sm', 'xs'] as const).map((size) => (
        <div key={size} data-junction={size} className="flex items-center gap-(--space-2)">
          <Button size={size}>Promote</Button>
          <Button size={size} aria-keyshortcuts="P">
            Promote <Kbd aria-hidden>P</Kbd>
          </Button>
          <Button size={size} variant="primary" aria-keyshortcuts="Enter">
            Approve <Kbd aria-hidden>⏎</Kbd>
          </Button>
        </div>
      ))}
      <p className={KICKER}>Keys sit inside every button height without growing it</p>
    </div>
  );
}

async function playKeyedButtons({ canvasElement }: { canvasElement: HTMLElement }) {
  for (const size of ['default', 'sm', 'xs']) {
    const row = must(canvasElement.querySelector(`[data-junction="${size}"]`));
    const [plain, ...keyed] = [...row.querySelectorAll<HTMLElement>('[data-slot="button"]')];
    const height = must(plain).getBoundingClientRect().height;
    for (const button of keyed) {
      const box = button.getBoundingClientRect();
      await expect(Math.abs(box.height - height)).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
      // Centered: the cap's air above equals its air below.
      const cap = must(button.querySelector('[data-slot="kbd"]')).getBoundingClientRect();
      await expect(Math.abs(cap.top - box.top - (box.bottom - cap.bottom))).toBeLessThanOrEqual(1);
    }
  }
  // The key is decoration; the button's name stays its label.
  await expect(
    within(canvasElement).getAllByRole('button', { name: 'Promote' }).length,
  ).toBeGreaterThan(1);
}

export const JunctionKeyInButtonAdmin: Story = {
  render: () => <KeyedButtons />,
  globals: { surface: 'admin' },
  play: playKeyedButtons,
};

export const JunctionKeyInButtonSkater: Story = {
  render: () => <KeyedButtons />,
  globals: { surface: 'skater' },
  play: playKeyedButtons,
};
