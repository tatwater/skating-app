import type { Meta, StoryObj } from '@storybook/react-vite';
import type { CSSProperties } from 'react';
import { expect, within } from 'storybook/test';

import { MapPane } from './map-controls';
import { MAP_FOOT_ROOM, MAP_KEY_ORDER, MapKey, type MapKeyKind } from './map-key';
import { computedColor, JUNCTION_TOLERANCE_PX, resolvePx, sameColor } from './measure';
import { faceLoaded, must, settled } from './storyKit';

const meta = {
  title: 'Kit/MapKey',
  component: MapKey,
  tags: ['autodocs'],
  args: { kinds: MAP_KEY_ORDER },
  parameters: {
    docs: {
      description: {
        component:
          'The map key: a slim bar along a map’s foot, each kind the map is drawing right now as its own mark at 12 px and a name. A map lists only what it shows, in the key’s own order. A pane that holds a key makes room for it (`MAP_FOOT_ROOM` sets `--map-foot`), so the credits and plates on the bottom edge rise above it. At phone width the row scrolls rather than wraps; while a mode has the map, the key steps back (`dim`).',
      },
    },
  },
} satisfies Meta<typeof MapKey>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A pane the key docks on: the ground the marks' halo reads (`--map-ground`), and the foot room. */
function Pane({
  kinds,
  dim = false,
  width = '40rem',
}: {
  kinds: readonly MapKeyKind[];
  dim?: boolean;
  width?: string;
}) {
  return (
    <MapPane
      className={MAP_FOOT_ROOM}
      style={
        { width, maxWidth: '100%', height: '7.5rem', '--map-ground': 'var(--bg)' } as CSSProperties
      }
    >
      <MapKey kinds={kinds} dim={dim} />
    </MapPane>
  );
}

const keyIn = (root: HTMLElement) => within(root).getByRole('list', { name: 'Map key' });
const pane = (root: HTMLElement) => must(root.querySelector<HTMLElement>('[data-slot="map-pane"]'));

/** Every kind, in the key's order, each the map's own mark small, on the pane's foot. */
export const EveryKind: Story = {
  render: ({ kinds, dim }) => <Pane kinds={kinds} dim={dim ?? false} />,
  play: async ({ canvasElement }) => {
    const key = keyIn(canvasElement);
    const items = within(key).getAllByRole('listitem');
    await expect(items.map((i) => i.textContent)).toEqual([
      'Put-in',
      'Lot',
      'Hazard',
      'Healing hazard',
      'Ridge crossing',
      'Photo',
      'Track',
      'Your track',
    ]);
    // On the foot, full width, 30 px at the 16 px base.
    const box = key.getBoundingClientRect();
    const frame = pane(canvasElement).getBoundingClientRect();
    await expect(Math.abs(box.bottom - frame.bottom)).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
    await expect(Math.abs(box.width - frame.width)).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
    await expect(box.height).toBeCloseTo(resolvePx(key, '1.875rem'), 2);
    // The pane makes the key's room: `--map-foot` is the key's height while one is drawn.
    await expect(resolvePx(pane(canvasElement), 'var(--map-foot, 0px)')).toBeCloseTo(box.height, 2);
    // Ruled above, on the map plate; the names in the kicker caps.
    const style = getComputedStyle(key);
    await expect(style.borderTopWidth).toBe('1px');
    await expect(style.borderTopColor).toEqual(sameColor(computedColor(key, 'var(--line)')));
    await expect(style.backgroundColor).toEqual(sameColor(computedColor(key, 'var(--map-plate)')));
    await expect(style.textTransform).toBe('uppercase');
    // Each glyph is 12 px tall; a hazard's face takes its tone.
    for (const item of items) {
      await expect(must(item.querySelector('svg')).getBoundingClientRect().height).toBe(12);
    }
    const face = (kind: string) =>
      must(key.querySelector(`[data-key="${kind}"] rect`)) as SVGRectElement;
    await expect(getComputedStyle(face('hazard')).fill).toEqual(
      sameColor(computedColor(key, 'var(--bad)')),
    );
    await expect(getComputedStyle(face('healing')).fill).toEqual(
      sameColor(computedColor(key, 'var(--warn)')),
    );
  },
};

/** Only what the map is drawing, whatever order it hands them in. */
export const OnlyWhatItDraws: Story = {
  args: { kinds: ['photo', 'hazard', 'putIn'] },
  render: ({ kinds }) => <Pane kinds={kinds} />,
  play: async ({ canvasElement }) => {
    const items = within(keyIn(canvasElement)).getAllByRole('listitem');
    await expect(items.map((i) => i.textContent)).toEqual(['Put-in', 'Hazard', 'Photo']);
  },
};

/** A map drawing none of them draws no key, and its foot keeps no room. */
export const Nothing: Story = {
  args: { kinds: [] },
  render: ({ kinds }) => <Pane kinds={kinds} />,
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByRole('list', { name: 'Map key' })).toBeNull();
    await expect(resolvePx(pane(canvasElement), 'var(--map-foot, 0px)')).toBe(0);
  },
};

/** While a mode has the map, the key steps back with the rest of the pane. */
export const Dimmed: Story = {
  args: { kinds: ['putIn', 'hazard', 'track'], dim: true },
  render: ({ kinds, dim }) => <Pane kinds={kinds} dim={dim ?? false} />,
  play: async ({ canvasElement }) => {
    const key = keyIn(canvasElement);
    await settled(key);
    await expect(Number(getComputedStyle(key).opacity)).toBeCloseTo(0.3, 2);
  },
};

/** At phone width the row scrolls rather than wraps: one line, the same height. */
export const Narrow: Story = {
  render: ({ kinds }) => <Pane kinds={kinds} width="18rem" />,
  play: async ({ canvasElement }) => {
    const key = keyIn(canvasElement);
    await expect(key.scrollWidth).toBeGreaterThan(key.clientWidth);
    await expect(key.getBoundingClientRect().height).toBeCloseTo(resolvePx(key, '1.875rem'), 2);
    const tops = within(key)
      .getAllByRole('listitem')
      .map((i) => Math.round(i.getBoundingClientRect().top));
    await expect(new Set(tops).size).toBe(1);
  },
};

// ── Junctions: glyph to name, entry to entry, the bar's inset ───────────────────────────────

async function playJunctions({ canvasElement }: { canvasElement: HTMLElement }) {
  const key = keyIn(canvasElement);
  await faceLoaded(key, 'Put-in');
  const items = within(key).getAllByRole('listitem');
  const inset = resolvePx(key, 'var(--space-3)');
  const toName = resolvePx(key, 'var(--space-1_5)');
  const bar = key.getBoundingClientRect();
  // The first glyph sits the bar's inset in from its left edge.
  const first = must(items[0]?.querySelector('svg')).getBoundingClientRect();
  await expect(Math.abs(first.left - bar.left - inset)).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
  for (const item of items) {
    const glyph = must(item.querySelector('svg')).getBoundingClientRect();
    // Glyph to name: the name's own text box, not the item's.
    const range = document.createRange();
    range.selectNodeContents(must(item.lastChild));
    const name = range.getBoundingClientRect();
    await expect(
      Math.abs(name.left - glyph.right - toName),
      `${item.dataset.key}: glyph → name`,
    ).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
    // Centered on the bar's midline.
    const mid = (r: DOMRect) => r.top + r.height / 2;
    await expect(Math.abs(mid(glyph) - mid(bar))).toBeLessThanOrEqual(0.5);
  }
  for (let i = 1; i < items.length; i++) {
    const gap =
      must(items[i]).getBoundingClientRect().left -
      must(items[i - 1]).getBoundingClientRect().right;
    await expect(Math.abs(gap - inset), 'entry → entry').toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
  }
}

/** The key's spacing on the console. */
export const JunctionAdmin: Story = {
  args: { kinds: ['putIn', 'lot', 'hazard', 'track'] },
  render: ({ kinds }) => <Pane kinds={kinds} />,
  globals: { surface: 'admin' },
  play: playJunctions,
};

/** The same spacing on the skater surface. */
export const JunctionSkater: Story = {
  args: { kinds: ['putIn', 'lot', 'hazard', 'track'] },
  render: ({ kinds }) => <Pane kinds={kinds} />,
  globals: { surface: 'skater' },
  play: playJunctions,
};

// ── Four-up ──────────────────────────────────────────────────────────────────────────────────

/** Every kind in all four maps: each quad's faces and plate in its own theme. */
export const FourUp: Story = {
  render: () => <Pane kinds={MAP_KEY_ORDER} width="100%" />,
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      const key = keyIn(q);
      await expect(getComputedStyle(key).backgroundColor).toEqual(
        sameColor(computedColor(key, 'var(--map-plate)')),
      );
      const put = must(key.querySelector('[data-key="putIn"] rect'));
      await expect(getComputedStyle(put).fill).toEqual(sameColor(computedColor(key, 'var(--acc)')));
    }
  },
};
