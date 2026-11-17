import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import fc from 'fast-check';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { MIN_MARK } from '@/components/kit/day-strips';
import { UNAVAILABLE } from '@/components/kit/unavailable-button';
import { stubJsdomAnimations } from '../jsdomStubs';
import { HazardsTabView, type HazardsTabViewProps } from './HazardsTabView';
import {
  BODY_NOW,
  dailyFrom,
  FEB_ARCHIVED,
  FEB_HAZARDS,
  FEB_NOW,
  MASCOMA_FEATURE_ROWS,
  MASCOMA_WINTERS,
  SEASON,
  WATCH_OPENED,
} from './hazardsFixtures';
import { seasonOfLit } from './hazardsMap';
import {
  archivedRows,
  axisIndex,
  dayWords,
  hazardRows,
  wintersFrom,
  winterWindow,
} from './hazardsModel';

const base: HazardsTabViewProps = {
  season: SEASON,
  currentSeason: SEASON,
  onSeasonChange: vi.fn(),
  bodyName: 'Mascoma',
  watchOpenedAt: WATCH_OPENED,
  hazards: [],
  archived: [],
  features: MASCOMA_FEATURE_ROWS,
  winters: MASCOMA_WINTERS,
  patternsWaiting: { count: 2, capped: false },
  onOpenRecurrence: vi.fn(),
  onDemote: vi.fn(async () => true),
  onRetry: vi.fn(),
  onMarkHazard: vi.fn<() => void>(),
  onAddFeature: vi.fn<() => void>(),
  onEditShape: vi.fn<(id: string) => void>(),
  lit: null,
  onLitChange: vi.fn(),
};

beforeAll(stubJsdomAnimations);

const FEB = {
  hazards: hazardRows(FEB_HAZARDS, FEB_NOW),
  archived: archivedRows(FEB_ARCHIVED),
};

describe('HazardsTabView — the default board', () => {
  it('says nothing was marked, never that nothing is there', () => {
    render(<HazardsTabView {...base} />);
    const onLake = screen.getByRole('region', { name: 'On the lake' });
    expect(within(onLake).getByText('0')).toBeVisible();
    expect(within(onLake).getByText('No hazard reports yet')).toBeVisible();
    expect(
      within(onLake).getByText(
        'There are no hazard reports on record for Mascoma since the watch opened 3 Oct 2026. No reports is not a reading of the ice.',
      ),
    ).toBeVisible();
    // The two winters: this one bare, last one's record — its archived hazards unknown, not gone.
    expect(
      within(onLake).getByRole('img', {
        name: /^2026–27: No hazard reports; 2025–26: \d+ days with hazard reports, 8 first reports with no recorded end, \d+ with some unknown$/,
      }),
    ).toBeVisible();
    expect(within(onLake).getByText('Today: No hazard reports')).toBeVisible();
    // Last winter beside this one is marked from its own read, under the caption.
    expect(document.querySelectorAll('[data-slot="day-strip-mark"]').length).toBeGreaterThan(0);
    expect(document.querySelector('[data-slot="day-strips-caption"]')).not.toBeNull();
    expect(
      within(onLake).getByText(
        '2025–26: 8 archived reports have no recorded end. Each is marked on the day it was first reported; from then on, every day counts them as unknown: each hazard may still have been on the lake.',
      ),
    ).toBeVisible();
  });

  it('without the watch’s date, says this winter instead; the strips hold their place loading', () => {
    render(<HazardsTabView {...base} watchOpenedAt={null} winters={undefined} />);
    expect(
      screen.getByText(/There are no hazard reports on record for Mascoma this winter\./),
    ).toBeVisible();
    expect(screen.queryByRole('img', { name: /2026–27/ })).toBeNull();
    expect(document.querySelector('[data-slot="hazards-winters-loading"]')).not.toBeNull();
  });

  it('draws the known features with their tools, the promotion count and Mark a hazard', async () => {
    const onEditShape = vi.fn();
    const onOpenRecurrence = vi.fn();
    render(
      <HazardsTabView {...base} onEditShape={onEditShape} onOpenRecurrence={onOpenRecurrence} />,
    );
    const known = screen.getByRole('region', { name: 'Known features' });
    expect(
      within(known)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      'Spring / currentMascoma River inletPoint, 60 m · From a pin, 21 Jan 2026Edit shapeDemote',
      'Bridge narrowsShaker BridgeLine, 40 m band · Drawn 18 Nov 2025Edit shapeDemote',
    ]);
    await userEvent.click(
      within(known).getAllByRole('button', { name: 'Edit shape' })[0] as HTMLElement,
    );
    expect(onEditShape).toHaveBeenCalledWith('f-spring');
    expect(screen.getByText('2 patterns on Mascoma wait in the pre-ice pass')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: /Recurrence/ }));
    expect(onOpenRecurrence).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Mark a hazard/ })).toBeVisible();
    expect(screen.getByRole('button', { name: /Add a feature/ })).toBeVisible();
    expect(document.querySelectorAll('[data-slot="feature-glyph"] rect').length).toBeGreaterThan(0);
  });

  it('draws no tool without its writer', () => {
    render(
      <HazardsTabView
        {...base}
        onDemote={undefined}
        onMarkHazard={undefined}
        onAddFeature={undefined}
        onEditShape={undefined}
        patternsWaiting={null}
      />,
    );
    expect(
      screen.queryByRole('button', { name: /Demote|Edit shape|Mark a hazard|Add a feature/ }),
    ).toBeNull();
    expect(screen.queryByText('Promotion')).toBeNull();
  });

  it('demoting asks a reason first, and waits until there is one', async () => {
    const onDemote = vi.fn(async () => true);
    render(<HazardsTabView {...base} onDemote={onDemote} />);
    await userEvent.click(screen.getAllByRole('button', { name: 'Demote' })[1] as HTMLElement);
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/Bridge narrows, Shaker Bridge\./)).toBeVisible();
    const confirm = within(dialog).getByRole('button', { name: /Demote/ });
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dialog).getByRole('textbox'), 'The bridge was replaced');
    await userEvent.click(confirm);
    await userEvent.click(within(dialog).getByRole('button', { name: /again/ }));
    expect(onDemote).toHaveBeenCalledWith('f-narrows', 'The bridge was replaced');
  });

  it('a sent reason is held while its demotion is out — never typed into and then thrown away', async () => {
    const answers: ((landed: boolean) => void)[] = [];
    const onDemote = vi.fn(() => new Promise<boolean>((resolve) => answers.push(resolve)));
    render(<HazardsTabView {...base} onDemote={onDemote} />);
    await userEvent.click(screen.getAllByRole('button', { name: 'Demote' })[1] as HTMLElement);
    const dialog = await screen.findByRole('alertdialog');
    const field = within(dialog).getByRole('textbox');
    await userEvent.type(field, 'The bridge was replaced');
    await userEvent.click(within(dialog).getByRole('button', { name: /Demote/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: /again/ }));
    // Out: the reason it sent is what the field holds, and it takes no more.
    expect(field).toHaveAttribute('readonly');
    await userEvent.type(field, ' last spring');
    expect(field).toHaveValue('The bridge was replaced');
    // Refused: the field is the moderator's again, the reason whole.
    await act(async () => answers.shift()?.(false));
    expect(field).not.toHaveAttribute('readonly');
    await userEvent.type(field, ' last spring');
    expect(field).toHaveValue('The bridge was replaced last spring');
  });

  it('a demotion on its way can’t be dismissed, so its late answer never closes one opened since', async () => {
    let land: () => void = () => {};
    const onDemote = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          land = () => resolve(true);
        }),
    );
    render(<HazardsTabView {...base} onDemote={onDemote} />);
    await userEvent.click(screen.getAllByRole('button', { name: 'Demote' })[1] as HTMLElement);
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.type(within(dialog).getByRole('textbox'), 'The bridge was replaced');
    await userEvent.click(within(dialog).getByRole('button', { name: /Demote/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: /again/ }));
    await userEvent.keyboard('{Escape}');
    await userEvent.click(within(dialog).getByRole('button', { name: /Cancel/ }));
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(within(dialog).getByRole('textbox')).toHaveValue('The bridge was replaced');
    land();
    await vi.waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(onDemote).toHaveBeenCalledTimes(1);
  });

  it('canceling a demotion closes the dialog and demotes nothing', async () => {
    const onDemote = vi.fn(async () => true);
    render(<HazardsTabView {...base} onDemote={onDemote} />);
    await userEvent.click(screen.getAllByRole('button', { name: 'Demote' })[0] as HTMLElement);
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: /Cancel/ }));
    await vi.waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(onDemote).not.toHaveBeenCalled();
  });

  /** A refusal is its toast's (D268): the dialog stays open over its reason, with nothing printed. */
  it.each([
    ['refused', async () => false],
    [
      'a sender that threw',
      async () => {
        throw new Error('x');
      },
    ],
  ])('a demotion %s keeps the dialog and its reason, and prints nothing', async (_, answer) => {
    const onDemote = vi.fn(answer);
    render(<HazardsTabView {...base} onDemote={onDemote} />);
    await userEvent.click(screen.getAllByRole('button', { name: 'Demote' })[0] as HTMLElement);
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.type(within(dialog).getByRole('textbox'), 'Gone since the dam');
    await userEvent.click(within(dialog).getByRole('button', { name: /Demote/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: /again/ }));
    await vi.waitFor(() => expect(onDemote).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(within(dialog).getByRole('textbox')).not.toHaveAttribute('readonly'),
    );
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(within(dialog).getByRole('textbox')).toHaveValue('Gone since the dam');
    expect(within(dialog).queryByRole('alert')).toBeNull();
  });

  it('a feature’s glyph lights it on the map', async () => {
    const onLitChange = vi.fn();
    render(<HazardsTabView {...base} onLitChange={onLitChange} />);
    await userEvent.click(screen.getByRole('button', { name: 'Show Spring / current on the map' }));
    expect(onLitChange).toHaveBeenCalledWith('feature:f-spring');
  });

  it('in a past winter, lighting a feature and clearing it both stay in that winter', async () => {
    const onLitChange = vi.fn();
    const { rerender } = render(
      <HazardsTabView {...base} season={SEASON - 1} onLitChange={onLitChange} />,
    );
    const glyph = () => screen.getByRole('button', { name: 'Show Spring / current on the map' });
    await userEvent.click(glyph());
    const litAddress = `feature:${SEASON - 1}.f-spring`;
    expect(onLitChange).toHaveBeenLastCalledWith(litAddress);
    expect(seasonOfLit(litAddress, SEASON)).toBe(SEASON - 1);
    rerender(
      <HazardsTabView {...base} season={SEASON - 1} lit={litAddress} onLitChange={onLitChange} />,
    );
    await userEvent.click(glyph());
    expect(onLitChange).toHaveBeenLastCalledWith(`winter:${SEASON - 1}`);
  });

  it('picks the winter from the bar or from Earlier', async () => {
    const onSeasonChange = vi.fn();
    render(<HazardsTabView {...base} onSeasonChange={onSeasonChange} />);
    const bar = screen.getByRole('group', { name: 'Winter' });
    expect(
      within(bar)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['2026–27', '2025–26', '2024–25']);
    await userEvent.click(within(bar).getByRole('button', { name: '2025–26' }));
    expect(onSeasonChange).toHaveBeenLastCalledWith(2025);
    await userEvent.click(screen.getByRole('button', { name: /Earlier/ }));
    await userEvent.click(await screen.findByRole('menuitem', { name: '2022–23' }));
    expect(onSeasonChange).toHaveBeenLastCalledWith(2022);
  });

  it('holds each section’s place while it loads, and claims nothing', () => {
    render(
      <HazardsTabView
        {...base}
        hazards={undefined}
        features={undefined}
        patternsWaiting={undefined}
      />,
    );
    expect(screen.getByRole('region', { name: 'On the lake' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
    expect(screen.queryByText(/No hazard reports/)).toBeNull();
    expect(screen.queryByText(/pre-ice pass/)).toBeNull();
  });

  it('says nothing was marked only once the archived read has landed', () => {
    const { rerender } = render(<HazardsTabView {...base} archived={undefined} />);
    expect(screen.queryByText('No hazard reports yet')).toBeNull();
    rerender(<HazardsTabView {...base} archived="error" />);
    expect(screen.queryByText('No hazard reports yet')).toBeNull();
    expect(screen.getByText('The archived hazards couldn’t be read')).toBeVisible();
  });

  it('a winter with no open report says how many were archived, and lists them open', () => {
    render(<HazardsTabView {...base} archived={FEB.archived} />);
    expect(screen.queryByText('No hazard reports yet')).toBeNull();
    expect(screen.getByText('No open reports · 2 archived')).toBeVisible();
    expect(
      screen.getByText(
        '2 hazard reports on Mascoma since the watch opened 3 Oct 2026, each archived by skaters’ votes. An archived report has no recorded end, so the hazard may still have been on the lake. No open report is not a reading of the ice.',
      ),
    ).toBeVisible();
    expect(screen.getAllByText(/Last seen/)).toHaveLength(2);
  });

  it('a listed winter that turns quiet opens its archived group, though it was closed', () => {
    const { rerender } = render(
      <HazardsTabView {...base} hazards={FEB.hazards} archived={FEB.archived} />,
    );
    expect(screen.queryAllByText(/Last seen/)).toHaveLength(0);
    rerender(<HazardsTabView {...base} hazards={[]} archived={FEB.archived} />);
    expect(screen.getAllByText(/Last seen/)).toHaveLength(2);
  });

  it('a past winter with one archived report words it singly', () => {
    render(<HazardsTabView {...base} season={SEASON - 1} archived={FEB.archived.slice(0, 1)} />);
    expect(
      screen.getByText(/^1 hazard report on Mascoma in 2025–26, archived by skaters’ votes\./),
    ).toBeVisible();
  });
});

describe('HazardsTabView — reads that failed', () => {
  it('each says so in its place with Try again, and none reads as empty', async () => {
    const onRetry = vi.fn();
    render(
      <HazardsTabView
        {...base}
        hazards="error"
        features="error"
        patternsWaiting="error"
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText('The hazards on the lake couldn’t be read')).toBeVisible();
    expect(screen.getByText('The known features couldn’t be read')).toBeVisible();
    expect(screen.getByText('The pre-ice pass couldn’t be read')).toBeVisible();
    expect(screen.queryByText(/No hazard reports|archived by skaters/)).toBeNull();
    const again = screen.getAllByRole('button', { name: 'Try again' });
    expect(again).toHaveLength(3);
    await userEvent.click(again[0] as HTMLElement);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('holds every note as Trying again… while its reads are tried again', async () => {
    const onRetry = vi.fn();
    render(
      <HazardsTabView
        {...base}
        hazards="error"
        features="error"
        patternsWaiting="error"
        onRetry={onRetry}
        retryPending
      />,
    );
    const pending = screen.getAllByRole('button', { name: 'Trying again…' });
    expect(pending).toHaveLength(3);
    await userEvent.click(pending[0] as HTMLElement);
    expect(onRetry).not.toHaveBeenCalled();
    // Still the failure's words — never a count, never clear.
    expect(screen.queryByText(/No hazard reports|archived by skaters/)).toBeNull();
  });

  it('a failed day-by-day count says so; the list still stands', () => {
    render(<HazardsTabView {...base} {...FEB} winters="error" />);
    expect(screen.getByText('The winter’s day-by-day count couldn’t be read')).toBeVisible();
    expect(screen.getByText('Black Point to Wood Island')).toBeVisible();
  });

  it('a failed archived read inside a list says so in its group', async () => {
    render(<HazardsTabView {...base} hazards={FEB.hazards} archived="error" />);
    await userEvent.click(screen.getByRole('button', { name: /Archived this winter/ }));
    expect(await screen.findByText('The archived hazards couldn’t be read')).toBeVisible();
  });
});

describe('HazardsTabView — the winters, a day at a time', () => {
  it('before 1 October a new season is an honestly empty record from 1 July, today said', () => {
    const now = new Date(2026, 7, 20, 12, 0).getTime();
    const winters = wintersFrom(
      [
        {
          season: SEASON,
          days: [],
          unknownEnds: 0,
          hazards: [],
          capped: false,
          watchOpensOn: null,
        },
      ],
      now,
    );
    render(<HazardsTabView {...base} watchOpenedAt={null} winters={winters ?? undefined} />);
    expect(screen.queryByText(/The record for 2026–27 begins/)).toBeNull();
    expect(screen.getByText('Today: No hazard reports')).toBeVisible();
  });

  it('a count that stopped short is stated in words, and today reads as a floor', () => {
    // A current winter with nothing on the list (all archived), so today's line is drawn.
    const start = winterWindow(SEASON).start;
    const winters = wintersFrom(
      [
        {
          season: SEASON,
          days: [{ at: start + 2 * 86_400_000, count: 4, unknown: 0 }],
          unknownEnds: 0,
          hazards: [],
          capped: true,
          watchOpensOn: null,
        },
      ],
      start + 2 * 86_400_000 + 3_600_000,
    );
    render(<HazardsTabView {...base} archived={FEB.archived} winters={winters ?? undefined} />);
    expect(screen.getByText('Today: At least 4 reported on the lake')).toBeVisible();
    expect(
      screen.getByText(
        'The count stopped short of every hazard reported; each day is at least what it shows.',
      ),
    ).toBeVisible();
  });

  it('a past winter marks each archived hazard once, under its caption, never fewer than the count (fast-check)', () => {
    const season = SEASON - 1;
    const { start, days } = winterWindow(season);
    const DAY_MS = 86_400_000;
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            day: fc.integer({ min: 0, max: days - 1 }),
            hour: fc.integer({ min: 0, max: 23 }),
            active: fc.boolean(),
          }),
          { maxLength: 14 },
        ),
        fc.boolean(),
        (entries, capped) => {
          const hazards = entries.map((e) => ({
            first: start + e.day * DAY_MS + e.hour * 3_600_000,
            active: e.active,
          }));
          const read = dailyFrom(season, hazards, BODY_NOW, { capped });
          const winters = wintersFrom([read], BODY_NOW);
          // The tab at its lightest (a quiet past winter: the strip and its notes, no list, no
          // features), so each run renders what it checks and little else. The day-by-day
          // arithmetic is property-tested without rendering in `hazardsModel.test.ts`; this proves
          // the strip draws it.
          const { container } = render(
            <HazardsTabView
              {...base}
              season={season}
              hazards={[]}
              archived={[]}
              features={[]}
              patternsWaiting={null}
              winters={winters ?? undefined}
            />,
          );
          const line = winters?.lines[0];
          if (line === undefined) throw new Error('no strip');
          // One pass over the drawn days, not a query per day of the winter.
          const byDay = new Map(
            [...container.querySelectorAll<SVGGElement>('[data-slot="day-strip-day"]')].map(
              (el) => [Number(el.dataset.day), el],
            ),
          );
          const g = (i: number) => byDay.get(i) ?? null;
          const marksOn = (el: SVGGElement | null) =>
            [
              ...(el?.querySelectorAll<SVGRectElement>('[data-slot="day-strip-mark"]') ?? []),
            ].reduce((n, b) => n + Number(b.dataset.count ?? 1), 0);
          // Each hazard with no recorded end: exactly one mark, on its first-report day.
          const expected = new Map<number, number>();
          for (const e of entries) {
            // An active hazard is bars; one reported on the season's last day is a bar too.
            if (e.active || e.day + 1 >= days) continue;
            const at = axisIndex(e.day, season);
            expected.set(at, (expected.get(at) ?? 0) + 1);
          }
          let drawn = 0;
          line.days.forEach((d, i) => {
            const el = g(i);
            const marks = marksOn(el);
            drawn += marks;
            expect(marks).toBe(expected.get(i) ?? 0);
            if (d === null) return;
            // No day draws fewer known hazards than the server's count.
            const known = Number(el?.dataset.known ?? 0) + marks;
            expect(known).toBeGreaterThanOrEqual(d.count);
            // A day with anything to say keeps its words, unknown included — never a tower.
            if (d.count + d.unknown + d.reported > 0) {
              const title = el?.querySelector('title')?.textContent ?? '';
              expect(title).toBe(dayWords(d, capped));
              if (d.unknown > 0) expect(title).toContain(`${d.unknown} unknown`);
              if (d.reported > 0) expect(title).toContain('first reported this day');
              expect(title).not.toMatch(/\bended\b/i);
            }
          });
          expect(container.querySelectorAll('[data-slot="day-strip-unknown"]')).toHaveLength(0);
          // The caption is there whenever a mark is, and only then.
          expect(container.querySelector('[data-slot="day-strips-caption"]') !== null).toBe(
            drawn > 0,
          );
          if (entries.some((e) => !e.active)) {
            expect(container.querySelector('[data-slot="hazards-unknown-ends"]')).not.toBeNull();
          }
          cleanup();
        },
      ),
      // Each run renders the tab; the arithmetic's breadth is the model test's.
      {
        // The day-by-day arithmetic is fuzzed without rendering (`hazardsModel.test.ts`); here a few
        // renders, and two pinned: a capped winter, and two hazards first reported on one day.
        numRuns: 3,
        examples: [
          [
            Array.from({ length: 8 }, (_, i) => ({ day: 20 + i * 3, hour: 12, active: false })),
            true,
          ],
          [
            [
              { day: 40, hour: 2, active: false },
              { day: 40, hour: 22, active: false },
            ],
            false,
          ],
        ],
      },
    );
  });

  it('a mark’s bar and blocks keep the strip’s one step, never thinner than a mark can be seen', () => {
    const season = SEASON - 1;
    const { start } = winterWindow(season);
    const at = (d: number) => start + d * 86_400_000 + 3_600_000;
    const read = dailyFrom(
      season,
      [
        { first: at(3), active: true },
        { first: at(3), active: true },
        { first: at(3), active: false },
        { first: at(9), active: false },
      ],
      BODY_NOW,
    );
    const { container } = render(
      <HazardsTabView
        {...base}
        season={season}
        hazards={FEB.hazards}
        winters={wintersFrom([read], BODY_NOW) ?? undefined}
      />,
    );
    const day3 = container.querySelector('[data-slot="day-strip-day"][data-day="3"]');
    const bar = Number(day3?.querySelector('[data-slot="day-strip-bar"]')?.getAttribute('height'));
    const block = Number(
      day3?.querySelector('[data-slot="day-strip-mark"]')?.getAttribute('height'),
    );
    // Two open hazards' bar, one archived hazard's mark on the same step.
    expect(day3?.getAttribute('data-known')).toBe('2');
    expect(day3?.getAttribute('data-marks')).toBe('1');
    expect(bar).toBeGreaterThanOrEqual(MIN_MARK);
    expect(block).toBeCloseTo(((bar / 2) * 2) / 3, 6);
    // The archived hazard's later days carry no mark: the open hazards' bar goes on, and words.
    const day10 = container.querySelector('[data-slot="day-strip-day"][data-day="10"]');
    expect(day10?.querySelector('[data-slot="day-strip-mark"]')).toBeNull();
    expect(
      day10?.querySelector('[data-slot="day-strip-bar"]')?.getAttribute('height'),
    ).toBeTruthy();
    expect(
      screen.getByText(/A bright mark is the day a hazard with no recorded end/),
    ).toBeVisible();
  });

  it('says every archived report is marked, today’s included, on the read’s word — and a read without it counts today’s without a mark yet', () => {
    const season = SEASON;
    const { start } = winterWindow(season);
    const now = start + 120 * 86_400_000 + 15 * 3_600_000;
    const hazards = [
      { first: start + 4 * 86_400_000, active: false },
      { first: now - 3_600_000, active: false },
    ];
    const noteOf = (read: ReturnType<typeof dailyFrom>, at: number) => {
      const { container, unmount } = render(
        <HazardsTabView
          {...base}
          hazards={FEB.hazards}
          winters={wintersFrom([read], at) ?? undefined}
        />,
      );
      const text = container.querySelector('[data-slot="hazards-unknown-ends"]')?.textContent;
      unmount();
      return text ?? '';
    };
    // The read says each hazard is archived (B01-3n): both are marked, the one reported today too.
    const told = noteOf(dailyFrom(season, hazards, now), now);
    expect(told).toContain('2 archived reports have no recorded end');
    expect(told).toMatch(/Each is marked on the day it was first reported/);
    // Never read as ended or gone: every day after counts them as unknown.
    expect(told).toContain('may still have been on the lake');
    expect(told).not.toMatch(/\b(ended|gone|clear)\b/i);
    // A read from before the server said it: today's is counted without a mark until the day after.
    const legacy = noteOf(dailyFrom(season, hazards, now, { legacy: true }), now);
    expect(legacy).toContain('2 archived reports have no recorded end');
    expect(legacy).toContain(
      '1 is marked on the day first reported, and the rest counted that day without a mark',
    );
    // Once both are a day behind, each is marked either way.
    const later = now + 86_400_000;
    expect(noteOf(dailyFrom(season, hazards, later, { legacy: true }), later)).toMatch(
      /Each is marked on the day it was first reported/,
    );
  });
});

describe('HazardsTabView — tools not built yet', () => {
  it('draws Mark a hazard, Add a feature and Edit shape, each saying it is not available yet', () => {
    render(
      <HazardsTabView
        {...base}
        onMarkHazard={UNAVAILABLE}
        onAddFeature={UNAVAILABLE}
        onEditShape={UNAVAILABLE}
      />,
    );
    for (const name of [/Mark a hazard/, /Add a feature/]) {
      expect(screen.getByRole('button', { name })).toHaveAttribute('aria-disabled', 'true');
    }
    for (const b of screen.getAllByRole('button', { name: 'Edit shape' })) {
      expect(b).toHaveAttribute('data-unavailable');
    }
  });

  it('their keys act only while the pane has focus: the built ones run, the unbuilt ones say so', async () => {
    const onMarkHazard = vi.fn<() => void>();
    const onAddFeature = vi.fn<() => void>();
    const { rerender } = render(
      <HazardsTabView {...base} onMarkHazard={onMarkHazard} onAddFeature={onAddFeature} />,
    );
    act(() => screen.getByRole('button', { name: '2026–27' }).focus());
    await userEvent.keyboard('m');
    await userEvent.keyboard('f');
    expect(onMarkHazard).toHaveBeenCalledTimes(1);
    expect(onAddFeature).toHaveBeenCalledTimes(1);
    rerender(<HazardsTabView {...base} onMarkHazard={UNAVAILABLE} onAddFeature={UNAVAILABLE} />);
    act(() => screen.getByRole('button', { name: '2026–27' }).focus());
    await userEvent.keyboard('m');
    await userEvent.keyboard('f');
    expect(onMarkHazard).toHaveBeenCalledTimes(1);
    expect(onAddFeature).toHaveBeenCalledTimes(1);
  });

  it('a past winter draws none of them', () => {
    render(
      <HazardsTabView
        {...base}
        season={SEASON - 1}
        onMarkHazard={UNAVAILABLE}
        onAddFeature={UNAVAILABLE}
        onEditShape={UNAVAILABLE}
      />,
    );
    expect(
      screen.queryByRole('button', { name: /Mark a hazard|Add a feature|Edit shape/ }),
    ).toBeNull();
  });
});

describe('HazardsTabView — a list, and a past winter', () => {
  it('lists every hazard with its state in words, stale and unconfirmed included', () => {
    render(<HazardsTabView {...base} {...FEB} />);
    const rows = screen
      .getAllByRole('button', { pressed: false })
      .filter((b) => b.dataset.slot === 'hazard-row');
    expect(rows.map((r) => r.getAttribute('data-state'))).toEqual([
      'fresh',
      'aging',
      'fresh',
      'stale',
      'unconfirmed',
    ]);
    expect(rows[1]).toHaveTextContent('Wet / working crack · aging');
    expect(
      within(rows[2] as HTMLElement).getByRole('img', {
        name: '1 skater voted it gone; 2 archive it',
      }),
    ).toBeVisible();
    // Over a list, the winter on screen alone — not last winter beside it. The strip and the list
    // cover the same span (the season, through today), so today's words stand over the list too.
    expect(screen.getByRole('img', { name: /^2026–27: [^;]+$/ })).toBeVisible();
    // The groups are closed, their counts on their heads; the known features fold into one.
    expect(screen.getByRole('button', { name: /Archived this winter/ })).toHaveTextContent('2');
    expect(screen.queryByRole('region', { name: 'Known features' })).toBeNull();
  });

  it('a row lights its hazard; pressing it again lets go', async () => {
    const onLitChange = vi.fn();
    const { rerender } = render(<HazardsTabView {...base} {...FEB} onLitChange={onLitChange} />);
    const ridge = screen.getByText('Black Point to Wood Island').closest('button') as HTMLElement;
    await userEvent.click(ridge);
    expect(onLitChange).toHaveBeenLastCalledWith('hazard:h-ridge');
    rerender(<HazardsTabView {...base} {...FEB} lit="hazard:h-ridge" onLitChange={onLitChange} />);
    expect(ridge).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(ridge);
    expect(onLitChange).toHaveBeenLastCalledWith(null);
  });

  it('opens the archived group: where, what, and when anyone last saw it', async () => {
    render(<HazardsTabView {...base} {...FEB} />);
    await userEvent.click(screen.getByRole('button', { name: /Archived this winter/ }));
    const rows = await screen.findAllByText(/Last seen/);
    expect(rows.map((r) => r.textContent)).toEqual(['Last seen 9 Feb', 'Last seen 26 Jan']);
  });

  it('a past winter is read-only: the solid badge, no tools, past tense', () => {
    render(<HazardsTabView {...base} season={SEASON - 1} hazards={[]} />);
    expect(screen.getByText('Read-only')).toHaveAttribute('data-slot', 'badge');
    expect(screen.getByText('No hazard reports on record')).toBeVisible();
    expect(
      screen.getByText(/There are no hazard reports on record for Mascoma in 2025–26\./),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: /Demote|Edit shape|Mark a hazard|Add a feature/ }),
    ).toBeNull();
  });

  it('a past winter’s list names its groups by that winter', () => {
    render(<HazardsTabView {...base} season={SEASON - 1} {...FEB} />);
    expect(screen.getByRole('button', { name: /Archived in 2025–26/ })).toBeVisible();
    expect(BODY_NOW).toBeGreaterThan(FEB_NOW);
  });
});

describe('HazardsTabView — each failure note is a region mounted before its words', () => {
  // Each read's note: its words, the props that fail it, and the state that brings it back.
  const notes: [string, Partial<HazardsTabViewProps>][] = [
    ['The hazards on the lake couldn’t be read', { hazards: 'error' }],
    ['The pre-ice pass couldn’t be read', { patternsWaiting: 'error' }],
    ['The archived hazards couldn’t be read', { archived: 'error' }],
    ['The winter’s day-by-day count couldn’t be read', { winters: 'error' }],
    ['The known features couldn’t be read', { features: 'error' }],
  ];

  it.each(notes)(
    '“%s” is announced as it comes, and focus stays when it goes',
    async (words, failed) => {
      const { rerender } = render(<HazardsTabView {...base} {...failed} />);
      const region = screen.getByText(words).closest('[role="status"]') as HTMLElement;
      await userEvent.click(within(region).getByRole('button', { name: 'Try again' }));
      rerender(<HazardsTabView {...base} />);
      // The same region, still in the page, empty — and focus kept on it, never dropped to the page.
      expect(region).toBeInTheDocument();
      expect(region).toHaveTextContent('');
      expect(region).toHaveFocus();
      cleanup();
      // Mounted before any failure: the region is there, empty, while the read is on its way.
      render(
        <HazardsTabView
          {...base}
          {...Object.fromEntries(Object.keys(failed).map((k) => [k, undefined]))}
        />,
      );
      expect(screen.queryByText(words)).toBeNull();
    },
  );
});
