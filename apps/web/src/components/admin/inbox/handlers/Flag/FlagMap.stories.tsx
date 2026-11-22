import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, waitFor } from 'storybook/test';

import { must } from '@/components/kit/storyKit';
import { InboxMapStill } from '../../map/InboxMap';
import { ItemMapView } from '../../map/ItemMap';
import { ALERT_MAP, EMPTY_MAP, SAFETY_MAP } from '../../map/itemMapFixtures';
import { FlagBoard } from './flagBoard';
import { ALERT_ITEM, HAZARD_AUTO_ITEM, SAFETY_ITEM } from './flagFixtures';
import type { FlagItem } from './flagTypes';

/**
 * **The flag handler's map slot, filled.** In the app the slot holds `ItemMap` (on `inbox.itemMap`);
 * here `ItemMapView` draws the same scene over fixture answers, on the still. A report in the Safety
 * lane wears the red reticle; a report in Content flags is the bright asked mark; a hazard sits at its
 * point; an alert boxes its launch. An answer with nothing to draw collapses the slot — no column, no
 * rule. Each at the boards' inspector width (788 px: the map beside the subject) and at 360 px (the
 * map under it).
 */
const meta = {
  title: 'Admin/Inbox/Flag handler/Map',
  globals: { surface: 'admin', mode: 'dark' },
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

type Answer = Parameters<typeof ItemMapView>[0]['state'];

const CONTENT_REPORT: FlagItem = { ...SAFETY_ITEM, lane: 'contentFlags', facet: 'reports' };

/** The handler over fixtures, its map slot holding the item map over one fixture answer. */
function Filled({ item, answer, width }: { item: FlagItem; answer: Answer; width: number }) {
  return (
    <div data-width={width} style={{ width }}>
      <FlagBoard
        item={item}
        onWrite={fn(async () => true)}
        mapSlot={
          <ItemMapView
            item={item}
            state={answer}
            renderMap={(view) => <InboxMapStill view={view} width={width > 720 ? 280 : width} />}
          />
        }
      />
    </div>
  );
}

const both = (item: FlagItem, answer: Answer) => (
  <div className="flex flex-col gap-(--space-6)">
    <Filled item={item} answer={answer} width={788} />
    <Filled item={item} answer={answer} width={360} />
  </div>
);

const each = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('[data-width]')];
const mapSlotOf = (root: HTMLElement) =>
  must(root.querySelector<HTMLElement>('[data-slot="flag-map"]'));
const subjectOf = (root: HTMLElement) =>
  must(root.querySelector<HTMLElement>('[data-slot="flag-subject"]'));

/**
 * At 788 the map sits beside the subject; at 360 under it, full width. Read until the layout
 * settles: a measure taken before the fonts land is a fallback's.
 */
async function expectPlaced(root: HTMLElement) {
  for (const box of each(root)) {
    await waitFor(() => {
      const subject = subjectOf(box).getBoundingClientRect();
      const map = mapSlotOf(box).getBoundingClientRect();
      expect(map.height).toBeGreaterThan(0);
      if (box.dataset.width === '788') {
        expect(map.left).toBeGreaterThan(subject.left + subject.width / 2);
      } else {
        expect(map.width).toBeCloseTo(subject.width, 0);
      }
    });
  }
}

/** Board 2.1: a report in the Safety lane — the hazard-red reticle at its point. */
export const SafetyReport: Story = {
  render: () => both(SAFETY_ITEM, { map: SAFETY_MAP, pending: false }),
  play: async ({ canvasElement }) => {
    for (const box of each(canvasElement)) {
      const mark = must(mapSlotOf(box).querySelector<HTMLElement>('[data-mark="reticle"]'));
      await expect(mark.querySelector('[data-slot="reticle-mark"]')).toHaveAttribute(
        'data-tone',
        'bad',
      );
    }
    await expectPlaced(canvasElement);
  },
};

/** A report in Content flags: the same point, the bright asked mark — red is the Safety lane's. */
export const ContentReport: Story = {
  render: () => both(CONTENT_REPORT, { map: SAFETY_MAP, pending: false }),
  play: async ({ canvasElement }) => {
    for (const box of each(canvasElement)) {
      // The same reticle mark in the bright ink: an asked point, not the safety red.
      const red = mapSlotOf(box).querySelector('[data-slot="reticle-mark"][data-tone="bad"]');
      await expect(red).toBeNull();
      await expect(mapSlotOf(box).querySelector('[data-mark]')).not.toBeNull();
    }
    await expectPlaced(canvasElement);
  },
};

/** A hazard the app flagged (its "never existed"): its point, in the Safety lane's red. */
export const Hazard: Story = {
  render: () => both(HAZARD_AUTO_ITEM, { map: SAFETY_MAP, pending: false }),
  play: async ({ canvasElement }) => {
    for (const box of each(canvasElement)) {
      await expect(mapSlotOf(box).querySelector('[data-mark="reticle"]')).not.toBeNull();
    }
    await expectPlaced(canvasElement);
  },
};

/** Board 2.6: a flag on an access alert — the map beside the skater's card, the launch drawn. */
export const Alert: Story = {
  render: () => both(ALERT_ITEM, { map: ALERT_MAP, pending: false }),
  play: async ({ canvasElement }) => {
    for (const box of each(canvasElement)) {
      await expect(mapSlotOf(box).querySelector('svg')).not.toBeNull();
    }
    await expectPlaced(canvasElement);
  },
};

/**
 * An answer with nothing to draw: the item map renders nothing, and the subject row leaves no empty
 * column or rule behind — the subject takes the row's whole width.
 */
export const EmptyAnswerCollapses: Story = {
  render: () => both(SAFETY_ITEM, { map: EMPTY_MAP('flag'), pending: false }),
  play: async ({ canvasElement }) => {
    for (const box of each(canvasElement)) {
      const slot = mapSlotOf(box);
      await expect(slot).toBeEmptyDOMElement();
      await expect(getComputedStyle(slot).display).toBe('none');
      const subject = subjectOf(box);
      const content = must(subject.firstElementChild as HTMLElement | null);
      await waitFor(() =>
        expect(content.getBoundingClientRect().width).toBeCloseTo(
          subject.getBoundingClientRect().width,
          0,
        ),
      );
    }
  },
};
