import type { Meta, StoryObj } from '@storybook/react-vite';
import type { CSSProperties, ReactNode } from 'react';
import { expect } from 'storybook/test';
import { expectControlsInside } from '@/components/kit/storyKit';
import AccessStories, { Board as AccessBoard } from './access/AccessView.stories';
import HazardsStories, { Default as HazardsDefault } from './hazards/HazardsTab.stories';
import LinksStories, { Default as LinksDefault } from './links/LinksTab.stories';
import NamesStories, { Board as NamesBoard } from './names/NamesView.stories';
import PlacesStories, { Board as PlacesBoard } from './places/PlacesView.stories';
import StandingStories, { Default as StandingDefault } from './standing/StandingTab.stories';
import WaterStories, { Board as WaterBoard } from './water/WaterView.stories';

/**
 * **Every tab at a phone's width** (B01-3o): the Body console's narrow page gives the tab the whole
 * page, 360 px less its gutters, where the boards draw it at the inspector's 380. Each tab's own
 * board, drawn with the inspector's width set to a phone's: no part of it scrolls sideways, and
 * every control in it lies inside its column. (Imagery's board is the dock and the map, at the map's
 * width; the map pane's phone check is the console's own story.)
 */

/** A phone's page: what the narrow console gives the inspector. */
const PHONE = '22.5rem';

/**
 * The tab's board, its column the phone's width: the token and the utility that reads it, set here
 * and inside any theme scope the board draws (a scope declares the surface's tokens afresh).
 */
function AtPhoneWidth({ children }: { children: ReactNode }) {
  const phone = `--size-inspector: ${PHONE}; --spacing-inspector: ${PHONE};`;
  return (
    <div
      data-slot="phone-width"
      style={{ '--size-inspector': PHONE, '--spacing-inspector': PHONE } as CSSProperties}
    >
      <style>{`[data-slot="phone-width"] [data-theme-scope], [data-slot="phone-width"] [data-theme-scope] * { ${phone} }`}</style>
      {children}
    </div>
  );
}

type Board = {
  meta: { args?: object; render?: (args: never, context: never) => ReactNode };
  story: { args?: object };
};
const BOARDS: Record<string, Board> = {
  Names: { meta: NamesStories, story: NamesBoard },
  Places: { meta: PlacesStories, story: PlacesBoard },
  Access: { meta: AccessStories, story: AccessBoard },
  Water: { meta: WaterStories, story: WaterBoard },
  Hazards: { meta: HazardsStories, story: HazardsDefault },
  Standing: { meta: StandingStories, story: StandingDefault },
  Links: { meta: LinksStories, story: LinksDefault },
};

function Tab({ name }: { name: string }) {
  const { meta, story } = BOARDS[name] as Board;
  const args = { ...meta.args, ...story.args } as never;
  return <AtPhoneWidth>{meta.render?.(args, {} as never)}</AtPhoneWidth>;
}

const meta = {
  title: 'Admin/Body/Phone width',
  component: Tab,
  globals: { surface: 'admin', mode: 'dark' },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Tab>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Each column the tab is drawn in: the inspector-width frames inside the board. */
function columns(root: HTMLElement): HTMLElement[] {
  // `PHONE` is in rem: the root's font size, not the wrapper's (a surface may set its own).
  const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const target = Number.parseFloat(PHONE) * rem;
  return [...root.querySelectorAll<HTMLElement>('div')].filter((el) => {
    const w = el.getBoundingClientRect().width;
    return Math.abs(w - target) < 1 && el.parentElement?.getBoundingClientRect().width !== w;
  });
}

const play: Story['play'] = async ({ canvasElement }) => {
  const found = columns(canvasElement);
  await expect(found.length).toBeGreaterThan(0);
  for (const column of found) {
    await expect(column.scrollWidth, 'the column').toBeLessThanOrEqual(column.clientWidth + 1);
    await expectControlsInside(column, column);
  }
};

export const Names: Story = { args: { name: 'Names' }, play };
export const Places: Story = { args: { name: 'Places' }, play };
export const Access: Story = { args: { name: 'Access' }, play };
export const Water: Story = { args: { name: 'Water' }, play };
export const Hazards: Story = { args: { name: 'Hazards' }, play };
export const Standing: Story = { args: { name: 'Standing' }, play };
export const Links: Story = { args: { name: 'Links' }, play };
