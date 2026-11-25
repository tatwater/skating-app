import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { must } from '@/components/kit/storyKit';
import type { DecidedState } from '../../../inspector/InspectorFrame';
import { BASIN_MAP, pair, quads, STORY_ZONE, StillMap, StoryPane } from '../CorpusInspectorStory';
import { NAMES_MAP_SIZE, NamesInspector } from './NamesInspector';
import {
  BASIN,
  BASIN_ASKED_AGAIN,
  BASIN_DECIDED,
  BASIN_LOCK,
  BASIN_NOT_RECORDED,
  BASIN_REFUSED,
  NAMES_NOW,
} from './namesFixtures';
import type { NamesItem } from './namesModel';

/**
 * Board 4.2 and the states a name conflict can be in — every fact recorded, the facts not
 * recorded until the next campaign (what dev shows first), decided and locked, every verb refused —
 * at the board's inspector width in both modes. The real frame; the head map a still.
 */
const meta = {
  title: 'Admin/Corpus/Handlers/Names',
  parameters: { layout: 'fullscreen' },
  globals: { surface: 'admin' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

function Names({
  item,
  locked = null,
  map = true,
  onDecide = async () => true,
}: {
  item: NamesItem;
  locked?: DecidedState | null;
  map?: boolean;
  onDecide?: (lever: unknown) => Promise<boolean>;
}) {
  return (
    <StoryPane now={NAMES_NOW}>
      {(pane) => (
        <NamesInspector
          item={item}
          locked={locked}
          now={NAMES_NOW}
          map={
            map ? (
              <StillMap state={BASIN_MAP} height={NAMES_MAP_SIZE} width={NAMES_MAP_SIZE} square />
            ) : null
          }
          bodyLink={<a href="/admin/body/wbbasin?tab=names">Open in Body</a>}
          onDecide={onDecide}
          pending={null}
          pane={pane}
          timeZone={STORY_ZONE}
        />
      )}
    </StoryPane>
  );
}

const decide = fn(async (_lever: unknown) => true);

const bar = (q: HTMLElement) =>
  [...q.querySelectorAll<HTMLElement>('[role="toolbar"]')].find(
    (t) => t.closest('[data-slot="action-bar-measure"]') === null,
  );

/** 4.2 as the board draws it, every fact recorded; the pick opens on the shown name (D307). */
export const FactsPresent: Story = {
  render: () => pair(() => <Names item={BASIN} />),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      const s = within(q);
      await expect(s.getByText('All four agree it is one body')).toBeVisible();
      await expect(s.getByText('3 reports · 1 landmark')).toBeVisible();
      await expect(s.getByText('Taylor Pond · Gulf Island Pond')).toBeVisible();
      await expect(s.getByText('USGS Geographic Names, via NHD and 3DHP')).toBeVisible();
      await expect(s.getByText('14 other bodies carry it')).toBeVisible();
      await expect(s.getByRole('radio', { name: 'The Basin' })).toBeChecked();
      await expect(s.getByRole('button', { name: /Keep “The Basin”/ })).toBeVisible();
      await expect(s.queryByText('Suggested')).toBeNull();
      // The map sits beside the body's facts at the board's width; nothing scrolls sideways.
      const map = must(q.querySelector<HTMLElement>('[data-slot="names-map"]'));
      const line = must(q.querySelector<HTMLElement>('[data-slot="names-body-line"]'));
      const pane = must(q.querySelector<HTMLElement>('[data-pane="inspector"]'));
      await waitFor(() => {
        expect(map.getBoundingClientRect().left).toBeGreaterThan(line.getBoundingClientRect().left);
        expect(map.getBoundingClientRect().top).toBeLessThan(line.getBoundingClientRect().bottom);
        expect(pane.scrollWidth).toBeLessThanOrEqual(pane.clientWidth);
      });
    }
  },
};

/** Picking the other name renames the bar's button and the sections under it; ⏎ applies it. */
export const PickTheOther: Story = {
  render: () => pair(() => <Names item={BASIN} onDecide={decide} />),
  play: async ({ canvasElement }) => {
    decide.mockClear();
    const q = must(quads(canvasElement)[0]);
    const s = within(q);
    await userEvent.click(s.getByRole('radio', { name: 'Lake Auburn' }));
    await expect(s.getByRole('button', { name: /Display “Lake Auburn” instead/ })).toBeVisible();
    await expect(s.getByText('Once Lake Auburn shows')).toBeVisible();
    await expect(s.getByText('The Basin, still found by search')).toBeVisible();
    await userEvent.click(s.getByRole('button', { name: /Display “Lake Auburn” instead/ }));
    await expect(decide).toHaveBeenCalledWith(
      expect.objectContaining({ verb: 'pickName', pick: 'Lake Auburn' }),
    );
  },
};

/** What dev shows first: each fact the campaign hasn't recorded says so, never a guess. */
export const NotRecorded: Story = {
  render: () => pair(() => <Names item={BASIN_NOT_RECORDED} map={false} />),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      const s = within(q);
      // Catalogs and Queued: two facts not recorded; no agreement is claimed.
      await expect(s.getAllByText('Not recorded until the next campaign')).toHaveLength(2);
      await expect(s.queryByText(/agree it is one body/)).toBeNull();
      // Neighbors: the geometry facts not computed yet, never read as none.
      await expect(s.getByText('Not computed yet')).toBeVisible();
      await expect(s.queryByText('None on file')).toBeNull();
      // Each spelling wears its one catalog, written out with no “via”.
      await expect(s.getByText('USGS Geographic Names')).toBeVisible();
      await expect(s.getByText('OpenStreetMap')).toBeVisible();
      await expect(q.querySelector('[data-slot="names-map"]')?.childElementCount).toBe(0);
      await expect(s.getByRole('button', { name: /Keep “The Basin”/ })).toBeVisible();
    }
  },
};

/** Decided by another staff member: the lock, no bar, the names read only. */
export const DecidedAndLocked: Story = {
  render: () => pair(() => <Names item={BASIN_DECIDED} locked={BASIN_LOCK} />),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      const s = within(q);
      await expect(bar(q)).toBeUndefined();
      await expect(must(s.getAllByText(/Kate Donovan/)[0])).toBeVisible();
      for (const r of s.getAllByRole('radio')) await expect(r).not.toBeChecked();
    }
  },
};

/** Every verb refused: no bar, the refusal said once in the body. */
export const Refused: Story = {
  render: () => pair(() => <Names item={BASIN_REFUSED} />),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      const s = within(q);
      await expect(bar(q)).toBeUndefined();
      await expect(
        s.getByText('The Basin was merged into another body since this was asked.'),
      ).toBeVisible();
      for (const r of s.getAllByRole('radio'))
        await expect(r).toHaveAttribute('aria-disabled', 'true');
    }
  },
};

/** Settled before and asked again because a catalog's spelling changed (D305). */
export const AskedAgain: Story = {
  render: () => pair(() => <Names item={BASIN_ASKED_AGAIN} />),
  play: async ({ canvasElement }) => {
    const s = within(must(quads(canvasElement)[0]));
    await expect(
      s.getByText(
        /Asked again: Kate Donovan settled it on .* \(kept\), and a catalog’s spelling has changed since\./,
      ),
    ).toBeVisible();
  },
};
