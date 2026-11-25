import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubJsdomAnimations } from '../jsdomStubs';

const convex = vi.hoisted(() => ({
  results: new Map<string, unknown>(),
  calls: [] as { name: string; args: unknown }[],
  mutations: new Map<string, ReturnType<typeof vi.fn>>(),
}));
vi.mock('convex/react', async () => {
  const { getFunctionName } = await import('convex/server');
  return {
    useQueries: (
      queries: Record<string, { query: Parameters<typeof getFunctionName>[0]; args: unknown }>,
    ) =>
      Object.fromEntries(
        Object.entries(queries).map(([key, { query, args }]) => {
          const name = getFunctionName(query);
          convex.calls.push({ name, args });
          const r = convex.results.get(name);
          return [key, typeof r === 'function' ? r(args) : r];
        }),
      ),
    useMutation: (ref: Parameters<typeof getFunctionName>[0]) => {
      const name = getFunctionName(ref);
      const made = convex.mutations.get(name) ?? vi.fn(async () => null);
      convex.mutations.set(name, made);
      return made;
    },
  };
});
const role = vi.hoisted(() => ({ caps: new Set<string>() }));
vi.mock('@/lib/useRole', () => ({ useRole: () => ({ can: (c: string) => role.caps.has(c) }) }));
const undo = vi.hoisted(() => ({ announce: vi.fn(async () => {}) }));
vi.mock('@/components/admin/shell/undo', () => ({ useUndo: () => undo }));
const toasts = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock('@/components/kit/toast', async (original) => ({
  ...(await original<typeof import('@/components/kit/toast')>()),
  toast: (t: Record<string, unknown>) => toasts.push(t),
}));
const nav = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => nav.navigate }));

import { seasonOf } from '@skating/core';
import { ConvexError } from 'convex/values';
import { resetConsoleReads } from '@/components/admin/reads/consoleReads';
import { BodyTabHost } from '../../frame/BodyConsoleRoute';
import { HAZARDS_TAB, HazardsTab } from './HazardsTab';
import { dailyFrom, FEB_ARCHIVED, FEB_HAZARDS, MASCOMA_FEATURES } from './hazardsFixtures';
import { axisIndex, dailyClock, winterWindow } from './hazardsModel';
import { CROSSING_CLAIM } from './hazardsWords';

const BODY = 'k1';
/** The line under the strips for the clock's own day (each test that reads it pins the clock). */
const dayLine = () => document.querySelector('[data-slot="hazards-today"]')?.textContent;

beforeAll(stubJsdomAnimations);

beforeEach(() => {
  convex.results.clear();
  convex.mutations.clear();
  convex.calls = [];
  undo.announce.mockClear();
  nav.navigate.mockClear();
  role.caps = new Set(['body.read', 'corpus.preIce']);
  convex.results.set('waterBodies:get', {
    available: true,
    body: { _id: BODY, name: 'Mascoma Lake' },
  });
  convex.results.set('bodyFeatures:listForBody', MASCOMA_FEATURES);
  convex.results.set('hazards:listForBody', () => []);
  resetConsoleReads();
  // Whatever winter the clock is in: this one bare, the last with one archived hazard in it.
  convex.results.set('bodyConsole:dailyHazards', (args: { season: number; now: number }) =>
    args.season === seasonOf(Date.now())
      ? dailyFrom(args.season, [], args.now)
      : dailyFrom(
          args.season,
          [{ first: winterWindow(args.season).start + 60 * 86_400_000, active: false }],
          args.now,
        ),
  );
  // The server's own count (`isWaitingPattern`), never a figure taken from a capped list.
  convex.results.set('recurrence:waitingCountForBody', { count: 2, capped: false });
});

describe('HazardsTab', () => {
  it('holds its place until the body lands, and says so when it can’t be read', () => {
    convex.results.delete('waterBodies:get');
    const { container, rerender } = render(<HazardsTab bodyId={BODY} />);
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.queryByText(/No hazard reports/)).toBeNull();
    convex.results.set('waterBodies:get', new Error('boom'));
    rerender(<HazardsTab bodyId={BODY} />);
    expect(screen.getByText('This body couldn’t be read')).toBeVisible();
  });

  it('reads this season’s hazards, the archived, the features and the waiting patterns', () => {
    render(<HazardsTab bodyId={BODY} />);
    expect(screen.getByText('No hazard reports yet')).toBeVisible();
    expect(
      screen.getByText(/There are no hazard reports on record for Mascoma this winter\./),
    ).toBeVisible();
    expect(screen.getByText('2 patterns on Mascoma wait in the pre-ice pass')).toBeVisible();
    const seasons = convex.calls
      .filter((c) => c.name === 'hazards:listForBody')
      .map((c) => (c.args as { season: number }).season);
    expect(new Set(seasons).size).toBe(1);
    // Hazards are marked from the skater apps alone (D299); the feature tools wait on B01-6b.
    expect(screen.queryByRole('button', { name: /Mark a hazard/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Add a feature/ })).toHaveAttribute(
      'data-unavailable',
    );
  });

  it('reads this winter’s day-by-day count beside last winter’s, against an hour’s clock', () => {
    render(<HazardsTab bodyId={BODY} />);
    const daily = convex.calls
      .filter((c) => c.name === 'bodyConsole:dailyHazards')
      .map((c) => c.args as { season: number; now: number });
    const current = daily[0]?.season ?? Number.NaN;
    expect(new Set(daily.map((d) => d.season))).toEqual(new Set([current, current - 1]));
    expect(daily.every((d) => d.now % 86_400_000 === 0)).toBe(true);
    // This winter's clock is today's start (the server counts its whole day); last winter's, its end.
    const hour = Math.floor(Date.now() / 3_600_000) * 3_600_000;
    const thisWinter = daily.find((d) => d.season === current);
    expect(thisWinter?.now).toBe(dailyClock(current, hour));
    const { start, days } = winterWindow(current - 1);
    expect(daily.find((d) => d.season === current - 1)?.now).toBe(start + days * 86_400_000);
    expect(screen.getByRole('img', { name: /some unknown/ })).toBeVisible();
  });

  it('clears a held winter when the body changes — never parked for a return to it', () => {
    let answers = true;
    convex.results.set('bodyConsole:dailyHazards', (args: { season: number; now: number }) =>
      answers ? dailyFrom(args.season, [], args.now) : undefined,
    );
    const { rerender } = render(<HazardsTab bodyId={BODY} />);
    expect(document.querySelector('[data-slot="hazards-winters"]')).not.toBeNull();
    answers = false;
    rerender(<HazardsTab bodyId="k2" />);
    rerender(<HazardsTab bodyId={BODY} />);
    // Back on the first body with its read on its way: a skeleton, not the answer from before.
    expect(document.querySelector('[data-slot="hazards-winters"]')).toBeNull();
    expect(document.querySelector('[data-slot="hazards-winters-loading"]')).not.toBeNull();
  });

  it('keeps the winter it has through the day’s turn, never back to a skeleton', () => {
    // Mid-winter, so this winter's strip is drawn; the minute before midnight UTC.
    vi.useFakeTimers({ now: Date.UTC(2027, 0, 16, 23, 59), toFake: ['Date', 'setInterval'] });
    try {
      const first = dailyClock(2026, Date.UTC(2027, 0, 16, 23));
      convex.results.set('bodyConsole:dailyHazards', (args: { season: number; now: number }) =>
        // The next day's read hasn't answered yet; the first day's has.
        args.season === 2026 && args.now !== first
          ? undefined
          : dailyFrom(
              args.season,
              [{ first: winterWindow(args.season).start, active: true }],
              args.now,
            ),
      );
      render(<HazardsTab bodyId={BODY} />);
      const strips = () => screen.queryByRole('img', { name: /hazard reports/ });
      expect(strips()).not.toBeNull();
      act(() => {
        vi.advanceTimersByTime(2 * 60_000);
      });
      // A new day, a new read on its way: the winter stays drawn from the last answer.
      expect(
        convex.calls.some(
          (c) => c.name === 'bodyConsole:dailyHazards' && (c.args as { now: number }).now !== first,
        ),
      ).toBe(true);
      expect(strips()).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('across the day’s turn, a held winter never reads today as clear', () => {
    // The hour before midnight UTC: the held answer covers the old day, not the new one.
    vi.useFakeTimers({ now: Date.UTC(2027, 0, 16, 23, 59), toFake: ['Date', 'setInterval'] });
    try {
      const first = dailyClock(2026, Date.UTC(2027, 0, 16, 23));
      convex.results.set('bodyConsole:dailyHazards', (args: { season: number; now: number }) =>
        args.season === 2026 && args.now !== first
          ? undefined
          : dailyFrom(
              args.season,
              [{ first: winterWindow(args.season).start, active: true }],
              args.now,
            ),
      );
      render(<HazardsTab bodyId={BODY} />);
      expect(dayLine()).toContain('1 reported on the lake');
      act(() => {
        vi.advanceTimersByTime(2 * 60_000);
      });
      // A new day, its read on its way: the hazard still on the lake never reads as gone.
      expect(dayLine()).not.toContain('No hazard reports');
      expect(dayLine()).toContain('1 reported on the lake');
    } finally {
      vi.useRealTimers();
    }
  });

  it('after a failure, the next day’s load is a load, not the answer from before it', () => {
    vi.useFakeTimers({ now: Date.UTC(2027, 0, 16, 23, 59), toFake: ['Date', 'setInterval'] });
    try {
      const at = (h: number) => dailyClock(2026, Date.UTC(2027, 0, 16, h));
      let failing = false;
      convex.results.set('bodyConsole:dailyHazards', (args: { season: number; now: number }) => {
        if (args.season !== 2026) return dailyFrom(args.season, [], args.now);
        if (args.now === at(16) && !failing) {
          return dailyFrom(
            args.season,
            [{ first: winterWindow(2026).start, active: true }],
            at(16),
          );
        }
        return args.now === at(16) ? new Error('down') : undefined;
      });
      const { rerender } = render(<HazardsTab bodyId={BODY} />);
      expect(dayLine()).toContain('1 reported on the lake');
      failing = true;
      rerender(<HazardsTab bodyId={BODY} />);
      expect(screen.getByText('The winter’s day-by-day count couldn’t be read')).toBeVisible();
      act(() => {
        vi.advanceTimersByTime(2 * 60_000);
      });
      // The next day's read is on its way: a skeleton, never the answer from before the failure.
      expect(dayLine()).toBeUndefined();
      expect(document.querySelector('[data-slot="hazards-winters-loading"]')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('over a list, last winter’s read neither holds nor fails the strip that is drawn', () => {
    convex.results.set('hazards:listForBody', (args: { includeArchived?: boolean }) =>
      args.includeArchived ? [...FEB_HAZARDS, ...FEB_ARCHIVED] : FEB_HAZARDS,
    );
    const thisWinter = convex.results.get('bodyConsole:dailyHazards') as (args: {
      season: number;
      now: number;
    }) => unknown;
    convex.results.set('bodyConsole:dailyHazards', (args: { season: number; now: number }) =>
      args.season === seasonOf(Date.now()) ? thisWinter(args) : new Error('boom'),
    );
    render(<HazardsTab bodyId={BODY} />);
    expect(document.querySelector('[data-slot="hazards-winters"]')).not.toBeNull();
    expect(screen.queryByText('The winter’s day-by-day count couldn’t be read')).toBeNull();
  });

  it('a failed read says so in its place; Try again reads every read afresh', async () => {
    convex.results.set('hazards:listForBody', new Error('boom'));
    render(<HazardsTab bodyId={BODY} />);
    expect(screen.getByText('The hazards on the lake couldn’t be read')).toBeVisible();
    convex.results.set('hazards:listForBody', () => []);
    await userEvent.click(screen.getAllByRole('button', { name: 'Try again' })[0] as HTMLElement);
    expect(await screen.findByText('No hazard reports yet')).toBeVisible();
  });

  it('a populated winter lists its hazards over its strip, its archived ones in their group', () => {
    convex.results.set('hazards:listForBody', (args: { includeArchived?: boolean }) =>
      args.includeArchived ? [...FEB_HAZARDS, ...FEB_ARCHIVED] : FEB_HAZARDS,
    );
    render(<HazardsTab bodyId={BODY} />);
    expect(screen.getByText('Black Point to Wood Island')).toBeVisible();
    expect(screen.getByRole('button', { name: /Archived this winter/ })).toHaveTextContent('2');
    expect(document.querySelector('[data-slot="hazards-winters"]')).not.toBeNull();
  });

  it('demotes with the reason and announces it to Undo; a refusal reads in the server’s words', async () => {
    render(<HazardsTab bodyId={BODY} />);
    await userEvent.click(screen.getAllByRole('button', { name: 'Demote' })[0] as HTMLElement);
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.type(within(dialog).getByRole('textbox'), 'Not a spring');
    await userEvent.click(within(dialog).getByRole('button', { name: /Demote/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: /again/ }));
    expect(convex.mutations.get('bodyFeatures:demote')).toHaveBeenCalledWith({
      bodyFeatureId: 'f-spring',
      reason: 'Not a spring',
    });
    expect(undo.announce).toHaveBeenCalledWith({
      title: 'Known feature demoted',
      target: { targetType: 'bodyFeature', targetId: 'f-spring' },
    });
  });

  it('a refused demotion is one toast naming what failed; its dialog stays open, printing nothing', async () => {
    toasts.length = 0;
    convex.mutations.set(
      'bodyFeatures:demote',
      vi.fn(async () => {
        throw new ConvexError('Body feature not found');
      }),
    );
    render(<HazardsTab bodyId={BODY} />);
    await userEvent.click(screen.getAllByRole('button', { name: 'Demote' })[0] as HTMLElement);
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.type(within(dialog).getByRole('textbox'), 'x');
    await userEvent.click(within(dialog).getByRole('button', { name: /Demote/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: /again/ }));
    await waitFor(() =>
      expect(toasts).toEqual([
        expect.objectContaining({
          description: 'The demotion: Body feature not found',
          tone: 'bad',
          timeout: 0,
        }),
      ]),
    );
    expect(screen.getByRole('alertdialog')).toBe(dialog);
    expect(within(dialog).getByRole('textbox')).toHaveValue('x');
    expect(within(dialog).queryByRole('alert')).toBeNull();
    expect(undo.announce).not.toHaveBeenCalled();
  });

  it('a past winter reads that season, and Recurrence opens the pre-ice pass', async () => {
    render(<HazardsTab bodyId={BODY} />);
    const first = convex.calls.find((c) => c.name === 'hazards:listForBody');
    const current = (first?.args as { season: number } | undefined)?.season ?? Number.NaN;
    await userEvent.click(
      screen.getByRole('button', {
        name: `${current - 1}–${String(current % 100).padStart(2, '0')}`,
      }),
    );
    const last = convex.calls.filter((c) => c.name === 'hazards:listForBody').at(-1);
    expect(last?.args).toMatchObject({ season: current - 1 });
    expect(screen.getByText('Read-only')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: /Recurrence/ }));
    expect(nav.navigate).toHaveBeenCalledWith({ to: '/admin/recurrence' });
  });

  it('every strip is marked from its own read — last winter beside this one, and a chosen past one', async () => {
    render(<HazardsTab bodyId={BODY} />);
    // Beside this winter, last winter's archived hazard is a mark, from the day-by-day read alone.
    expect(document.querySelectorAll('[data-slot="day-strip-mark"]')).toHaveLength(1);
    expect(document.querySelector('[data-slot="day-strips-caption"]')).not.toBeNull();
    // The archived list isn't what marks come from: its failure leaves the marks standing.
    convex.results.set('hazards:listForBody', (args: { includeArchived?: boolean }) =>
      args.includeArchived ? new Error('boom') : [],
    );
    const first = convex.calls.find((c) => c.name === 'hazards:listForBody');
    const current = (first?.args as { season: number } | undefined)?.season ?? Number.NaN;
    await userEvent.click(
      screen.getByRole('button', {
        name: `${current - 1}–${String(current % 100).padStart(2, '0')}`,
      }),
    );
    const marks = document.querySelectorAll('[data-slot="day-strip-mark"]');
    expect(marks).toHaveLength(1);
    // The hazard fixture is first reported 60 days into last winter's season.
    expect(marks[0]?.closest('[data-slot="day-strip-day"]')?.getAttribute('data-day')).toBe(
      String(axisIndex(60, current - 1)),
    );
  });

  it('without the capabilities: no tools, and the queue isn’t read', () => {
    role.caps = new Set();
    render(<HazardsTab bodyId={BODY} />);
    expect(
      screen.queryByRole('button', { name: /Demote|Mark a hazard|Add a feature|Edit shape/ }),
    ).toBeNull();
    expect(screen.queryByText('Promotion')).toBeNull();
    expect(convex.calls.find((c) => c.name === 'recurrence:waitingCountForBody')).toBeUndefined();
  });

  it('a body that isn’t listed draws nothing', () => {
    convex.results.set('waterBodies:get', { available: false });
    const { container } = render(<HazardsTab bodyId={BODY} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('registers its wiring and a map whose data keeps its identity', () => {
    expect(HAZARDS_TAB.Wiring).toBe(HazardsTab);
    const hazards = [] as unknown[];
    convex.results.set('hazards:listForBody', hazards);
    const seen: unknown[] = [];
    function Probe() {
      seen.push(HAZARDS_TAB.map?.useData(BODY, null));
      return null;
    }
    const { rerender } = render(<Probe />);
    rerender(<Probe />);
    expect(seen[0]).toBeDefined();
    expect(seen[1]).toBe(seen[0]);
    const scene = HAZARDS_TAB.map?.describe(seen[0] as never, 'feature:f-spring');
    expect(scene?.lit).toBe('feature:f-spring');
    expect(scene?.items.map((i: { id: string }) => i.id)).toEqual([
      'feature:f-spring',
      'feature:f-narrows',
    ]);
    convex.results.delete('bodyFeatures:listForBody');
    rerender(<Probe />);
    expect(seen.at(-1)).toBeUndefined();
    // A failed read draws nothing of its own on the map.
    convex.results.set('bodyFeatures:listForBody', new Error('boom'));
    rerender(<Probe />);
    expect(seen.at(-1)).toBeUndefined();
  });

  describe('a switch to another body that is already read', () => {
    const OTHER = 'k2';
    const toOther = () =>
      convex.results.set('waterBodies:get', {
        available: true,
        body: { _id: OTHER, name: 'Crystal Lake' },
      });

    it('drops the open demotion and its typed reason; nothing is demoted for the next body', async () => {
      const { rerender } = render(<BodyTabHost Wiring={HazardsTab} bodyId={BODY} />);
      await userEvent.click(screen.getAllByRole('button', { name: 'Demote' })[0] as HTMLElement);
      const dialog = await screen.findByRole('alertdialog');
      await userEvent.type(within(dialog).getByRole('textbox'), 'Not a spring');
      toOther();
      rerender(<BodyTabHost Wiring={HazardsTab} bodyId={OTHER} />);
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(screen.queryByDisplayValue('Not a spring')).toBeNull();
      expect(convex.mutations.get('bodyFeatures:demote')).not.toHaveBeenCalled();
    });

    it('a write started on one body still lands after the switch, and its receipt names that body', async () => {
      let land: () => void = () => {};
      convex.mutations.set(
        'bodyFeatures:demote',
        vi.fn(
          () =>
            new Promise((resolve) => {
              land = () => resolve(null);
            }),
        ),
      );
      const { rerender } = render(
        <BodyTabHost Wiring={HazardsTab} name="Mascoma Lake" bodyId={BODY} />,
      );
      await userEvent.click(screen.getAllByRole('button', { name: 'Demote' })[0] as HTMLElement);
      const dialog = await screen.findByRole('alertdialog');
      await userEvent.type(within(dialog).getByRole('textbox'), 'Not a spring');
      await userEvent.click(within(dialog).getByRole('button', { name: /Demote/ }));
      await userEvent.click(within(dialog).getByRole('button', { name: /again/ }));
      toOther();
      rerender(<BodyTabHost Wiring={HazardsTab} name="Crystal Lake" bodyId={OTHER} />);
      land();
      await new Promise((r) => setTimeout(r, 0));
      // Pressed is committed: it lands on its own body, and its receipt says whose it was.
      expect(undo.announce).toHaveBeenCalledTimes(1);
      expect(undo.announce).toHaveBeenCalledWith(
        expect.objectContaining({ subject: 'Mascoma Lake' }),
      );
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
  });

  it('Demote, once the server answers (the feature goes inactive; the active read drops it), is gone for that feature', async () => {
    convex.mutations.set(
      'bodyFeatures:demote',
      vi.fn(async (args: { bodyFeatureId: string }) => {
        convex.results.set(
          'bodyFeatures:listForBody',
          (MASCOMA_FEATURES as { _id: string }[]).filter((f) => f._id !== args.bodyFeatureId),
        );
        return null;
      }),
    );
    const { rerender } = render(<HazardsTab bodyId={BODY} />);
    const before = screen.getAllByRole('button', { name: 'Demote' }).length;
    await userEvent.click(screen.getAllByRole('button', { name: 'Demote' })[0] as HTMLElement);
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.type(within(dialog).getByRole('textbox'), 'Not a spring');
    await userEvent.click(within(dialog).getByRole('button', { name: /Demote/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: /again/ }));
    rerender(<HazardsTab bodyId={BODY} />);
    await vi.waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'Demote' })).toHaveLength(before - 1),
    );
    expect(screen.queryByText('Mascoma River inlet')).toBeNull();
    expect(convex.mutations.get('bodyFeatures:demote')).toHaveBeenCalledTimes(1);
  });

  it('a waiting count that stopped short is said as a floor, never as whole', () => {
    convex.results.set('recurrence:waitingCountForBody', { count: 1000, capped: true });
    render(<HazardsTab bodyId={BODY} />);
    expect(
      screen.getByText(
        'At least 1,000 patterns on Mascoma wait in the pre-ice pass; the count stopped short',
      ),
    ).toBeVisible();
  });

  it('a reported crossing on a day is said on its own, and never marked as a hazard’s first report', () => {
    const now = Date.now();
    const season = seasonOf(now);
    const day = Math.floor(now / 86_400_000) * 86_400_000;
    convex.results.set('bodyConsole:dailyHazards', (args: { season: number }) =>
      args.season === season
        ? {
            season,
            days: [{ at: day, count: 0, unknown: 0, crossings: 1 }],
            unknownEnds: 0,
            hazards: [
              { firstReportedDay: day, endRecorded: false, type: 'ridge_crossing', passage: true },
            ],
            capped: false,
            watchOpensOn: null,
          }
        : {
            season: args.season,
            days: [],
            unknownEnds: 0,
            hazards: [],
            capped: false,
            watchOpensOn: null,
          },
    );
    render(<HazardsTab bodyId={BODY} />);
    const today = document.querySelector('[data-slot="hazards-today"]')?.textContent ?? '';
    expect(today).toContain('1 reported crossing');
    expect(today).not.toMatch(CROSSING_CLAIM);
    expect(
      document.querySelectorAll('[data-slot="strip-mark"], [data-slot="day-mark"]'),
    ).toHaveLength(0);
  });
});
