import { Autocomplete } from '@base-ui/react/autocomplete';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { JUNCTION_TOLERANCE_PX, resolvePx } from './measure';
import {
  FootKey,
  SearchGroupLabel,
  type SearchGroupLabelProps,
  SearchStatus,
} from './search-parts';
import { faceLoaded, KICKER, must } from './storyKit';

const meta = {
  title: 'Kit/SearchParts',
  component: SearchGroupLabel,
  tags: ['autodocs'],
  args: { children: 'Lakes' },
  parameters: {
    docs: {
      description: {
        component:
          'What a grouped search list shares on both surfaces — the search plate and the command palette — and nothing more: the rows are each list’s own. **FootKey** is a foot’s hint, one dim cap per key, then the words. **SearchGroupLabel** is a group’s kicker in two looks — `plate` (a 30 px row, medium) and `palette` (padded, semibold) — either ending in a count and a hairline to the edge. **SearchStatus** stands where the rows would be: the spinner while a search with nothing yet is in flight, else what the caller says about an empty result.',
      },
    },
  },
} satisfies Meta<typeof SearchGroupLabel>;

export default meta;
type Story = StoryObj<typeof meta>;

type Row = { id: string; name: string };
type Group = { id: string; label: string; items: Row[] } & Pick<
  SearchGroupLabelProps,
  'look' | 'count' | 'rule'
>;

const GROUPS: Group[] = [
  { id: 'plate', label: 'Lakes', look: 'plate', items: [{ id: 'm', name: 'Mascoma Lake' }] },
  {
    id: 'plate-count',
    label: 'Bays',
    look: 'plate',
    count: 12,
    items: [{ id: 'n', name: 'Mascoma North' }],
  },
  {
    id: 'palette',
    label: 'Bodies',
    look: 'palette',
    count: 31,
    rule: true,
    items: [{ id: 'p', name: 'Post Pond' }],
  },
  { id: 'palette-bare', label: 'Modes', look: 'palette', items: [{ id: 'b', name: 'Bay mode' }] },
];

/** An always-open list, as the palette draws one: each group under its label. */
function Groups({ groups = GROUPS }: { groups?: Group[] }) {
  return (
    <div className="w-full max-w-[26rem] border border-solid border-line2 bg-panel">
      <Autocomplete.Root inline open mode="none" items={groups}>
        <Autocomplete.List className="outline-none">
          {(group: Group) => (
            <Autocomplete.Group key={group.id} items={group.items} data-group={group.id}>
              <SearchGroupLabel
                {...(group.look ? { look: group.look } : {})}
                {...(group.count !== undefined ? { count: group.count } : {})}
                {...(group.rule ? { rule: true } : {})}
              >
                {group.label}
              </SearchGroupLabel>
              <Autocomplete.Collection>
                {(row: Row) => (
                  <Autocomplete.Item
                    key={row.id}
                    value={row}
                    className="flex h-td items-center px-gutter text-row text-fg1"
                  >
                    {row.name}
                  </Autocomplete.Item>
                )}
              </Autocomplete.Collection>
            </Autocomplete.Group>
          )}
        </Autocomplete.List>
      </Autocomplete.Root>
    </div>
  );
}

const label = (root: ParentNode, group: string) =>
  must(root.querySelector<HTMLElement>(`[data-group="${group}"] [data-slot="search-group-label"]`));
const kicker = (el: HTMLElement) => must(el.firstElementChild as HTMLElement | null);

/** Both looks, with and without a count and a rule. */
export const GroupLabels: Story = {
  render: () => <Groups />,
  play: async ({ canvasElement }) => {
    const texts = GROUPS.map((g) => label(canvasElement, g.id).textContent);
    await expect(texts).toEqual(['Lakes', 'Bays · 12', 'Bodies · 31', 'Modes']);
    for (const g of GROUPS) {
      const k = getComputedStyle(kicker(label(canvasElement, g.id)));
      await expect(k.textTransform).toBe('uppercase');
      await expect(k.fontWeight).toBe(g.look === 'palette' ? '600' : '500');
    }
    // The plate's row is 30 px at the 16 px base.
    const plate = label(canvasElement, 'plate');
    await expect(plate.getBoundingClientRect().height).toBeCloseTo(resolvePx(plate, '1.875rem'), 2);
    // Only a ruled label draws the hairline, and a reader never meets it.
    const ruled = label(canvasElement, 'palette');
    const rule = must(ruled.lastElementChild as HTMLElement | null);
    await expect(rule).toHaveAttribute('aria-hidden', 'true');
    await expect(rule.getBoundingClientRect().height).toBe(1);
    await expect(label(canvasElement, 'palette-bare').children).toHaveLength(1);
    // The group is named by its label.
    await expect(within(canvasElement).getAllByRole('group')).toHaveLength(GROUPS.length);
  },
};

/** Kicker to rule, and the rule to the row's padded end; each look's inset from the edge. */
export const GroupLabelJunctions: Story = {
  render: () => <Groups />,
  play: async ({ canvasElement }) => {
    const ruled = label(canvasElement, 'palette');
    await faceLoaded(kicker(ruled), 'BODIES');
    const k = kicker(ruled).getBoundingClientRect();
    const rule = must(ruled.lastElementChild).getBoundingClientRect();
    const row = ruled.getBoundingClientRect();
    await expect(
      Math.abs(rule.left - k.right - resolvePx(ruled, 'var(--space-2_5)')),
    ).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
    await expect(
      Math.abs(row.right - rule.right - resolvePx(ruled, 'var(--gap-gutter)')),
    ).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
    await expect(
      Math.abs(k.left - row.left - resolvePx(ruled, 'var(--gap-gutter)')),
    ).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
    const plate = label(canvasElement, 'plate');
    await expect(
      Math.abs(
        kicker(plate).getBoundingClientRect().left -
          plate.getBoundingClientRect().left -
          resolvePx(plate, 'var(--space-4)'),
      ),
    ).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
  },
};

/** A foot's hints: one cap per key, the words after, in the caller's case. */
function Foot() {
  return (
    <div className="flex flex-col gap-(--space-4)">
      <div
        data-foot="plate"
        className="flex items-center gap-(--space-4_5) text-assist leading-none text-fg3"
      >
        <FootKey keys={['↑', '↓']}>Move</FootKey>
        <FootKey keys={['↵']}>Open</FootKey>
        <FootKey keys={['Esc']}>Close</FootKey>
      </div>
      <div
        data-foot="palette"
        className="flex items-center gap-(--space-4) text-assist leading-none text-fg3"
      >
        <FootKey keys={['↑↓']}>move</FootKey>
        <FootKey keys={['⏎']}>open</FootKey>
        <FootKey keys={['⇥']}>actions</FootKey>
        <FootKey keys={['Esc']}>close</FootKey>
      </div>
    </div>
  );
}

const hints = (root: ParentNode, foot: string) => [
  ...root.querySelectorAll<HTMLElement>(`[data-foot="${foot}"] [data-slot="foot-key"]`),
];

/** The caps are decoration — the words carry the meaning — and each sits `space-1_5` from the next. */
export const FootKeys: Story = {
  render: () => <Foot />,
  play: async ({ canvasElement }) => {
    const plate = hints(canvasElement, 'plate');
    await expect(plate.map((h) => h.querySelectorAll('[data-slot="kbd"]').length)).toEqual([
      2, 1, 1,
    ]);
    await expect(plate.map((h) => h.textContent)).toEqual(['↑↓Move', '↵Open', 'EscClose']);
    await expect(hints(canvasElement, 'palette').map((h) => h.textContent)).toEqual([
      '↑↓move',
      '⏎open',
      '⇥actions',
      'Escclose',
    ]);
    for (const cap of canvasElement.querySelectorAll('[data-slot="kbd"]')) {
      await expect(cap).toHaveAttribute('aria-hidden', 'true');
      await expect(cap).toHaveAttribute('data-variant', 'dim');
    }
    // Cap to cap, and the last cap to the words.
    const first = must(plate[0]);
    await faceLoaded(first, 'Move');
    const gap = resolvePx(first, 'var(--space-1_5)');
    const [up, down] = [...first.querySelectorAll('[data-slot="kbd"]')].map((c) =>
      c.getBoundingClientRect(),
    );
    await expect(Math.abs(must(down).left - must(up).right - gap)).toBeLessThanOrEqual(
      JUNCTION_TOLERANCE_PX,
    );
    const range = document.createRange();
    range.selectNodeContents(must(first.lastChild));
    await expect(
      Math.abs(range.getBoundingClientRect().left - must(down).right - gap),
    ).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
  },
};

/** In place of rows: the spinner while a search with nothing yet runs, else the caller's note. */
function Statuses() {
  return (
    <div className="flex w-full max-w-[26rem] flex-col gap-(--space-4)">
      <span className={KICKER}>Searching</span>
      <SearchStatus loading data-case="loading" className="h-12 border border-dashed border-line">
        Never shown while loading
      </SearchStatus>
      <span className={KICKER}>Nothing matches</span>
      <SearchStatus data-case="empty" className="h-12 border border-dashed border-line text-row">
        Nothing matches
      </SearchStatus>
    </div>
  );
}

/** Both statuses are live regions, and each holds the box the caller gave it. */
export const Status: Story = {
  render: () => <Statuses />,
  play: async ({ canvasElement }) => {
    const [loading, empty] = within(canvasElement).getAllByRole('status');
    await expect(loading).toHaveTextContent(/^Searching$/);
    await expect(must(loading).querySelector('svg')).not.toBeNull();
    await expect(empty).toHaveTextContent(/^Nothing matches$/);
    for (const s of [loading, empty]) {
      await expect(must(s).getBoundingClientRect().height).toBeCloseTo(
        resolvePx(must(s), '3rem'),
        2,
      );
    }
  },
};

/** Every part, in all four maps. */
export const FourUp: Story = {
  render: () => (
    <div className="flex flex-col gap-(--space-6)">
      <Groups />
      <Foot />
      <Statuses />
    </div>
  ),
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      await expect(label(q, 'palette')).toHaveTextContent('Bodies · 31');
      await expect(hints(q, 'plate')).toHaveLength(3);
    }
  },
};
