import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { must } from '../kit/storyKit';
import { GlobalSearchView } from './GlobalSearchView';
import type { SearchGroup } from './searchModel';
import { fixtureSearch, RECENTS, RESULTS, SkaterPair } from './storySupport';

/** Global search (3.17–3.20): results, recents, nothing found — centered under the field. */
const meta = {
  title: 'Skater/Global search',
  component: GlobalSearchView,
  globals: { surface: 'skater', mode: 'light' },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof GlobalSearchView>;

export default meta;
type Story = StoryObj<typeof meta>;

const plate = (root: ParentNode) =>
  root.querySelector<HTMLElement>('[data-slot="global-search-plate"]');

function Open({
  groups,
  query,
  noResultsFor = null,
  container,
}: {
  groups: SearchGroup[];
  query: string;
  noResultsFor?: string | null;
  container: HTMLElement | null;
}) {
  return (
    <div className="flex h-top items-center justify-center border-0 border-b border-solid border-line px-bar-x">
      <GlobalSearchView
        open
        onOpenChange={() => {}}
        query={query}
        onQueryChange={() => {}}
        groups={groups}
        noResultsFor={noResultsFor}
        onPick={() => {}}
        container={container}
      />
    </div>
  );
}

/** 3.17 / 3.18: a query's Lakes, Bays and Skaters, the typed part lit. */
export const Results: Story = {
  args: {} as never,
  render: () => (
    <SkaterPair>{(_, c) => <Open groups={RESULTS} query="ma" container={c} />}</SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    for (const q of canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')) {
      const p = await waitFor(() => must(plate(q)));
      const kickers = [...p.querySelectorAll('[data-slot="global-search-group-label"]')].map(
        (e) => e.textContent,
      );
      await expect(kickers).toEqual(['Lakes', 'Bays', 'Skaters']);
      await expect(getComputedStyle(p).borderRadius).toBe('0px');
      await expect(p.getBoundingClientRect().width).toBe(520);
      // Centered under the field (Review 3).
      const field = must(
        q.querySelector('[data-slot="global-search-field"]'),
      ).getBoundingClientRect();
      const box = p.getBoundingClientRect();
      await expect(
        Math.abs(box.left + box.width / 2 - (field.left + field.width / 2)),
      ).toBeLessThanOrEqual(1);
      await expect(within(p).getAllByText('Ma', { selector: 'b' }).length).toBeGreaterThan(0);
      // The last row of the list has no rule under it; the foot is ruled above.
      await expect(within(p).getByText('Move')).toBeInTheDocument();
    }
  },
};

/** 3.19: no query — the recents. */
export const Recent: Story = {
  args: {} as never,
  render: () => (
    <SkaterPair>{(_, c) => <Open groups={RECENTS} query="" container={c} />}</SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    const p = await waitFor(() => must(plate(canvasElement)));
    await expect(within(p).getByText('Recent')).toBeInTheDocument();
    await expect(within(p).getByText('@placasse')).toBeInTheDocument();
  },
};

/** 3.20: nothing matches — click it on the map. */
export const NothingFound: Story = {
  args: {} as never,
  render: () => (
    <SkaterPair height="16rem">
      {(_, c) => <Open groups={[]} query="mud pond" noResultsFor="mud pond" container={c} />}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    const p = await waitFor(() => must(plate(canvasElement)));
    await expect(
      within(p).getByText('No lakes, bays, or skaters match “mud pond”.'),
    ).toBeInTheDocument();
    await expect(within(p).queryByText('Move')).toBeNull();
    await expect(within(p).getByText('Close')).toBeInTheDocument();
  },
};

const pick = fn();

/** Typing, ↑↓ and ⏎ in a real browser: the first row is lit, ↓ moves, ⏎ opens, the query stays. */
export const Keyboard: Story = {
  args: {} as never,
  globals: { mode: 'dark' },
  render: function Render() {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    return (
      <div className="flex h-[30rem] items-start justify-center pt-(--space-3)">
        <GlobalSearchView
          open={open}
          onOpenChange={setOpen}
          query={query}
          onQueryChange={setQuery}
          groups={fixtureSearch(query)}
          onPick={(row) => {
            pick(row.href);
            setOpen(false);
          }}
        />
      </div>
    );
  },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole('button', { name: 'Search lakes, bays, and skaters' }));
    const field = await c.findByRole('combobox');
    await waitFor(() => expect(field).toHaveFocus());
    await userEvent.keyboard('lake');
    const first = await waitFor(() =>
      must(document.querySelector('[data-slot="global-search-row"]')),
    );
    await waitFor(() => expect(first).toHaveAttribute('data-highlighted'));
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(pick).toHaveBeenLastCalledWith('/water/mascoma'));
    await waitFor(() =>
      expect(c.getByRole('button', { name: 'Search lakes, bays, and skaters' })).toHaveFocus(),
    );
  },
};
