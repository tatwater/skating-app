import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { must } from '@/components/kit/storyKit';
import type { DecidedState } from '../../../inspector/InspectorFrame';
import {
  BOARD_PANE,
  GROTON_MAP,
  pair,
  quads,
  STORY_ZONE,
  StillMap,
  StoryPane,
} from '../CorpusInspectorStory';
import { CLASSES_MAP_HEIGHT, ClassesInspector } from './ClassesInspector';
import {
  CLASSES_NOW,
  GROTON,
  GROTON_DECIDED,
  GROTON_LOCK,
  GROTON_MIXED,
  GROTON_NOT_RECORDED,
  GROTON_REFUSED,
} from './classesFixtures';
import type { ClassesItem } from './classesModel';

/**
 * Board 4.3 and the states a class conflict can be in — every claim recorded, the claims not
 * recorded until the next campaign (what dev shows first), decided and locked, every verb refused
 * — at the board's inspector width in both modes. The real frame; the map band a still.
 */
const meta = {
  title: 'Admin/Corpus/Handlers/Classes',
  parameters: { layout: 'fullscreen' },
  globals: { surface: 'admin' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const WIDTH = BOARD_PANE.width;

function Classes({
  item,
  locked = null,
  map = true,
  onDecide = async () => true,
}: {
  item: ClassesItem;
  locked?: DecidedState | null;
  map?: boolean;
  onDecide?: (lever: unknown) => Promise<boolean>;
}) {
  return (
    <StoryPane now={CLASSES_NOW} width={WIDTH}>
      {(pane) => (
        <ClassesInspector
          item={item}
          locked={locked}
          now={CLASSES_NOW}
          map={
            map ? <StillMap state={GROTON_MAP} height={CLASSES_MAP_HEIGHT} width={WIDTH} /> : null
          }
          bodyLink={<a href="/admin/body/wbgroton?tab=names">Open in Body</a>}
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

/** 4.3 as the board draws it: the ladder with NHD and OSM's marks, Wetland suggested and picked. */
export const FactsPresent: Story = {
  render: () => pair(() => <Classes item={GROTON} />),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      const s = within(q);
      await expect(s.getByRole('radio', { name: 'Wetland' })).toBeChecked();
      await expect(s.getByRole('button', { name: /Set as Wetland/ })).toBeVisible();
      await expect(s.getByText('SwampMarsh')).toBeVisible();
      await expect(
        s.getByText('water=pond', { selector: '[data-slot="rung-mark"] *' }),
      ).toBeVisible();
      await expect(s.getByText('Wetland · fcode=46600 · 7 ac')).toBeVisible();
      await expect(s.getByText('None in any catalog')).toBeVisible();
      // The nearest body, how far its middle lies and which way.
      await expect(s.getByText('Osmore Pond · 1.1 mi north', { selector: 'dd' })).toBeVisible();
      // Only the refusal's lead words are bright: one lead on the ladder, Wetland's.
      const leads = [...q.querySelectorAll<HTMLElement>('[data-slot="rung-lead"]')];
      await expect(leads.map((b) => b.textContent)).toEqual(['Refused by the size rules']);
      await expect(must(leads[0]).closest('[data-slot="rung-consequence"]')).toHaveTextContent(
        'Refused by the size rules next campaign, as unnamed wetland under 50 ac',
      );
      const pane = must(q.querySelector<HTMLElement>('[data-pane="inspector"]'));
      await waitFor(() => expect(pane.scrollWidth).toBeLessThanOrEqual(pane.clientWidth));
    }
  },
};

/** Picking the class now turns the button into a keep; ⏎ on the pane applies the pick. */
export const PickTheClassNow: Story = {
  render: () => pair(() => <Classes item={GROTON} onDecide={decide} />),
  play: async ({ canvasElement }) => {
    decide.mockClear();
    const q = must(quads(canvasElement)[0]);
    const s = within(q);
    await userEvent.click(s.getByRole('radio', { name: 'Lake or pond' }));
    const keep = s.getByRole('button', { name: /Keep as Lake or pond/ });
    await expect(keep).toBeVisible();
    await userEvent.click(keep);
    await expect(decide).toHaveBeenCalledWith(
      expect.objectContaining({ verb: 'keepClass', bodyClass: 'lakePond' }),
    );
  },
};

/** What dev shows first: no catalog columns, the catalogs not recorded, the class now picked. */
export const NotRecorded: Story = {
  render: () => pair(() => <Classes item={GROTON_NOT_RECORDED} map={false} />),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      const s = within(q);
      await expect(
        q.querySelectorAll('[data-slot="rung-mark"], [data-slot="rung-silent"]'),
      ).toHaveLength(0);
      await expect(s.getAllByText('Not recorded until the next campaign')).toHaveLength(1);
      // Nearest: the geometry facts not computed yet, never read as none.
      await expect(s.getByText('Not computed yet')).toBeVisible();
      await expect(s.getByRole('radio', { name: 'Lake or pond' })).toBeChecked();
      await expect(s.getByRole('button', { name: /Keep as Lake or pond/ })).toBeVisible();
    }
  },
};

/** Decided by another staff member: the lock, no bar, the ladder read only. */
export const DecidedAndLocked: Story = {
  render: () => pair(() => <Classes item={GROTON_DECIDED} locked={GROTON_LOCK} />),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      const s = within(q);
      await expect(bar(q)).toBeUndefined();
      await expect(must(s.getAllByText(/Kate Donovan/)[0])).toBeVisible();
      for (const r of s.getAllByRole('radio')) await expect(r).not.toBeChecked();
    }
  },
};

/** Every verb refused: no bar, the refusal said once. */
export const Refused: Story = {
  render: () => pair(() => <Classes item={GROTON_REFUSED} />),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      const s = within(q);
      await expect(bar(q)).toBeUndefined();
      await expect(
        s.getByText('This body was removed from the corpus since this was asked.'),
      ).toBeVisible();
    }
  },
};

/** A depth on file, and one catalog's claim stored before its code and area were. */
export const Mixed: Story = {
  render: () => pair(() => <Classes item={GROTON_MIXED} />),
  play: async ({ canvasElement }) => {
    const s = within(must(quads(canvasElement)[0]));
    await expect(s.getByText('2.4 m max · a state survey')).toBeVisible();
    await expect(
      s.getByText('Wetland · its code and area not recorded until the next campaign'),
    ).toBeVisible();
  },
};
