import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { Dialog, DialogContent, DialogTitle } from '@/components/kit/dialog';
import { SkaterPair } from '../storySupport';
import { DayCalendar } from './DayCalendar';
import { LeaveDialog, SectionMeter } from './ReportSheet';
import { dayStartOf } from './reportCalendar';
import { SheetPanel } from './SheetPanel';
import { SheetContainerProvider } from './sheetSlots';
import { WhichLakeCards } from './WhichLakeCards';

/**
 * The New report sheet's parts (row 5): Which lake? (5.2/5.3), a question folded and open (5.1),
 * the section meter refused (5.23), the day's calendar (5.6/5.7), and Leave without posting (5.31).
 * The sheet itself is connected (Convex, the store); its states are `ReportSheet.test.tsx`'s.
 */
const meta = {
  title: 'Skater/New report',
  globals: { surface: 'skater', mode: 'light' },
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

// Saturday 16 January 2027, 11:52 AM in New Hampshire — the boards' "today".
const NOW = Date.UTC(2027, 0, 16, 16, 52);
const NH = 'America/New_York';

function Search() {
  return (
    <div className="border-0 border-b border-solid border-line2 py-(--space-2) text-row text-fg3">
      Or find a lake by name
    </div>
  );
}

/** 5.2 / 5.3: the cards take about two thirds of the pane, the search right under them. */
export const WhichLake: Story = {
  render: () => (
    <SkaterPair height="42rem">
      {() => (
        <div className="flex h-full">
          <WhichLakeCards
            ordinal={1}
            gpxEnabled={false}
            photosBusy={false}
            onPhotos={fn()}
            search={<Search />}
          />
        </div>
      )}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    const quad = canvasElement.querySelector<HTMLElement>('[data-mode="dark"]');
    await expect(quad).not.toBeNull();
    const q = within(quad as HTMLElement);
    await expect(q.getByRole('heading', { name: 'Which lake?' })).toBeVisible();
    await expect(q.getAllByText('Coming soon')).toHaveLength(2);
    // Square cards (only pressables round), and the search directly under them.
    const card = q.getByRole('region', { name: 'From your photos' });
    await expect(getComputedStyle(card).borderRadius).toBe('0px');
    const grid = card.parentElement as HTMLElement;
    const pane = grid.parentElement as HTMLElement;
    const share = grid.getBoundingClientRect().height / pane.getBoundingClientRect().height;
    await expect(share).toBeGreaterThan(0.55);
    await expect(share).toBeLessThan(0.75);
    // The keyboard path: Photos is reachable by Tab.
    await userEvent.tab();
    await expect(document.activeElement?.getAttribute('data-attr')).toBe('which-lake-photos');
  },
};

/** The GPX card with its flag on: the flow mounts in the drop zone (the second half's). */
export const WhichLakeGpxOn: Story = {
  render: () => (
    <SkaterPair height="42rem">
      {() => (
        <div className="flex h-full">
          <WhichLakeCards
            ordinal={2}
            gpxEnabled
            photosBusy={false}
            onPhotos={fn()}
            search={<Search />}
          />
        </div>
      )}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    const q = within(canvasElement.querySelector('[data-mode="light"]') as HTMLElement);
    await expect(q.getByText('Report 2')).toBeVisible();
    await expect(q.getAllByText('Coming soon')).toHaveLength(1);
  },
};

function Question() {
  const [collapsed, setCollapsed] = useState(true);
  return (
    <div className="w-[29.25rem] px-(--space-6) pt-(--space-5)">
      <SheetPanel
        id="section-snow"
        label="Snow"
        summary="Patches · slowed me"
        collapsed={collapsed}
        onToggle={() => setCollapsed((c) => !c)}
      >
        <p className="m-0 text-row text-fg1">None · Patches · Lanes through it · Mostly</p>
      </SheetPanel>
      <SheetPanel label="How was it?" summary="" collapsed={false} onToggle={fn()} gap>
        <p className="m-0 text-row text-fg1">Great · Good · Fair · Poor</p>
      </SheetPanel>
    </div>
  );
}

/** 5.1 / 5.23: a folded question shows its answer on one line; a refused one says Needed. */
export const Questions: Story = {
  render: () => <SkaterPair height="16rem">{() => <Question />}</SkaterPair>,
  play: async ({ canvasElement }) => {
    const q = within(canvasElement.querySelector('[data-mode="dark"]') as HTMLElement);
    const snow = q.getByRole('button', { name: /^Snow/ });
    await expect(snow).toHaveAttribute('aria-expanded', 'false');
    await expect(snow).toHaveTextContent('Patches · slowed me');
    await expect(q.getByText('Needed')).toBeVisible();
    // The keyboard path: fold and unfold from the row.
    snow.focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(snow).toHaveAttribute('aria-expanded', 'true'));
    await userEvent.keyboard(' ');
    await waitFor(() => expect(snow).toHaveAttribute('aria-expanded', 'false'));
  },
};

/** 5.23: the meter counts what is answered and, refused, what it still needs — never "ready". */
export const MeterRefused: Story = {
  render: () => (
    <SkaterPair height="6rem">
      {() => (
        <div className="flex items-center gap-(--space-6) p-(--space-6)">
          <SectionMeter answered={6} needed={0} />
          <SectionMeter answered={3} needed={2} />
        </div>
      )}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    const q = within(canvasElement.querySelector('[data-mode="dark"]') as HTMLElement);
    await expect(q.getByRole('img', { name: '3 of 10 questions answered' })).toBeVisible();
    await expect(canvasElement.textContent ?? '').not.toMatch(/ready/i);
  },
};

function CalendarInSheet({ onClose }: { onClose: () => void }) {
  const [day, setDay] = useState(dayStartOf(NOW, NH));
  const [el, setEl] = useState<HTMLElement | null>(null);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent ref={setEl} size="viewer">
        <DialogTitle>New report</DialogTitle>
        <SheetContainerProvider value={el}>
          <div className="p-(--space-6)">
            <DayCalendar
              dayStartMs={day}
              nowMs={NOW}
              timeZone={NH}
              onPick={(d) => setDay(d.startMs)}
            />
          </div>
        </SheetContainerProvider>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 5.6 / 5.7: the day's calendar, two rows with the last 7 days live — and one Esc per screen: the
 * open calendar takes the first Esc, the sheet the next.
 */
const sheetClosed = fn();
const leaveKept = fn();
const leaveLeft = fn();

export const DayCalendarEscOrder: Story = {
  render: () => <CalendarInSheet onClose={sheetClosed} />,
  play: async ({ canvasElement }) => {
    sheetClosed.mockClear();
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(body.getByRole('button', { name: /Today · Sat, Jan 16/ }));
    const days = await body.findByRole('group', { name: 'Which day was it?' });
    const cells = within(days).getAllByRole('button');
    await expect(cells).toHaveLength(14);
    await expect(cells.filter((c) => !(c as HTMLButtonElement).disabled)).toHaveLength(8);
    await userEvent.keyboard('{Escape}');
    await waitFor(() =>
      expect(body.queryByRole('group', { name: 'Which day was it?' })).not.toBeInTheDocument(),
    );
    await expect(sheetClosed).not.toHaveBeenCalled();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(sheetClosed).toHaveBeenCalled());
  },
};

/** 5.31: Leave without posting? — Keep writing is the default; Esc keeps writing. */
export const LeaveWithoutPosting: Story = {
  render: () => <LeaveDialog open sent={false} onKeep={leaveKept} onLeave={leaveLeft} />,
  play: async ({ canvasElement }) => {
    leaveKept.mockClear();
    leaveLeft.mockClear();
    const body = within(canvasElement.ownerDocument.body);
    await expect(await body.findByText('Leave without posting?')).toBeVisible();
    await expect(body.getByText('What you wrote here will be gone.')).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(leaveKept).toHaveBeenCalled());
    await expect(leaveLeft).not.toHaveBeenCalled();
  },
};
