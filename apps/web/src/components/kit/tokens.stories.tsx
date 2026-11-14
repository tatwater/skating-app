import * as tokens from '@skating/design/tokens';
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactNode } from 'react';
import { expect } from 'storybook/test';

import { KICKER, must, rootPx } from './storyKit';

/**
 * The token library: every token in the registry, once, drawn in the theme the toolbar picks — a
 * length as a bar that long, a color as a swatch, a type step as a line of type — beside its CSS
 * variable and its value in this map. Read off the registry, so a token added in
 * `@skating/design` lands here without an edit; the story test holds every bar to its value.
 */
const meta = {
  title: 'Kit/Tokens',
  tags: ['autodocs'],
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const GROUP_ORDER = [
  'color',
  'font-size',
  'letter-spacing',
  'line-height',
  'font-weight',
  'font-family',
  'space',
  'gap',
  'size',
  'border-width',
  'radius',
  'opacity',
  'shadow',
  'z-index',
  'duration',
  'easing',
  'breakpoint',
];

/** Lengths drawn as bars: the ones that measure along a line. */
const BARRED = new Set(['space', 'gap', 'size', 'border-width', 'breakpoint']);

function describe(value: tokens.TokenValue): string {
  switch (value.kind) {
    case 'color':
      return `oklch(${value.color.l} ${value.color.c} ${value.color.h})`;
    case 'length':
      return tokens.toCssLength(value.length);
    case 'number':
      return String(value.number);
    case 'fontFamily':
      return value.families.join(', ');
    case 'shadow':
      return `${value.layers.length} layer${value.layers.length === 1 ? '' : 's'}`;
    case 'duration':
      return `${value.ms} ms`;
    case 'easing':
      return `cubic-bezier(${value.bezier.join(', ')})`;
  }
}

function Sample({ entry, value }: { entry: tokens.TokenEntry; value: tokens.TokenValue }) {
  const v = `var(${entry.cssVar})`;
  if (value.kind === 'color')
    return (
      <span
        data-sample="swatch"
        className="block size-(--space-6) border border-solid border-line"
        style={{ background: v }}
      />
    );
  if (BARRED.has(entry.group))
    return (
      <span
        data-sample="bar"
        className="block h-(--space-1) max-w-full bg-fg2"
        style={{ width: entry.group === 'border-width' ? `calc(${v} * 8)` : v }}
      />
    );
  if (entry.group === 'font-size')
    return (
      <span data-sample="type" style={{ fontSize: v }} className="leading-none text-fg">
        Mascoma Lake 2026–27
      </span>
    );
  if (entry.group === 'letter-spacing')
    return (
      <span style={{ letterSpacing: v }} className="text-kick text-fg uppercase">
        Keeping up
      </span>
    );
  if (entry.group === 'radius')
    return (
      <span
        className="block size-(--space-6) border border-solid border-fg2"
        style={{ borderRadius: v }}
      />
    );
  if (entry.group === 'opacity')
    return <span className="block size-(--space-6) bg-fg" style={{ opacity: v }} />;
  if (entry.group === 'shadow')
    return <span className="block size-(--space-6) bg-panel" style={{ boxShadow: v }} />;
  return null;
}

function Catalog() {
  const map = tokens.themeMaps[tokens.DEFAULT_SURFACE][tokens.DEFAULT_MODE];
  const groups = new Map<string, tokens.TokenEntry[]>();
  for (const entry of tokens.registry) {
    groups.set(entry.group, [...(groups.get(entry.group) ?? []), entry]);
  }
  const ordered = [
    ...GROUP_ORDER.filter((g) => groups.has(g)),
    ...[...groups.keys()].filter((g) => !GROUP_ORDER.includes(g)),
  ];
  return (
    <div className="flex flex-col gap-(--space-8) p-gutter">
      {ordered.map((group) => (
        <section key={group} className="flex flex-col gap-heading">
          <h2 className={KICKER}>{group}</h2>
          <table className="w-full border-collapse text-left">
            <tbody>
              {(groups.get(group) ?? []).map((entry) => (
                <Row key={entry.name} entry={entry} fallback={entry.value(map)} />
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}

/** One token: its name, its variable, this map's value and its drawing. */
function Row({ entry, fallback }: { entry: tokens.TokenEntry; fallback: tokens.TokenValue }) {
  return (
    <tr
      data-token={entry.name}
      data-varies={entry.varies}
      className="border-0 border-b border-dotted border-line"
    >
      <td className="w-[14rem] py-(--space-1_5) pe-(--space-3) font-(family-name:--family-mono) text-mono-sm text-fg">
        {entry.name}
      </td>
      <td className="w-[12rem] py-(--space-1_5) pe-(--space-3) font-(family-name:--family-mono) text-mono-sm text-fg3">
        {entry.cssVar}
      </td>
      <td className="w-[16rem] py-(--space-1_5) pe-(--space-3) text-assist text-fg2">
        <ThemedValue entry={entry} fallback={fallback} />
      </td>
      <td className="py-(--space-1_5)">
        <Sample entry={entry} value={fallback} />
      </td>
    </tr>
  );
}

/** The value in the map the toolbar picked, read from the root at render. */
function ThemedValue({
  entry,
  fallback,
}: {
  entry: tokens.TokenEntry;
  fallback: tokens.TokenValue;
}): ReactNode {
  const root = typeof document === 'undefined' ? null : document.documentElement;
  const surface = root?.getAttribute('data-surface') as tokens.Surface | null;
  const mode = root?.getAttribute('data-mode') as tokens.Mode | null;
  const map =
    surface && mode && tokens.themeMaps[surface]?.[mode] ? tokens.themeMaps[surface][mode] : null;
  return describe(map ? entry.value(map) : fallback);
}

/** Every token, in the toolbar's map. Each bar is exactly its token's length. */
export const Catalog_: Story = {
  name: 'Catalog',
  render: () => <Catalog />,
  play: async ({ canvasElement, globals }) => {
    const surface = globals.surface as tokens.Surface;
    const mode = globals.mode as tokens.Mode;
    const map = tokens.themeMaps[surface][mode];
    const rows = [...canvasElement.querySelectorAll<HTMLElement>('tr[data-token]')];
    // Every registry token has its row, once.
    await expect(new Set(rows.map((r) => r.dataset.token))).toEqual(
      new Set(tokens.registry.map((e) => e.name)),
    );
    await expect(rows).toHaveLength(tokens.registry.length);
    const base = rootPx();
    for (const entry of tokens.registry) {
      if (!BARRED.has(entry.group) || entry.group === 'border-width') continue;
      const value = entry.value(map);
      if (value.kind !== 'length' || value.length.unit !== 'rem') continue;
      const bar = canvasElement.querySelector<HTMLElement>(
        `tr[data-token="${entry.name}"] [data-sample="bar"]`,
      );
      // A bar wider than the page is capped; measure the ones that fit.
      const want = value.length.value * base;
      if (bar === null || want > must(bar.parentElement).clientWidth) continue;
      await expect(bar.getBoundingClientRect().width, entry.name).toBeCloseTo(want, 1);
    }
  },
};
